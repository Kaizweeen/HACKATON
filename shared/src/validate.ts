/**
 * Boundary validation for hazards that arrive from the network or from disk.
 *
 * The hub accepts WebSocket clients from anyone on the hotspot, so every inbound record is
 * validated and re-canonicalised here before it touches the store. Derived fields (id, ttlMs)
 * are NEVER trusted from the sender: a client cannot invent an immortal hazard.
 *
 * Deliberately NOT done here: clamping timestamps. Rewriting a record differently on two replicas
 * would make them disagree forever (and ping-pong corrections), so out-of-range input is rejected instead.
 */

import { encodeGeohash, GEOHASH_PRECISION, isGeohash } from './geohash.js';
import { hazardId, isHazardClass, normalizeDeviceIds, ttlFor, type Hazard } from './hazard.js';

export const LIMITS = {
  maxDeviceIdsPerHazard: 256,
  maxDeviceIdLength: 64,
  /** Reject records whose lastSeen is further in the future than this (clock-skew guard). */
  maxFutureSkewMs: 10 * 60_000,
} as const;

export type RejectReason =
  | 'not-an-object'
  | 'bad-class'
  | 'bad-coordinates'
  | 'bad-geohash'
  | 'geohash-mismatch'
  | 'id-mismatch'
  | 'bad-confidence'
  | 'bad-timestamps'
  | 'from-the-future'
  | 'bad-device-ids';

export type SanitizeResult = { ok: true; hazard: Hazard } | { ok: false; reason: RejectReason };

const fail = (reason: RejectReason): SanitizeResult => ({ ok: false, reason });

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `x + 0` turns -0 into 0 so equality checks (and JSON round-trips) behave. */
const noNegZero = (x: number): number => x + 0;

/**
 * Validate an unknown value and return a canonical Hazard (derived fields recomputed).
 * Pass `now` to also enable the future-timestamp guard.
 */
export function sanitizeHazard(input: unknown, opts: { now?: number } = {}): SanitizeResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('not-an-object');
  const r = input as Record<string, unknown>;

  const cls = r['cls'];
  if (!isHazardClass(cls)) return fail('bad-class');

  const lat = r['lat'];
  const lon = r['lon'];
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return fail('bad-coordinates');
  }

  const geohash = r['geohash'];
  if (!isGeohash(geohash, GEOHASH_PRECISION)) return fail('bad-geohash');
  if (geohash !== encodeGeohash(lat, lon, GEOHASH_PRECISION)) return fail('geohash-mismatch');
  if (r['id'] !== hazardId(geohash, cls)) return fail('id-mismatch');

  const confidence = r['confidence'];
  if (!isFiniteNumber(confidence) || confidence < 0 || confidence > 1) return fail('bad-confidence');

  const firstSeen = r['firstSeen'];
  const lastSeen = r['lastSeen'];
  if (!isFiniteNumber(firstSeen) || !isFiniteNumber(lastSeen) || firstSeen < 0 || lastSeen < firstSeen) {
    return fail('bad-timestamps');
  }
  if (opts.now !== undefined && lastSeen > opts.now + LIMITS.maxFutureSkewMs) return fail('from-the-future');

  const rawIds = r['deviceIds'];
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > LIMITS.maxDeviceIdsPerHazard) {
    return fail('bad-device-ids');
  }
  for (const id of rawIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > LIMITS.maxDeviceIdLength) {
      return fail('bad-device-ids');
    }
  }

  return {
    ok: true,
    hazard: {
      id: hazardId(geohash, cls),
      cls,
      geohash,
      lat: noNegZero(lat),
      lon: noNegZero(lon),
      confidence: noNegZero(confidence),
      deviceIds: normalizeDeviceIds(rawIds as string[]),
      firstSeen,
      lastSeen,
      ttlMs: ttlFor(cls), // derived, never trusted from the wire
    },
  };
}
