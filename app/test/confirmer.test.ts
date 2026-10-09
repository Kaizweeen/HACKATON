import { describe, expect, it } from 'vitest';
import { Confirmer, DEFAULT_CONFIRMER_CONFIG } from '../src/confirmer.js';
import { det, FRAME_MS } from './helpers.js';

/** Feed the same detections for `n` frames starting at t0; returns every confirmation produced. */
function feed(c: Confirmer, t0: number, n: number, detections: ReturnType<typeof det>[]) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(...c.update(detections, t0 + i * FRAME_MS));
  return out;
}

describe('Confirmer: consecutive frames', () => {
  it('confirms only on the third consecutive frame above the class threshold', () => {
    const c = new Confirmer();
    expect(c.update([det('pothole', 0.7)], 0)).toEqual([]);
    expect(c.update([det('pothole', 0.7)], FRAME_MS)).toEqual([]);
    const third = c.update([det('pothole', 0.7)], 2 * FRAME_MS);
    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({ kind: 'confirmed', cls: 'pothole', boosted: false });
    expect(third[0]!.confidence).toBeCloseTo(0.7, 10);
  });

  it('one weak or missing frame resets the streak', () => {
    const c = new Confirmer();
    c.update([det('pothole', 0.7)], 0);
    c.update([det('pothole', 0.7)], FRAME_MS);
    expect(c.update([det('pothole', 0.2)], 2 * FRAME_MS)).toEqual([]); // below threshold
    expect(c.update([det('pothole', 0.7)], 3 * FRAME_MS)).toEqual([]); // streak restarted: 1
    expect(c.update([det('pothole', 0.7)], 4 * FRAME_MS)).toEqual([]); // 2
    expect(c.update([det('pothole', 0.7)], 5 * FRAME_MS)).toHaveLength(1); // 3
    const d = new Confirmer();
    d.update([det('crack', 0.6)], 0);
    d.update([], FRAME_MS); // nothing detected
    d.update([det('crack', 0.6)], 2 * FRAME_MS);
    expect(d.update([det('crack', 0.6)], 3 * FRAME_MS)).toEqual([]);
  });

  it('reports the mean confidence of the qualifying streak', () => {
    const c = new Confirmer();
    const out = [
      ...c.update([det('pothole', 0.6)], 0),
      ...c.update([det('pothole', 0.7)], FRAME_MS),
      ...c.update([det('pothole', 0.8)], 2 * FRAME_MS),
    ];
    expect(out[0]!.confidence).toBeCloseTo(0.7, 10);
  });

  it('uses a separate threshold per class', () => {
    const t = DEFAULT_CONFIRMER_CONFIG.thresholds;
    expect(t.crack).toBeLessThan(t.pothole); // the default thresholds differ, which the next two lines rely on
    const between = (t.crack + t.pothole) / 2;
    expect(feed(new Confirmer(), 0, 3, [det('crack', between)])).toHaveLength(1);
    expect(feed(new Confirmer(), 0, 3, [det('pothole', between)])).toHaveLength(0);
    expect(feed(new Confirmer(), 0, 3, [det('flooded_road', t.flooded_road - 0.01)])).toHaveLength(0);
    expect(feed(new Confirmer(), 0, 3, [det('flooded_road', t.flooded_road)])).toHaveLength(1);
  });

  it('counts a frame once per class even when the class appears several times in it', () => {
    const c = new Confirmer();
    const two = [det('pothole', 0.7), det('pothole', 0.9)];
    expect(c.update(two, 0)).toEqual([]);
    expect(c.update(two, FRAME_MS)).toEqual([]);
    expect(c.update(two, 2 * FRAME_MS)).toHaveLength(1);
  });

  it('tracks classes independently and can confirm two in the same frame', () => {
    const c = new Confirmer();
    const both = [det('pothole', 0.7), det('flooded_road', 0.8)];
    const out = feed(c, 0, 3, both);
    expect(out.map((e) => e.cls).sort()).toEqual(['flooded_road', 'pothole']);
  });

  it('forgets the streak when frames stop arriving for too long (page paused, detector stalled)', () => {
    const c = new Confirmer();
    c.update([det('pothole', 0.7)], 0);
    c.update([det('pothole', 0.7)], FRAME_MS);
    expect(c.update([det('pothole', 0.7)], FRAME_MS + 5000)).toEqual([]); // 5 s gap: not consecutive
  });

  it('honours a custom number of frames', () => {
    const c = new Confirmer({ consecutiveFrames: 5 });
    expect(feed(c, 0, 4, [det('pothole', 0.7)])).toHaveLength(0);
    expect(c.update([det('pothole', 0.7)], 4 * FRAME_MS)).toHaveLength(1);
  });
});

