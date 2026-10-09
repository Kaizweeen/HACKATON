import { decodeGeohashBounds, encodeGeohash } from '../src/geohash.js';
import { hazardId, normalizeDeviceIds, ttlFor, type Hazard, type HazardClass } from '../src/hazard.js';

/** Deterministic PRNG (mulberry32) so a failing property test is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;

export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// A cell near Antipolo, Rizal (14.585, 121.176).
export const CELL = encodeGeohash(14.585, 121.176, 8);
export const DEVICE_POOL = ['dev-a', 'dev-b', 'dev-c', 'dev-d', 'dev-e'] as const;

export interface RandomHazardOptions {
  cls?: HazardClass;
  geohash?: string;
  /** Discretised values make ties (equal confidence / position / timestamps) frequent, which is where merges break. */
  discrete?: boolean;
}

/** A random but VALID hazard inside one geohash cell, with canonical deviceIds. */
export function randomHazard(rng: Rng, opts: RandomHazardOptions = {}): Hazard {
  const cls = opts.cls ?? 'pothole';
  const geohash = opts.geohash ?? CELL;
  const b = decodeGeohashBounds(geohash);
  const frac = (): number => (opts.discrete === false ? 0.05 + rng() * 0.9 : pick(rng, [0.1, 0.5, 0.9]));
  const lat = b.latMin + (b.latMax - b.latMin) * frac();
  const lon = b.lonMin + (b.lonMax - b.lonMin) * frac();
  const confidence = opts.discrete === false ? rng() : pick(rng, [0.3, 0.5, 0.7, 0.9]);

  const count = 1 + Math.floor(rng() * 3);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(pick(rng, DEVICE_POOL));

  const base = 1_700_000_000_000;
  const firstSeen = base + (opts.discrete === false ? Math.floor(rng() * 1e6) : pick(rng, [0, 1000, 2000, 3000]));
  const lastSeen = firstSeen + (opts.discrete === false ? Math.floor(rng() * 1e6) : pick(rng, [0, 1000, 2000]));

  return {
    id: hazardId(geohash, cls),
    cls,
    geohash,
    lat,
    lon,
    confidence,
    deviceIds: normalizeDeviceIds(ids),
    firstSeen,
    lastSeen,
    ttlMs: ttlFor(cls),
  };
}

/** Deep-freeze so any accidental mutation inside the code under test throws in strict mode. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
