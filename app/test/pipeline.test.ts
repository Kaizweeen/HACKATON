import { describe, expect, it } from 'vitest';
import { encodeGeohash, haversineMeters } from '@lubak/shared';
import { Confirmer } from '../src/confirmer.js';
import { Pipeline, type PipelineEvent } from '../src/pipeline.js';
import type { GeoFix } from '../src/sensors.js';
import { HazardStore } from '../src/store.js';
import { FakeCamera, FakeGeo, FakeMotion, flush, ScriptedDetector } from './pipeline-harness.js';
import { det, FRAME_MS } from './helpers.js';

const fix = (over: Partial<GeoFix> = {}): GeoFix => ({ lat: 14.585, lon: 121.176, accuracy: 5, speed: 7, heading: 90, t: 0, ...over });

function rig(config: ConstructorParameters<typeof Pipeline>[0]['config'] = {}) {
  const camera = new FakeCamera();
  const detector = new ScriptedDetector();
  const motion = new FakeMotion();
  const geo = new FakeGeo();
  const store = HazardStore.inMemory();
  const confirmer = new Confirmer();
  const pipeline = new Pipeline({ camera, detector, confirmer, motion, geo, store, deviceId: 'dev-me', config });
  const events: PipelineEvent[] = [];
  pipeline.onEvent((e) => events.push(e));
  pipeline.start();

  /** Feed `n` frames that each contain `detections`, starting at t0. */
  const frames = async (n: number, detections: ReturnType<typeof det>[], t0 = 0): Promise<void> => {
    for (let i = 0; i < n; i++) {
      detector.queue.push(detections);
      camera.emit(t0 + i * FRAME_MS);
      await flush();
    }
  };
  return { camera, detector, motion, geo, store, pipeline, events, frames };
}

