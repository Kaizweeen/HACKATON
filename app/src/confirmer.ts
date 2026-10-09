/**
 * confirmer.ts: turns noisy per-frame detections into confirmed hazards.
 *
 * Rules (all numbers are tunable; the defaults are PLACEHOLDERS to be tuned on real drives, not measured values):
 *  1. A class is confirmed only after `consecutiveFrames` (3) processed frames in a row that each contain a
 *     detection of that class at or above that class's confidence threshold. One weak frame resets the streak.
 *  2. After a confirmation the same class is muted for `cooldownMs` (5 s) so one pothole is not reported 20 times.
 *  3. For pothole and crack only, a vertical jolt reported by the accelerometer within `joltWindowMs` (1.5 s) of the
 *     detection raises the confidence by `joltBoost`. The camera sees a pothole BEFORE the wheel hits it, so the jolt
 *     normally arrives after the confirmation: in that case a second event (`kind: 'boost'`, same `seq`) follows.
 *     A jolt shortly BEFORE the confirmation boosts it immediately. The boost never delays or blocks a confirmation.
 *
 * Pure state machine: no DOM, no timers, no GPS. Callers pass timestamps (any monotonic clock, as long as frames
 * and jolts use the same one), which makes it deterministic and unit-testable.
 */

import { HAZARD_CLASSES, type HazardClass } from '@lubak/shared';
import type { Box, Detection } from './detector.js';

export interface ConfirmerConfig {
  /** Consecutive qualifying frames required. */
  consecutiveFrames: number;
  /** Minimum confidence per class, chosen on the validation split (model/RESULTS.md). Re-check them on real road footage. */
  thresholds: Readonly<Record<HazardClass, number>>;
  /** Per-class mute after a confirmation. */
  cooldownMs: number;
  /** Streaks reset if two processed frames are further apart than this (page paused, detector stalled). */
  maxFrameGapMs: number;
  /** Added to the confidence when a jolt corroborates the detection (clamped to 1). */
  joltBoost: number;
  /** Jolt must fall within this window of the detection, before or after. */
  joltWindowMs: number;
  /** Classes a jolt can corroborate: a flooded road does not shake the phone. */
  joltClasses: readonly HazardClass[];
}

export const DEFAULT_CONFIRMER_CONFIG: ConfirmerConfig = {
  consecutiveFrames: 3,
  // pothole and crack: the lowest confidence with per-box precision >= 0.8 on the validation split for lubak_public_v1
  // (model/RESULTS.md; crack reaches it at the detector's own 0.25 floor). flooded_road: the model has no flood training data
  // and never outputs one; 0.5 only matters for Demo Mode and other sources.
  thresholds: { pothole: 0.4, crack: 0.25, flooded_road: 0.5 },
  cooldownMs: 5000,
  maxFrameGapMs: 1000,
  joltBoost: 0.15,
  joltWindowMs: 1500,
  joltClasses: ['pothole', 'crack'],
};

export interface JoltInput {
  t: number;
  /** Peak vertical acceleration of the jolt, m/s^2. */
  magnitude: number;
}

export interface Confirmation {
  /** 'confirmed': a new confirmation. 'boost': the same confirmation, upgraded because a jolt arrived afterwards. */
  kind: 'confirmed' | 'boost';
  /** Identifies one confirmation; a later boost carries the same seq. */
  seq: number;
  cls: HazardClass;
  /** Final confidence (boosted when `boosted`). */
  confidence: number;
  /** Confidence from the camera alone. */
  baseConfidence: number;
  boosted: boolean;
  joltMagnitude: number | null;
  /** Timestamp of the frame that completed the streak. */
  t: number;
  box: Box;
}

interface Streak {
  recent: number[];
  count: number;
  box: Box | null;
}

interface Pending {
  cls: HazardClass;
  t: number;
  base: number;
  box: Box;
}

const emptyStreak = (): Streak => ({ recent: [], count: 0, box: null });
const clamp01 = (x: number): number => (x > 1 ? 1 : x < 0 ? 0 : x);
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface ConfirmerDebug {
  streaks: Record<HazardClass, number>;
  cooldownRemainingMs: Record<HazardClass, number>;
  awaitingJolt: number;
}

export class Confirmer {
  readonly config: ConfirmerConfig;
  private streaks = new Map<HazardClass, Streak>();
  private cooldownUntil = new Map<HazardClass, number>();
  private jolts: JoltInput[] = [];
  private pending = new Map<number, Pending>();
  private lastFrameT: number | null = null;
  private seq = 0;

