import { describe, expect, it } from 'vitest';
import { bearingDegrees, haversineMeters, newDeviceId, offsetMeters, pointAlongPath, polylineLengthMeters } from '../src/index.js';

describe('geo helpers', () => {
  const antipolo = { lat: 14.585, lon: 121.176 };

  it('haversine: one degree of latitude is about 111.2 km', () => {
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeGreaterThan(111_000);
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeLessThan(111_400);
    expect(haversineMeters(antipolo, antipolo)).toBe(0);
  });

  it('offsetMeters moves by the requested distance', () => {
    const north = offsetMeters(antipolo, 100, 0);
    const east = offsetMeters(antipolo, 0, 100);
    expect(haversineMeters(antipolo, north)).toBeCloseTo(100, 0);
    expect(haversineMeters(antipolo, east)).toBeCloseTo(100, 0);
    expect(bearingDegrees(antipolo, north)).toBeCloseTo(0, 1);
    expect(bearingDegrees(antipolo, east)).toBeCloseTo(90, 1);
  });

  it('pointAlongPath interpolates, loops and clamps', () => {
    const b = offsetMeters(antipolo, 0, 100);
    const c = offsetMeters(b, 100, 0);
    const path = [antipolo, b, c];
    expect(polylineLengthMeters(path)).toBeCloseTo(200, 0);
    expect(haversineMeters(pointAlongPath(path, 0), antipolo)).toBeLessThan(0.01);
    expect(haversineMeters(pointAlongPath(path, 50), offsetMeters(antipolo, 0, 50))).toBeLessThan(0.1);
    expect(pointAlongPath(path, 50).headingDeg).toBeCloseTo(90, 1);
    expect(pointAlongPath(path, 150).headingDeg).toBeCloseTo(0, 1);
    // loop: 250 m wraps to 50 m
    expect(haversineMeters(pointAlongPath(path, 250, true), pointAlongPath(path, 50))).toBeLessThan(0.1);
    // clamp: beyond the end stays at the end
    expect(haversineMeters(pointAlongPath(path, 9999, false), c)).toBeLessThan(0.1);
    expect(() => pointAlongPath([], 1)).toThrow();
  });

  it('newDeviceId is 16 hex chars and effectively unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newDeviceId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
