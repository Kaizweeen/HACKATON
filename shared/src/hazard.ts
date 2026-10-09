/**
 * THE CONTRACT. Everything the app and the hub agree on about a hazard lives here:
 * the record shape, how its id / ttl are derived, how two copies merge, and when it expires.
 *
 * Merge design (a state-based CRDT / join-semilattice):
 *   every field is merged with an operation that is itself commutative, associative and
 *   idempotent, so replicas converge no matter the order, grouping or repetition of deliveries.
 *
 *     deviceIds   set union (stored sorted + unique so the representation is canonical)
 *     confidence  max
 *     firstSeen   min
 *     lastSeen    max
 *     ttlMs       max (always equal on canonical records: it is derived from `cls`)
 *     lat / lon   position of the "best observation" = lexicographic max of (confidence, -lat, -lon),
 *                 a total order, so the winner never depends on argument order
 *
 *   id, cls and geohash are functions of the id, so two records being merged must share them.
 */

import { encodeGeohash, GEOHASH_PRECISION } from './geohash.js';

/** Class order is the model's class-index order. Do not reorder without retraining/re-exporting. */
export const HAZARD_CLASSES = ['pothole', 'crack', 'flooded_road'] as const;
export type HazardClass = (typeof HAZARD_CLASSES)[number];

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** How long a hazard stays alive after it was last seen. */
export const TTL_MS: Readonly<Record<HazardClass, number>> = Object.freeze({
  pothole: 21 * DAY_MS,
  crack: 21 * DAY_MS,
  flooded_road: 6 * HOUR_MS,
});

export interface Hazard {
  /** Deterministic: `${geohash}:${cls}`. Two phones seeing the same spot produce the same id. */
  id: string;
  cls: HazardClass;
  /** Geohash of (lat, lon) at precision GEOHASH_PRECISION (8). */
  geohash: string;
  /** Position of the best (highest-confidence) observation, WGS84 degrees. */
  lat: number;
  lon: number;
  /** Highest confidence seen across all observations, 0..1. */
  confidence: number;
  /** Random per-device ids that confirmed this hazard. A set: sorted, unique. */
  deviceIds: string[];
  /** Epoch ms of the earliest / latest observation. */
  firstSeen: number;
  lastSeen: number;
  /** Derived from `cls` via TTL_MS. Expiry is lastSeen + ttlMs. */
  ttlMs: number;
}

export function isHazardClass(value: unknown): value is HazardClass {
  return typeof value === 'string' && (HAZARD_CLASSES as readonly string[]).includes(value);
}

export function ttlFor(cls: HazardClass): number {
  return TTL_MS[cls];
}

export function hazardId(geohash: string, cls: HazardClass): string {
  return `${geohash}:${cls}`;
}