  constructor(config: Partial<ConfirmerConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIRMER_CONFIG,
      ...config,
      thresholds: { ...DEFAULT_CONFIRMER_CONFIG.thresholds, ...config.thresholds },
    };
    for (const cls of HAZARD_CLASSES) this.streaks.set(cls, emptyStreak());
  }

  /** Feed one processed frame. Returns the confirmations it completed (usually none). */
  update(detections: readonly Detection[], t: number): Confirmation[] {
    const c = this.config;
    if (this.lastFrameT !== null && t - this.lastFrameT > c.maxFrameGapMs) this.resetStreaks();
    this.lastFrameT = t;
    this.expire(t);

    const out: Confirmation[] = [];
    for (const cls of HAZARD_CLASSES) {
      const streak = this.streaks.get(cls)!;
      let best: Detection | null = null;
      for (const d of detections) {
        if (d.cls === cls && d.confidence >= c.thresholds[cls] && (best === null || d.confidence > best.confidence)) best = d;
      }
      if (best === null) {
        this.streaks.set(cls, emptyStreak()); // one weak or missing frame breaks the streak
        continue;
      }
      streak.count += 1;
      streak.recent.push(best.confidence);
      if (streak.recent.length > c.consecutiveFrames) streak.recent.shift();
      streak.box = best.box;

      if (streak.count < c.consecutiveFrames) continue;
      if (t < (this.cooldownUntil.get(cls) ?? -Infinity)) continue;

      this.cooldownUntil.set(cls, t + c.cooldownMs);
      out.push(this.confirm(cls, mean(streak.recent), t, best.box));
    }
    return out;
  }

  /** Feed one jolt from the accelerometer. Returns boosts for recent confirmations it corroborates. */
  onJolt(jolt: JoltInput): Confirmation[] {
    const c = this.config;
    this.jolts.push(jolt);
    if (this.jolts.length > 16) this.jolts.shift();

    const out: Confirmation[] = [];
    for (const [seq, p] of this.pending) {
      if (jolt.t >= p.t && jolt.t - p.t <= c.joltWindowMs) {
        this.pending.delete(seq);
        out.push({
          kind: 'boost',
          seq,
          cls: p.cls,
          confidence: clamp01(p.base + c.joltBoost),
          baseConfidence: p.base,
          boosted: true,
          joltMagnitude: jolt.magnitude,
          t: p.t,
          box: p.box,
        });
      }
    }
    return out;
  }

  reset(): void {
    this.resetStreaks();
    this.cooldownUntil.clear();
    this.jolts = [];
    this.pending.clear();
    this.lastFrameT = null;
  }

  debug(now: number): ConfirmerDebug {
    const streaks = {} as Record<HazardClass, number>;
    const cooldownRemainingMs = {} as Record<HazardClass, number>;
    for (const cls of HAZARD_CLASSES) {
      streaks[cls] = this.streaks.get(cls)?.count ?? 0;
      cooldownRemainingMs[cls] = Math.max(0, (this.cooldownUntil.get(cls) ?? 0) - now);
    }
    return { streaks, cooldownRemainingMs, awaitingJolt: this.pending.size };
  }

  private confirm(cls: HazardClass, base: number, t: number, box: Box): Confirmation {
    const c = this.config;
    const seq = this.seq++;
    const corroborable = c.joltClasses.includes(cls);
    const recentJolt = corroborable ? this.latestJoltWithin(t) : null;
    if (recentJolt) {
      return {
        kind: 'confirmed',
        seq,
        cls,
        confidence: clamp01(base + c.joltBoost),
        baseConfidence: base,
        boosted: true,
        joltMagnitude: recentJolt.magnitude,
        t,
        box,
      };
    }
    if (corroborable) this.pending.set(seq, { cls, t, base, box }); // a jolt may still follow
    return { kind: 'confirmed', seq, cls, confidence: clamp01(base), baseConfidence: base, boosted: false, joltMagnitude: null, t, box };
  }

  private latestJoltWithin(t: number): JoltInput | null {
    for (let i = this.jolts.length - 1; i >= 0; i--) {
      const j = this.jolts[i]!;
      if (j.t <= t && t - j.t <= this.config.joltWindowMs) return j;
    }
    return null;
  }

  private expire(t: number): void {
    for (const [seq, p] of this.pending) if (t - p.t > this.config.joltWindowMs) this.pending.delete(seq);
    this.jolts = this.jolts.filter((j) => t - j.t <= this.config.joltWindowMs * 2);
  }

  private resetStreaks(): void {
    for (const cls of HAZARD_CLASSES) this.streaks.set(cls, emptyStreak());
  }
}
