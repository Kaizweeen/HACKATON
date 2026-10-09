import { describe, expect, it } from 'vitest';
import { decodeGeohash, decodeGeohashBounds, encodeGeohash, GEOHASH_PRECISION, isGeohash } from '../src/index.js';
import { mulberry32 } from './helpers.js';

describe('geohash', () => {
  it('matches published reference vectors', () => {
    // Wikipedia "Geohash" article examples
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    expect(encodeGeohash(42.605, -5.603, 5)).toBe('ezs42');
    // origin: lon=0, lat=0 both fall in the upper cell, giving the well-known "s0000..."
    expect(encodeGeohash(0, 0, 5)).toBe('s0000');
  });

  it('uses precision 8 by default', () => {
    expect(GEOHASH_PRECISION).toBe(8);
    expect(encodeGeohash(14.585, 121.176)).toHaveLength(8);
  });

  it('round-trips: the centre of a cell encodes back to the same cell, and the cell contains the point', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      const lat = rng() * 180 - 90;
      const lon = rng() * 360 - 180;
      const hash = encodeGeohash(lat, lon, 8);
      const b = decodeGeohashBounds(hash);
      expect(lat).toBeGreaterThanOrEqual(b.latMin);
      expect(lat).toBeLessThanOrEqual(b.latMax);
      expect(lon).toBeGreaterThanOrEqual(b.lonMin);
      expect(lon).toBeLessThanOrEqual(b.lonMax);
      const c = decodeGeohash(hash);
      expect(encodeGeohash(c.lat, c.lon, 8)).toBe(hash);
    }
  });

  it('precision-8 cells are 360/2^20 degrees wide and 180/2^20 tall (about 37 m x 19 m near Antipolo)', () => {
    const b = decodeGeohashBounds(encodeGeohash(14.585, 121.176, 8));
    expect(b.lonMax - b.lonMin).toBeCloseTo(360 / 2 ** 20, 12);
    expect(b.latMax - b.latMin).toBeCloseTo(180 / 2 ** 20, 12);
    const metersPerDegLat = 111_195;
    expect((b.latMax - b.latMin) * metersPerDegLat).toBeGreaterThan(18);
    expect((b.latMax - b.latMin) * metersPerDegLat).toBeLessThan(20);
  });

  it('handles the extremes of the coordinate range', () => {
    expect(() => encodeGeohash(90, 180, 8)).not.toThrow();
    expect(() => encodeGeohash(-90, -180, 8)).not.toThrow();
  });

  it('rejects invalid input', () => {
    expect(() => encodeGeohash(91, 0)).toThrow(RangeError);
    expect(() => encodeGeohash(0, 181)).toThrow(RangeError);
    expect(() => encodeGeohash(Number.NaN, 0)).toThrow(RangeError);
    expect(() => encodeGeohash(0, 0, 0)).toThrow(RangeError);
    expect(() => decodeGeohashBounds('')).toThrow(RangeError);
    expect(() => decodeGeohashBounds('abc!')).toThrow(RangeError);
    expect(() => decodeGeohashBounds('ailo')).toThrow(RangeError); // a, i, l, o are not in the alphabet
  });

  it('isGeohash validates alphabet and length', () => {
    expect(isGeohash('wdw3dgd0')).toBe(true);
    expect(isGeohash('wdw3dgd')).toBe(false);
    expect(isGeohash('wdw3dgda')).toBe(false); // 'a' is not in the alphabet
    expect(isGeohash(12345678)).toBe(false);
  });
});