/** Canonical set representation: unique + sorted (code-unit order). Never mutates its input. */
export function normalizeDeviceIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Confirmation count as defined by the product: the number of distinct devices. */
export function confirmationCount(h: Pick<Hazard, 'deviceIds'>): number {
  return h.deviceIds.length;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface NewHazardInput {
  cls: HazardClass;
  lat: number;
  lon: number;
  /** Clamped into 0..1. */
  confidence: number;
  deviceId: string;
  /** Epoch ms; defaults to Date.now(). */
  now?: number;
}

/** The only place a brand-new Hazard is built, so id / geohash / ttl are always derived consistently. */
export function createHazard(input: NewHazardInput): Hazard {
  const now = input.now ?? Date.now();
  const geohash = encodeGeohash(input.lat, input.lon, GEOHASH_PRECISION);
  return {
    id: hazardId(geohash, input.cls),
    cls: input.cls,
    geohash,
    lat: input.lat,
    lon: input.lon,
    confidence: clamp01(input.confidence),
    deviceIds: [input.deviceId],
    firstSeen: now,
    lastSeen: now,
    ttlMs: ttlFor(input.cls),
  };
}

/** The observation (confidence, lat, lon) that wins the position tie-break. Total order, so order-independent. */
function betterObservation(a: Hazard, b: Hazard): Hazard {
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  if (a.lat !== b.lat) return a.lat < b.lat ? a : b;
  return a.lon <= b.lon ? a : b;
}

/**
 * Merge two copies of the same hazard. Pure: never mutates its arguments.
 * Commutative, associative and idempotent (proved by randomised tests in test/hazard.test.ts).
 * Throws if the ids differ: merging unrelated hazards is a programming error, not data.
 */
export function mergeHazard(a: Hazard, b: Hazard): Hazard {
  if (a.id !== b.id) throw new Error(`mergeHazard: id mismatch (${a.id} vs ${b.id})`);
  const best = betterObservation(a, b);
  return {
    id: a.id,
    cls: a.cls,
    geohash: a.geohash,
    lat: best.lat,
    lon: best.lon,
    confidence: Math.max(a.confidence, b.confidence),
    deviceIds: normalizeDeviceIds([...a.deviceIds, ...b.deviceIds]),
    firstSeen: Math.min(a.firstSeen, b.firstSeen),
    lastSeen: Math.max(a.lastSeen, b.lastSeen),
    ttlMs: Math.max(a.ttlMs, b.ttlMs),
  };
}

/** Epoch ms at which the hazard stops being valid. */
export function expiresAt(h: Pick<Hazard, 'lastSeen' | 'ttlMs'>): number {
  return h.lastSeen + h.ttlMs;
}

/** Expired exactly at lastSeen + ttlMs (inclusive). */
export function isExpired(h: Pick<Hazard, 'lastSeen' | 'ttlMs'>, now: number): boolean {
  return now >= expiresAt(h);
}

/** Field-by-field equality. Assumes canonical (sorted, unique) deviceIds, which every constructor here guarantees. */
export function hazardsEqual(a: Hazard, b: Hazard): boolean {
  if (
    a.id !== b.id ||
    a.cls !== b.cls ||
    a.geohash !== b.geohash ||
    a.lat !== b.lat ||
    a.lon !== b.lon ||
    a.confidence !== b.confidence ||
    a.firstSeen !== b.firstSeen ||
    a.lastSeen !== b.lastSeen ||
    a.ttlMs !== b.ttlMs ||
    a.deviceIds.length !== b.deviceIds.length
  ) {
    return false;
  }
  for (let i = 0; i < a.deviceIds.length; i++) if (a.deviceIds[i] !== b.deviceIds[i]) return false;
  return true;
}

/**
 * cyrb53: tiny, fast, well-distributed 53-bit string hash (public domain, by bryc). Not cryptographic:
 * it only has to make "same id, different content" show up in a sync summary.
 */
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Content digest of a canonical hazard (base-36). Equal hazards always have equal digests;
 * different content differs with overwhelming probability. Sent in the `hello` summary so two replicas
 * that share the same lastSeen but differ elsewhere (e.g. a different older confirmation) still notice.
 */
export function hazardDigest(h: Hazard): string {
  return cyrb53(
    JSON.stringify([h.id, h.lat, h.lon, h.confidence, h.deviceIds, h.firstSeen, h.lastSeen, h.ttlMs]),
  ).toString(36);
}

export interface ReconcileResult {
  /** State after merging `incoming` into `existing`. */
  merged: Hazard;
  /** True when `merged` differs from `existing` (or there was none): the local store must be updated / re-broadcast. */
  changed: boolean;
  /**
   * True when `merged` has information `incoming` lacks, i.e. the sender is behind and must be sent `merged` back.
   * This "correct the sender" rule, together with the summary/diff handshake, is what makes two replicas converge
   * even though summaries only carry (id, lastSeen, count).
   */
  senderBehind: boolean;
}

/** Apply one incoming copy to local state. Both hub and app use this for every received/written hazard. */
export function reconcile(existing: Hazard | undefined, incoming: Hazard): ReconcileResult {
  const merged = existing ? mergeHazard(existing, incoming) : mergeHazard(incoming, incoming);
  return {
    merged,
    changed: existing === undefined || !hazardsEqual(existing, merged),
    senderBehind: !hazardsEqual(incoming, merged),
  };
}
