import { describe, expect, it } from 'vitest';
import { DEFAULT_JOLT_CONFIG, JoltDetector, type JoltEvent, type MotionSample } from '../src/sensors.js';
import { mulberry32 } from '../src/rng.js';

const G = 9.81;
type Vec = [number, number, number];

/** Gravity direction for a phone tilted `deg` degrees about its x axis (0 = lying flat). */
const tilted = (deg: number): Vec => [0, G * Math.sin((deg * Math.PI) / 180), G * Math.cos((deg * Math.PI) / 180)];

interface Scenario {
  gravity: Vec;
  hz?: number;
  seconds: number;
  noise?: number;
  /** Extra acceleration along gravity (a vertical bump) at these times: [startMs, durationMs, m/s^2]. */
  bumps?: [number, number, number][];
  /** Constant horizontal acceleration (braking / cornering) [startMs, durationMs, m/s^2] along device x. */
  horizontal?: [number, number, number][];
  seed?: number;
}

function run(s: Scenario, detector = new JoltDetector()): { jolts: JoltEvent[]; detector: JoltDetector } {
  const rng = mulberry32(s.seed ?? 1);
  const hz = s.hz ?? 60;
  const jolts: JoltEvent[] = [];
  const n = Math.round(s.seconds * hz);
  const gn = Math.hypot(...s.gravity);
  for (let i = 0; i < n; i++) {
    const t = (i * 1000) / hz;
    const a: Vec = [...s.gravity];
    for (const [start, dur, mag] of s.bumps ?? []) {
      if (t >= start && t < start + dur) for (let k = 0; k < 3; k++) a[k]! += (s.gravity[k]! / gn) * mag;
    }
    for (const [start, dur, mag] of s.horizontal ?? []) if (t >= start && t < start + dur) a[0] += mag;
    const noise = s.noise ?? 0;
    const sample: MotionSample = { t, ax: a[0] + (rng() - 0.5) * noise, ay: a[1] + (rng() - 0.5) * noise, az: a[2] + (rng() - 0.5) * noise };
    const j = detector.push(sample);
    if (j) jolts.push(j);
  }
  return { jolts, detector };
}

describe('JoltDetector', () => {
  it('detects a vertical bump regardless of how the phone is mounted', () => {
    const orientations: [string, Vec][] = [
      ['flat', [0, 0, G]],
      ['upright portrait', [0, G, 0]],
      ['landscape', [G, 0, 0]],
      ['tilted 35 degrees on a handlebar', tilted(35)],
      ['upside down', [0, 0, -G]],
    ];
    for (const [name, gravity] of orientations) {
      const { jolts } = run({ gravity, seconds: 4, noise: 0.3, bumps: [[2000, 60, 8]] });
      expect(jolts, name).toHaveLength(1);
      expect(jolts[0]!.t, name).toBeGreaterThanOrEqual(2000);
      expect(jolts[0]!.t, name).toBeLessThan(2100);
      expect(jolts[0]!.magnitude, name).toBeGreaterThan(DEFAULT_JOLT_CONFIG.thresholdMs2);
    }
  });

  it('ignores ordinary vibration noise', () => {
    const { jolts, detector } = run({ gravity: tilted(20), seconds: 20, noise: 1.2, seed: 5 });
    expect(jolts).toEqual([]);
    expect(detector.peak).toBeLessThan(DEFAULT_JOLT_CONFIG.thresholdMs2);
  });

  it('ignores sustained horizontal acceleration (braking, cornering): it is not along gravity', () => {
    const { jolts } = run({ gravity: [0, 0, G], seconds: 6, noise: 0.2, horizontal: [[1500, 2500, 5]] });
    expect(jolts).toEqual([]);
  });

  it('ignores a slow change of tilt (the gravity estimate follows it)', () => {
    const detector = new JoltDetector();
    const jolts: JoltEvent[] = [];
    for (let i = 0; i < 60 * 10; i++) {
      const g = tilted((i / 600) * 25); // 25 degrees over 10 s
      const j = detector.push({ t: (i * 1000) / 60, ax: g[0], ay: g[1], az: g[2] });
      if (j) jolts.push(j);
    }
    expect(jolts).toEqual([]);
  });

  it('reports one jolt per impact (refractory) but a second impact later is reported', () => {
    const close = run({ gravity: [0, 0, G], seconds: 5, bumps: [[2000, 50, 8], [2200, 50, 8]] });
    expect(close.jolts).toHaveLength(1);
    const apart = run({ gravity: [0, 0, G], seconds: 5, bumps: [[2000, 50, 8], [2800, 50, 8]] });
    expect(apart.jolts).toHaveLength(2);
  });

  it('ignores the first moments while the gravity estimate settles', () => {
    const { jolts } = run({ gravity: [0, 0, G], seconds: 2, bumps: [[200, 60, 9]] });
    expect(jolts).toEqual([]);
  });

  it('works at other sample rates and tolerates duplicate or out-of-order timestamps', () => {
    for (const hz of [20, 30, 100]) {
      expect(run({ gravity: [0, 0, G], hz, seconds: 4, bumps: [[2000, 60, 8]] }).jolts, `${hz} Hz`).toHaveLength(1);
    }
    const d = new JoltDetector();
    d.push({ t: 0, ax: 0, ay: 0, az: G });
    expect(d.push({ t: 0, ax: 0, ay: 0, az: G + 9 })).toBeNull(); // same timestamp
    expect(d.push({ t: -5, ax: 0, ay: 0, az: G + 9 })).toBeNull(); // went backwards
    expect(d.push({ t: 10, ax: Number.NaN, ay: 0, az: G })).toBeNull(); // garbage
  });

  it('exposes the signed vertical reading and the rolling peak for the Debug screen', () => {
    const { detector } = run({ gravity: [0, 0, G], seconds: 3, bumps: [[2000, 60, 8]] });
    expect(detector.peak).toBeGreaterThan(5); // the bump is within the last second
    const quiet = run({ gravity: [0, 0, G], seconds: 3.5, bumps: [[2000, 60, 8]] }).detector;
    expect(quiet.peak).toBeLessThan(1); // 1.5 s later it has rolled out of the window
    expect(Number.isFinite(quiet.vertical)).toBe(true);
  });

  it('honours a custom threshold', () => {
    const sensitive = new JoltDetector({ thresholdMs2: 1.5 });
    expect(run({ gravity: [0, 0, G], seconds: 4, bumps: [[2000, 60, 2.5]] }, sensitive).jolts).toHaveLength(1);
    expect(run({ gravity: [0, 0, G], seconds: 4, bumps: [[2000, 60, 2.5]] }).jolts).toHaveLength(0);
  });
});
