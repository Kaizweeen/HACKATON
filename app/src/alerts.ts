/**
 * Hazard-ahead warnings: the reason hazards are shared at all is that the NEXT rider hears about the pothole before reaching it.
 *
 * On every GPS fix the alerter looks at the stored hazards (this phone's and every other phone's) and returns at most one warning:
 * the nearest hazard that lies on the road AHEAD (inside a cone around the direction of travel) within a few seconds of travel.
 * Each hazard warns once per approach and re-arms only after the rider has been well away from it, so riding past does not
 * repeat it. A hazard this phone itself confirmed moments ago is not announced: that is the one the rider just went over.
 * Pure logic, no DOM: the Drive screen turns a warning into a banner, a beep and a vibration.
 */
import { bearingDegrees, confirmationCount, haversineMeters, isExpired, type Hazard, type LatLon } from '@lubak/shared';
import type { GeoFix } from './sensors.js';

export interface AlertConfig {
  /** Warn this many seconds of travel before the hazard (distance = speed x leadSeconds, clamped below). */
  leadSeconds: number;
  minDistanceM: number;
  maxDistanceM: number;
  /** Half-angle of the "ahead" cone around the direction of travel, degrees. */
  coneDeg: number;
  /** Without a usable direction (standing, or the first fix) only hazards this close count. */
  stationaryRadiusM: number;
  /** Below this speed (m/s) the GPS heading is noise. */
  minSpeedForHeadingMps: number;
  /** A warned hazard warns again only after the rider was this far from it. */
  rearmDistanceM: number;
  /** Do not announce a hazard this phone confirmed within this many ms (the rider is on top of it). */
  ownGraceMs: number;
  /** Ignore fixes worse than this (m): a 100 m circle cannot tell "ahead" from "behind". */
  maxAccuracyM: number;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  leadSeconds: 6,
  minDistanceM: 35,
  maxDistanceM: 150,
  coneDeg: 35,
  stationaryRadiusM: 25,
  minSpeedForHeadingMps: 1.5,
  rearmDistanceM: 250,
  ownGraceMs: 30_000,
  maxAccuracyM: 50,
};

export interface HazardAlert {
  hazard: Hazard;
  /** Straight-line distance from the rider, metres. */
  distanceM: number;
  /** Phones that confirmed it. */
  confirmations: number;
  /** Epoch ms of the warning. */
  at: number;
}

/** Smallest absolute difference between two compass bearings, 0..180. */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

export class HazardAlerter {
  readonly config: AlertConfig;
  private readonly warned = new Map<string, LatLon>();
  private previous: { fix: GeoFix } | null = null;
  private count = 0;
  private last: HazardAlert | null = null;

  constructor(
    private readonly deviceId: string,
    config: Partial<AlertConfig> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.config = { ...DEFAULT_ALERT_CONFIG, ...config };
  }

  get stats(): { warnings: number; last: HazardAlert | null } {
    return { warnings: this.count, last: this.last };
  }

  /** Forget every warning (a new drive). */
  reset(): void {
    this.warned.clear();
    this.previous = null;
  }

  /** Feed one fix and the hazards the phone knows; returns the warning to raise now, if any. */
  update(fix: GeoFix, hazards: readonly Hazard[]): HazardAlert | null {
    const cfg = this.config;
    const motion = this.motion(fix);
    if (fix.accuracy > cfg.maxAccuracyM) return null;

    for (const [id, spot] of this.warned) if (haversineMeters(fix, spot) > cfg.rearmDistanceM) this.warned.delete(id);

    const now = this.now();
    const reach = motion.speed === null ? cfg.minDistanceM : Math.min(cfg.maxDistanceM, Math.max(cfg.minDistanceM, motion.speed * cfg.leadSeconds));
    let best: { hazard: Hazard; distance: number } | null = null;
    for (const hazard of hazards) {
      if (this.warned.has(hazard.id) || isExpired(hazard, now)) continue;
      if (hazard.deviceIds.includes(this.deviceId) && now - hazard.lastSeen < cfg.ownGraceMs) continue;
      const distance = haversineMeters(fix, hazard);
      if (motion.heading === null) {
        if (distance > cfg.stationaryRadiusM) continue;
      } else if (distance > reach || angleBetween(motion.heading, bearingDegrees(fix, hazard)) > cfg.coneDeg) {
        continue;
      }
      if (!best || distance < best.distance) best = { hazard, distance };
    }
    if (!best) return null;
    this.warned.set(best.hazard.id, { lat: best.hazard.lat, lon: best.hazard.lon });
    this.count += 1;
    this.last = { hazard: best.hazard, distanceM: best.distance, confirmations: confirmationCount(best.hazard), at: now };
    return this.last;
  }

  /** Direction and speed of travel: the GPS's own when it is moving, else derived from the last fix. */
  private motion(fix: GeoFix): { heading: number | null; speed: number | null } {
    const cfg = this.config;
    const prev = this.previous?.fix;
    this.previous = { fix };
    if (fix.heading !== null && fix.speed !== null && fix.speed >= cfg.minSpeedForHeadingMps) return { heading: fix.heading, speed: fix.speed };
    if (prev) {
      const moved = haversineMeters(prev, fix);
      const dt = (fix.t - prev.t) / 1000;
      if (dt > 0 && dt <= 10 && moved / dt >= cfg.minSpeedForHeadingMps && moved >= Math.max(3, fix.accuracy / 2)) {
        return { heading: bearingDegrees(prev, fix), speed: moved / dt };
      }
    }
    return { heading: null, speed: fix.speed };
  }
}
