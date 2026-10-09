import { describe, expect, it } from 'vitest';
import { confirmationCount, demoRoute, haversineMeters, DEMO_CENTER } from '@lubak/shared';
import { Confirmer, type Confirmation } from '../src/confirmer.js';
import { buildDemoScript, DEMO_ENCOUNTERS, DEMO_FPS, DEMO_LAP_S, DEMO_SPEED_MPS, DemoGeo, DemoMotion, ReplayDetector } from '../src/demo.js';
import { Pipeline } from '../src/pipeline.js';
import { HazardStore } from '../src/store.js';
import { FakeCamera, flush } from './pipeline-harness.js';

const script = buildDemoScript();

/** The Confirmer alone, driven by the script on a virtual clock. */
function replayThroughConfirmer(laps: number): Confirmation[] {
  const detector = new ReplayDetector(script);
  const motion = new DemoMotion(script);
  motion.start();
  const confirmer = new Confirmer();
  const events: Confirmation[] = [];
  motion.onJolt((j) => events.push(...confirmer.onJolt({ t: j.t, magnitude: j.magnitude })));
  for (let t = 0; t < laps * script.lapMs; t += script.frameMs) {
    motion.tick(t); // same order as DemoSession.tick: sensors first, then the frame
    events.push(...confirmer.update(detector.detectionsAt(t), t));
  }
  return events;
}

/** The real Pipeline, driven by the script, for one phone. Returns once `laps` laps have been replayed. */
async function drive(store: HazardStore, deviceId: string, laps: number): Promise<Pipeline> {
  const camera = new FakeCamera();
  const detector = new ReplayDetector(script);
  const motion = new DemoMotion(script);
  const geo = new DemoGeo();
  motion.start();
  geo.start();
  const pipeline = new Pipeline({ camera, detector, confirmer: new Confirmer(), motion, geo, store, deviceId });
  pipeline.start();
  for (let t = 0; t < laps * script.lapMs; t += script.frameMs) {
    geo.tick(t, script.lapMs);
    motion.tick(t);
    camera.emit(t);
    await flush();
  }
  pipeline.stop();
  return pipeline;
}

describe('demo script', () => {
  it('is a deterministic 60 s lap at 8 fps', () => {
    expect(DEMO_FPS).toBe(8);
    expect(DEMO_LAP_S).toBe(60);
    expect(script.frames).toHaveLength(480);
    expect(script.lapMs).toBe(60_000);
    expect(buildDemoScript()).toEqual(script);
    expect(script.jolts.map((j) => j.t)).toEqual([...script.jolts.map((j) => j.t)].sort((a, b) => a - b));
  });

  it('puts every encounter on the right frames with in-range confidences', () => {
    for (const e of DEMO_ENCOUNTERS) {
      const first = Math.round(e.at * DEMO_FPS);
      for (let k = 0; k < e.frames; k++) {
        const hit = script.frames[first + k]!.find((d) => d.cls === e.cls);
        expect(hit, `${e.cls} at ${e.at}s frame ${k}`).toBeDefined();
        expect(Math.abs(hit!.confidence - e.confidence)).toBeLessThanOrEqual(0.031);
        expect(hit!.box.x2).toBeGreaterThan(hit!.box.x1);
      }
      expect(script.frames[first + e.frames]!.some((d) => d.cls === e.cls && Math.abs(d.confidence - e.confidence) < 0.04)).toBe(false);
    }
    expect(new Set(DEMO_ENCOUNTERS.map((e) => e.cls)).size).toBe(3); // all three classes appear
  });
});

describe('demo script through the Confirmer', () => {
  it('confirms exactly the encounters meant to confirm, and rejects the blip and the below-threshold stretch', () => {
    const events = replayThroughConfirmer(1).filter((e) => e.kind === 'confirmed');
    const expected = DEMO_ENCOUNTERS.filter((e) => e.expect === 'confirm');
    expect(events.map((e) => e.cls)).toEqual(expected.map((e) => e.cls));
    expect(events).toHaveLength(8);
    for (const [i, e] of events.entries()) {
      const enc = expected[i]!;
      expect(e.t).toBeGreaterThanOrEqual(enc.at * 1000);
      expect(e.t).toBeLessThan((enc.at + 1) * 1000);
    }
    for (const rejected of DEMO_ENCOUNTERS.filter((e) => e.expect === 'reject')) {
      expect(events.some((e) => e.t >= rejected.at * 1000 && e.t < (rejected.at + 2) * 1000)).toBe(false);
    }
  });

  it('boosts exactly the bumpy encounters (the jolt arrives after the camera confirmed them)', () => {
    const boosts = replayThroughConfirmer(1).filter((e) => e.kind === 'boost');
    const bumpy = DEMO_ENCOUNTERS.filter((e) => e.expect === 'confirm' && e.jolt);
    expect(boosts.map((e) => e.cls)).toEqual(bumpy.map((e) => e.cls));
    expect(boosts).toHaveLength(5);
    for (const b of boosts) expect(b.confidence).toBeGreaterThan(b.baseConfidence);
  });

  it('the cooldown does not swallow the first encounter of the next lap', () => {
    expect(replayThroughConfirmer(2).filter((e) => e.kind === 'confirmed')).toHaveLength(16);
  });
});