describe('Pipeline', () => {
  it('turns three consecutive detections plus a GPS fix into a stored, pending hazard', async () => {
    const r = rig();
    r.geo.fix = fix();
    await r.frames(3, [det('pothole', 0.7)]);

    const [h] = await r.store.getAll();
    expect(h).toMatchObject({ cls: 'pothole', geohash: encodeGeohash(14.585, 121.176), deviceIds: ['dev-me'] });
    expect(h!.confidence).toBeCloseTo(0.7, 10);
    expect(h!.id).toBe(`${h!.geohash}:pothole`);
    expect(await r.store.pendingCount()).toBe(1); // queued for the hub
    expect(r.events.map((e) => e.type)).toEqual(['confirmed']);
    expect(r.pipeline.stats).toMatchObject({ framesProcessed: 3, confirmed: 1, noFix: 0 });
  });

  it('records nothing for fewer than three frames', async () => {
    const r = rig();
    r.geo.fix = fix();
    await r.frames(2, [det('pothole', 0.7)]);
    expect(await r.store.getAll()).toEqual([]);
  });

  it('a jolt after the confirmation upgrades the SAME hazard (same id, higher confidence)', async () => {
    const r = rig();
    r.geo.fix = fix();
    await r.frames(3, [det('pothole', 0.6)]);
    const [before] = await r.store.getAll();

    r.motion.jolt({ t: 2 * FRAME_MS + 900, magnitude: 6.5 });
    await flush();
    const all = await r.store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(before!.id);
    expect(all[0]!.confidence).toBeCloseTo(0.75, 10);
    expect(all[0]!.lat).toBe(before!.lat);
    expect(r.events.map((e) => e.type)).toEqual(['confirmed', 'boosted']);
    expect(r.pipeline.stats.boosted).toBe(1);
  });

  it('a jolt just before the confirmation boosts it straight away', async () => {
    const r = rig();
    r.geo.fix = fix();
    r.motion.jolt({ t: 100, magnitude: 6 });
    await r.frames(3, [det('crack', 0.6)]);
    const [h] = await r.store.getAll();
    expect(h!.confidence).toBeCloseTo(0.75, 10);
    expect(r.events.map((e) => e.type)).toEqual(['confirmed']);
  });

  it('without a GPS fix the detection is reported as not recorded, not silently lost or stored at 0,0', async () => {
    const r = rig();
    await r.frames(3, [det('pothole', 0.7)]);
    expect(await r.store.getAll()).toEqual([]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'no-fix', reason: expect.stringMatching(/no GPS/) });
    expect(r.pipeline.stats.noFix).toBe(1);
  });

  it('refuses a fix that is too inaccurate or too old', async () => {
    const inaccurate = rig();
    inaccurate.geo.fix = fix({ accuracy: 120 });
    await inaccurate.frames(3, [det('pothole', 0.7)]);
    expect(inaccurate.events[0]).toMatchObject({ type: 'no-fix', reason: expect.stringMatching(/accuracy/) });

    const stale = rig();
    stale.geo.fix = fix({ t: -20_000 });
    await stale.frames(3, [det('pothole', 0.7)]);
    expect(stale.events[0]).toMatchObject({ type: 'no-fix', reason: expect.stringMatching(/stale/) });
    expect(await stale.store.getAll()).toEqual([]);
  });

  it('shifts the position ahead along the heading when a look-ahead is configured (the camera sees the road ahead)', async () => {
    const r = rig({ lookaheadM: 10 });
    r.geo.fix = fix({ heading: 90, speed: 6 }); // heading east
    await r.frames(3, [det('pothole', 0.7)]);
    const [h] = await r.store.getAll();
    expect(haversineMeters({ lat: 14.585, lon: 121.176 }, h!)).toBeCloseTo(10, 0);
    expect(h!.lon).toBeGreaterThan(121.176);
    expect(Math.abs(h!.lat - 14.585)).toBeLessThan(1e-6);

    const stationary = rig({ lookaheadM: 10 });
    stationary.geo.fix = fix({ heading: 90, speed: 0.2 });
    await stationary.frames(3, [det('pothole', 0.7)]);
    const [s] = await stationary.store.getAll();
    expect(haversineMeters({ lat: 14.585, lon: 121.176 }, s!)).toBeLessThan(0.01); // no look-ahead when barely moving
  });

  it('drops frames while the detector is busy instead of queueing a backlog', async () => {
    const r = rig();
    let release!: () => void;
    r.detector.gate = new Promise<void>((res) => (release = res));
    r.camera.emit(0);
    r.camera.emit(FRAME_MS);
    r.camera.emit(2 * FRAME_MS);
    await flush();
    expect(r.pipeline.stats).toMatchObject({ framesIn: 3, framesDropped: 2, framesProcessed: 0 });
    release();
    await flush();
    expect(r.pipeline.stats.framesProcessed).toBe(1);
    expect(r.detector.calls).toBe(1);
  });

  it('survives a detector failure: counts it, keeps going', async () => {
    const r = rig();
    r.geo.fix = fix();
    r.detector.failNext = true;
    r.camera.emit(0);
    await flush();
    expect(r.pipeline.stats).toMatchObject({ errors: 1, lastError: 'boom' });
    await r.frames(3, [det('pothole', 0.7)], FRAME_MS);
    expect(await r.store.getAll()).toHaveLength(1);
  });

  it('publishes per-frame results for the overlay, with measured timings', async () => {
    const r = rig();
    const seen: number[] = [];
    r.pipeline.onResult((res) => seen.push(res.detections.length));
    await r.frames(2, [det('crack', 0.9), det('pothole', 0.2)]);
    expect(seen).toEqual([2, 2]);
    expect(r.pipeline.stats.inferenceMsLast).toBe(3);
    expect(r.pipeline.stats.detections).toBe(4);
  });

  it('stop() detaches from the camera and the accelerometer', async () => {
    const r = rig();
    r.geo.fix = fix();
    r.pipeline.stop();
    expect(r.camera.listenerCount).toBe(0);
    await r.frames(3, [det('pothole', 0.7)]);
    expect(r.detector.calls).toBe(0);
    expect(await r.store.getAll()).toEqual([]);
  });
});
