import { LIMITS } from '@lubak/shared';
import { describe, expect, it } from 'vitest';
import { describeClockSkew } from '../src/ui/clock.js';

// skew = hub clock minus phone clock, as SyncClient reports it.
describe('describeClockSkew', () => {
  it('shows a dash before the first measurement', () => {
    expect(describeClockSkew(null)).toEqual({ text: '–', tone: undefined });
    expect(describeClockSkew(Number.NaN)).toEqual({ text: '–', tone: undefined });
  });

  it('is quiet when the clocks agree to within a minute', () => {
    expect(describeClockSkew(1_500)).toEqual({ text: '1.5 s', tone: undefined });
    expect(describeClockSkew(-59_000).tone).toBeUndefined();
  });

  it('warns, without claiming rejection, when clocks differ by more than a minute either way', () => {
    for (const skew of [90_000, -90_000, -LIMITS.maxFutureSkewMs + 1_000]) {
      const r = describeClockSkew(skew);
      expect(r.tone).toBe('warn');
      expect(r.text).not.toMatch(/rejects/);
    }
  });

  it('only says the hub rejects hazards when the PHONE is more than the allowed skew AHEAD', () => {
    const ahead = describeClockSkew(-LIMITS.maxFutureSkewMs - 1);
    expect(ahead.tone).toBe('bad');
    expect(ahead.text).toMatch(/too far ahead.*rejects/);

    // A phone that is far BEHIND is accepted by the hub (its hazards just look old).
    const behind = describeClockSkew(LIMITS.maxFutureSkewMs * 3);
    expect(behind.tone).toBe('warn');
    expect(behind.text).not.toMatch(/rejects/);
  });
});