describe('scripted sensors', () => {
  it('DemoGeo drives the same stretch of the Antipolo test route every lap, about 25 km/h', () => {
    const geo = new DemoGeo();
    geo.start();
    geo.tick(0, script.lapMs);
    const start = geo.fix!;
    expect(haversineMeters(start, DEMO_CENTER)).toBeLessThan(0.01);
    geo.tick(10_000, script.lapMs);
    expect(haversineMeters(start, geo.fix!)).toBeGreaterThan(DEMO_SPEED_MPS * 10 * 0.8);
    expect(haversineMeters(start, geo.fix!)).toBeLessThan(DEMO_SPEED_MPS * 10 * 1.01);
    expect(geo.fix).toMatchObject({ accuracy: 4, speed: DEMO_SPEED_MPS });
    const lap2 = new DemoGeo();
    lap2.start();
    lap2.tick(script.lapMs + 10_000, script.lapMs);
    expect(haversineMeters(geo.fix!, lap2.fix!)).toBeLessThan(0.01);
    expect(demoRoute().length).toBeGreaterThan(5);
  });

  it('DemoGeo fixes depend only on the lap second, not on frame timing, so every phone puts a hazard in the same cell', () => {
    // Geohash cells along the demo street are ~19 m long; a fix taken "whenever a frame arrives" moves by up to 7 m
    // between phones and laps, which split one scripted hazard into two map markers instead of showing x2.
    const run = (lateMs: (i: number) => number) => {
      const geo = new DemoGeo();
      geo.start();
      const bySecond = new Map<number, string>();
      geo.onFix((f) => bySecond.set(Math.floor(f.t / 1000), `${f.lat},${f.lon}`));
      for (let i = 0; i * 125 < script.lapMs; i++) geo.tick(i * 125 + lateMs(i), script.lapMs);
      return bySecond;
    };
    const steady = run(() => 0);
    const jittery = run((i) => ((i * 37) % 11) * 10); // frames 0..100 ms late, like a busy phone
    expect(steady.size).toBe(script.lapMs / 1000);
    for (const [second, fix] of steady) expect(jittery.get(second)).toBe(fix);
  });

  it('DemoGeo emits at most one fix per second', () => {
    const geo = new DemoGeo();
    geo.start();
    let n = 0;
    geo.onFix(() => (n += 1));
    for (let t = 0; t < 5000; t += 125) geo.tick(t, script.lapMs);
    expect(n).toBe(5);
  });

  it('DemoMotion emits each scripted jolt exactly once, including across a lap wrap', () => {
    const motion = new DemoMotion(script);
    motion.start();
    const times: number[] = [];
    motion.onJolt((j) => times.push(j.t));
    for (let t = 0; t < 2 * script.lapMs; t += script.frameMs) motion.tick(t);
    expect(times).toHaveLength(2 * script.jolts.length);
    expect(times.slice(0, script.jolts.length)).toEqual(script.jolts.map((j) => j.t));
    expect(motion.status().note).toMatch(/^DEMO/);
  });

  it('ReplayDetector gives copies, so a consumer cannot corrupt the script', async () => {
    const d = new ReplayDetector(script);
    const t = DEMO_ENCOUNTERS[0]!.at * 1000;
    const a = await d.detect({} as never, t);
    a.detections[0]!.box.x1 = 99;
    const b = await d.detect({} as never, t);
    expect(b.detections[0]!.box.x1).toBeLessThan(1);
    expect(d.info()).toMatchObject({ kind: 'replay', backend: 'replay' });
  });
});

describe('demo through the real pipeline: the pitch scenario', () => {
  it('one phone records 8 hazards at fixed places along the route; replaying a lap again adds nothing', async () => {
    const store = HazardStore.inMemory();
    const p = await drive(store, 'phone-a', 1);
    const hazards = await store.getAll();
    expect(hazards).toHaveLength(8);
    expect(p.stats).toMatchObject({ confirmed: 8, boosted: 5, noFix: 0, errors: 0 });
    for (const h of hazards) {
      expect(h.deviceIds).toEqual(['phone-a']);
      expect(haversineMeters(h, DEMO_CENTER)).toBeLessThan(500);
    }
    expect(new Set(hazards.map((h) => h.id)).size).toBe(8);
    const classes = hazards.map((h) => h.cls);
    expect(classes.filter((c) => c === 'pothole')).toHaveLength(4);
    expect(classes.filter((c) => c === 'crack')).toHaveLength(2);
    expect(classes.filter((c) => c === 'flooded_road')).toHaveLength(2);

    await drive(store, 'phone-a', 1); // same phone, second lap: same places, merged
    const again = await store.getAll();
    expect(again).toHaveLength(8);
    expect(again.every((h) => confirmationCount(h) === 1)).toBe(true);
  });

  it('two phones running the demo confirm the SAME hazards, so the map shows x2', async () => {
    const store = HazardStore.inMemory();
    await drive(store, 'phone-a', 1);
    await drive(store, 'phone-b', 1);
    const hazards = await store.getAll();
    expect(hazards).toHaveLength(8);
    expect(hazards.every((h) => confirmationCount(h) === 2)).toBe(true);
    expect(hazards.every((h) => h.deviceIds.join() === 'phone-a,phone-b')).toBe(true);
  });

  it('jolt-corroborated hazards end up with a higher confidence than the camera alone gave', async () => {
    const store = HazardStore.inMemory();
    await drive(store, 'phone-a', 1);
    const hazards = await store.getAll();
    const byCls = (cls: string) => hazards.filter((h) => h.cls === cls).map((h) => h.confidence);
    // the 0.90 pothole got +0.15 from its jolt and was clamped to 1
    expect(Math.max(...byCls('pothole'))).toBe(1);
    // the un-jolted crack (0.58) was not boosted
    expect(byCls('crack').some((c) => Math.abs(c - 0.58) < 0.05)).toBe(true);
    // flooded roads are never boosted
    expect(Math.max(...byCls('flooded_road'))).toBeLessThan(0.8);
  });
});
