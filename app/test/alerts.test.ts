import { describe, expect, it } from 'vitest';
import { createHazard, offsetMeters, type Hazard, type HazardClass, type LatLon } from '@lubak/shared';
import { angleBetween, HazardAlerter } from '../src/alerts.js';
import type { GeoFix } from '../src/sensors.js';

const NOW = 1_760_000_000_000;
const START: LatLon = { lat: 14.58471, lon: 121.175709 };
/** A rider heading due south (180°) at 7 m/s (25 km/h): the demo loop's first street. */
const fix = (southM: number, over: Partial<GeoFix> = {}): GeoFix => ({ ...offsetMeters(START, -southM, 0), accuracy: 5, speed: 7, heading: 180, t: southM * 1000, ...over });
const hazardAt = (southM: number, eastM = 0, over: { cls?: HazardClass; deviceId?: string; now?: number } = {}): Hazard =>
  createHazard({ cls: over.cls ?? 'pothole', ...offsetMeters(START, -southM, eastM), confidence: 0.8, deviceId: over.deviceId ?? 'other-phone', now: over.now ?? NOW - 60_000 });

describe('hazard-ahead warnings', () => {
  it('warns about a hazard on the road ahead about 6 s before reaching it, once', () => {
    const alerter = new HazardAlerter('me', {}, () => NOW);
    const pothole = hazardAt(200);
    expect(alerter.update(fix(100), [pothole])).toBeNull(); // 100 m away, more than 6 s at 7 m/s
    expect(alerter.update(fix(150), [pothole])).toBeNull(); // 50 m
    const warning = alerter.update(fix(160), [pothole]); // 40 m: inside 42 m
    expect(warning?.hazard.id).toBe(pothole.id);
    expect(warning?.distanceM).toBeCloseTo(40, 0);
    expect(warning?.confirmations).toBe(1);
    expect(alerter.update(fix(170), [pothole])).toBeNull(); // already warned
    expect(alerter.update(fix(195), [pothole])).toBeNull();
    expect(alerter.stats.warnings).toBe(1);
  });

  it('looks further ahead the faster the rider goes, within limits', () => {
    const fast = new HazardAlerter('me', {}, () => NOW);
    expect(fast.update(fix(0, { speed: 16.7 }), [hazardAt(95)])).not.toBeNull(); // 60 km/h: ~100 m
    const crawling = new HazardAlerter('me', {}, () => NOW);
    expect(crawling.update(fix(0, { speed: 2 }), [hazardAt(30)])).not.toBeNull(); // never less than 35 m
    const motorway = new HazardAlerter('me', {}, () => NOW);
    expect(motorway.update(fix(0, { speed: 40 }), [hazardAt(170)])).toBeNull(); // never more than 150 m
  });

  it('ignores hazards behind the rider or off to the side', () => {
    const alerter = new HazardAlerter('me', {}, () => NOW);
    expect(alerter.update(fix(100), [hazardAt(80), hazardAt(110, 30)])).toBeNull(); // 20 m behind; 30 m east of a point 10 m ahead
    expect(alerter.update(fix(100), [hazardAt(130, 5)])?.distanceM).toBeGreaterThan(29); // slightly off the centre line is fine
  });

  it('picks the nearest of several hazards ahead, and the next one on the next fix', () => {
    const alerter = new HazardAlerter('me', {}, () => NOW);
    const near = hazardAt(120, 0, { cls: 'crack' });
    const far = hazardAt(135);
    expect(alerter.update(fix(100), [far, near])?.hazard.id).toBe(near.id);
    expect(alerter.update(fix(101), [far, near])?.hazard.id).toBe(far.id);
  });

  it('re-arms a hazard once the rider has been far away from it (the next lap warns again)', () => {
    const alerter = new HazardAlerter('me', {}, () => NOW);
    const pothole = hazardAt(200);
    expect(alerter.update(fix(170), [pothole])).not.toBeNull();
    expect(alerter.update(fix(400), [pothole])).toBeNull(); // 200 m past it: not yet re-armed
    expect(alerter.update(fix(460), [pothole])).toBeNull(); // 260 m past it: re-armed, but it is behind
    expect(alerter.update(fix(170, { t: 999_000 }), [pothole])).not.toBeNull(); // back on the start of the street
  });

  it('does not announce what this phone just confirmed, but does announce its older finds', () => {
    const justNow = new HazardAlerter('me', {}, () => NOW);
    expect(justNow.update(fix(170), [hazardAt(200, 0, { deviceId: 'me', now: NOW - 5_000 })])).toBeNull();
    const lastLap = new HazardAlerter('me', {}, () => NOW);
    expect(lastLap.update(fix(170), [hazardAt(200, 0, { deviceId: 'me', now: NOW - 55_000 })])).not.toBeNull();
  });

  it('ignores expired hazards and fixes too vague to tell ahead from behind', () => {
    const alerter = new HazardAlerter('me', {}, () => NOW);
    const flood = hazardAt(200, 0, { cls: 'flooded_road', now: NOW - 7 * 3600_000 }); // floods expire after 6 h
    expect(alerter.update(fix(170), [flood])).toBeNull();
    expect(alerter.update(fix(170, { accuracy: 80 }), [hazardAt(200)])).toBeNull();
  });

  it('works out the direction from consecutive fixes when the GPS gives no heading', () => {
    const alerter = new HazardAlerter('me', {}, () => NOW);
    const pothole = hazardAt(200);
    expect(alerter.update(fix(150, { heading: null, speed: null, t: 0 }), [pothole])).toBeNull(); // no direction yet: only 25 m around
    expect(alerter.update(fix(165, { heading: null, speed: null, t: 2000 }), [pothole])?.hazard.id).toBe(pothole.id); // 7.5 m/s south
  });

  it('standing still, warns only about a hazard right here', () => {
    const alerter = new HazardAlerter('me', {}, () => NOW);
    expect(alerter.update(fix(100, { speed: 0, heading: null }), [hazardAt(140)])).toBeNull();
    expect(alerter.update(fix(100, { speed: 0, heading: null, t: 100_500 }), [hazardAt(120)])).not.toBeNull();
  });

  it('angleBetween wraps around north', () => {
    expect([angleBetween(350, 10), angleBetween(10, 350), angleBetween(90, 270), angleBetween(180, 180)]).toEqual([20, 20, 180, 0]);
  });
});