describe('Confirmer: cooldown', () => {
  it('does not re-report the same class for 5 seconds, then reports again', () => {
    const c = new Confirmer();
    const events = [];
    // a pothole that stays in view for 7 seconds at 8 fps
    for (let i = 0; i < 56; i++) events.push(...c.update([det('pothole', 0.7)], i * FRAME_MS));
    expect(events.map((e) => e.t)).toEqual([2 * FRAME_MS, 2 * FRAME_MS + 5000]);
  });

  it('is per class: a muted pothole does not block a crack', () => {
    const c = new Confirmer();
    feed(c, 0, 3, [det('pothole', 0.7)]);
    const out = feed(c, 3 * FRAME_MS, 3, [det('pothole', 0.7), det('crack', 0.6)]);
    expect(out.map((e) => e.cls)).toEqual(['crack']);
  });

  it('a different pothole after the cooldown is reported', () => {
    const c = new Confirmer();
    expect(feed(c, 0, 3, [det('pothole', 0.7)])).toHaveLength(1);
    c.update([], 3 * FRAME_MS); // gone
    expect(feed(c, 6000, 3, [det('pothole', 0.7)])).toHaveLength(1);
  });

  it('reset() clears streaks and cooldowns', () => {
    const c = new Confirmer();
    feed(c, 0, 3, [det('pothole', 0.7)]);
    c.reset();
    expect(feed(c, 4 * FRAME_MS, 3, [det('pothole', 0.7)])).toHaveLength(1);
  });
});

describe('Confirmer: jolt corroboration (pothole and crack only)', () => {
  const boost = DEFAULT_CONFIRMER_CONFIG.joltBoost;

  it('a jolt shortly BEFORE the confirmation boosts it immediately', () => {
    const c = new Confirmer();
    expect(c.onJolt({ t: 100, magnitude: 6 })).toEqual([]);
    const out = feed(c, 200, 3, [det('pothole', 0.6)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'confirmed', boosted: true, joltMagnitude: 6 });
    expect(out[0]!.confidence).toBeCloseTo(0.6 + boost, 10);
    expect(out[0]!.baseConfidence).toBeCloseTo(0.6, 10);
  });

  it('a jolt AFTER the confirmation (the usual case: the camera sees it first) yields a boost event for the same confirmation', () => {
    const c = new Confirmer();
    const [confirmed] = feed(c, 0, 3, [det('pothole', 0.6)]);
    expect(confirmed).toMatchObject({ kind: 'confirmed', boosted: false });
    const boosts = c.onJolt({ t: confirmed!.t + 900, magnitude: 7 });
    expect(boosts).toHaveLength(1);
    expect(boosts[0]).toMatchObject({ kind: 'boost', seq: confirmed!.seq, cls: 'pothole', boosted: true, joltMagnitude: 7 });
    expect(boosts[0]!.confidence).toBeCloseTo(0.6 + boost, 10);
    expect(c.onJolt({ t: confirmed!.t + 1000, magnitude: 7 })).toEqual([]); // one boost per confirmation
  });

  it('a jolt later than 1.5 s does not corroborate, before or after', () => {
    const c = new Confirmer();
    c.onJolt({ t: 0, magnitude: 9 });
    const [confirmed] = feed(c, 2000, 3, [det('pothole', 0.6)]); // confirmation at t = 2250: the jolt is 2.25 s old
    expect(confirmed!.boosted).toBe(false);
    expect(c.onJolt({ t: confirmed!.t + 1600, magnitude: 9 })).toEqual([]);
  });

  it('the window is inclusive at 1.5 s', () => {
    const c = new Confirmer();
    const [confirmed] = feed(c, 0, 3, [det('crack', 0.6)]);
    expect(c.onJolt({ t: confirmed!.t + 1500, magnitude: 5 })).toHaveLength(1);
  });

  it('never boosts a flooded road: water does not shake the phone', () => {
    const c = new Confirmer();
    c.onJolt({ t: 150, magnitude: 9 });
    const [confirmed] = feed(c, 200, 3, [det('flooded_road', 0.8)]);
    expect(confirmed!.boosted).toBe(false);
    expect(c.onJolt({ t: confirmed!.t + 300, magnitude: 9 })).toEqual([]);
  });

  it('clamps the boosted confidence to 1', () => {
    const c = new Confirmer();
    const [confirmed] = feed(c, 0, 3, [det('pothole', 0.95)]);
    const [b] = c.onJolt({ t: confirmed!.t + 100, magnitude: 8 });
    expect(b!.confidence).toBe(1);
  });

  it('a boost never delays or blocks the confirmation itself', () => {
    const c = new Confirmer();
    const out = feed(c, 0, 3, [det('pothole', 0.6)]);
    expect(out).toHaveLength(1); // emitted on frame 3 without waiting to see whether a jolt follows
  });
});
