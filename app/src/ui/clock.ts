import { LIMITS } from '@lubak/shared';

export type ClockTone = 'warn' | 'bad' | undefined;

/** Differences above this make "x minutes ago" on the map look wrong, but nothing is rejected. */
export const CLOCK_WARN_MS = 60_000;

/**
 * How to present the Debug screen's "Clock vs hub" row.
 *
 * `skewMs` is hub clock minus this phone's clock (see SyncClient). The hub refuses a hazard stamped more than
 * LIMITS.maxFutureSkewMs AHEAD of its own clock, i.e. when the phone is that far ahead (skew very negative).
 * A phone that is merely behind is accepted; its hazards just look older than they are.
 */
export function describeClockSkew(skewMs: number | null): { text: string; tone: ClockTone } {
  if (skewMs === null || !Number.isFinite(skewMs)) return { text: '–', tone: undefined };
  const base = `${(skewMs / 1000).toFixed(1)} s`;
  if (skewMs < -LIMITS.maxFutureSkewMs) {
    return { text: `${base} (this phone's clock is too far ahead: the hub rejects its new hazards)`, tone: 'bad' };
  }
  if (Math.abs(skewMs) > CLOCK_WARN_MS) {
    return { text: `${base} (clocks differ by over a minute: hazard ages will look off)`, tone: 'warn' };
  }
  return { text: base, tone: undefined };
}
