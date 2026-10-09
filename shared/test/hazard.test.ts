import { describe, expect, it } from 'vitest';
import {
  confirmationCount,
  createHazard,
  DAY_MS,
  expiresAt,
  HAZARD_CLASSES,
  hazardDigest,
  hazardsEqual,
  HOUR_MS,
  isExpired,
  mergeHazard,
  normalizeDeviceIds,
  TTL_MS,
  ttlFor,
  type Hazard,
} from '../src/index.js';
import { CELL, deepFreeze, mulberry32, pick, randomHazard, shuffle } from './helpers.js';

const ROUNDS = 500;

describe('createHazard: deterministic ids and derived fields', () => {
  const spot = { lat: 14.585, lon: 121.176 };

  it('id is geohash(precision 8) + ":" + class', () => {
    const h = createHazard({ cls: 'pothole', ...spot, confidence: 0.8, deviceId: 'dev-a', now: 1000 });
    expect(h.geohash).toHaveLength(8);
    expect(h.geohash).toBe(CELL);
    expect(h.id).toBe(`${CELL}:pothole`);
  });

  it('two devices seeing the same spot produce the same id, different classes do not', () => {
    const a = createHazard({ cls: 'pothole', ...spot, confidence: 0.6, deviceId: 'dev-a', now: 1 });
    const b = createHazard({ cls: 'pothole', lat: spot.lat + 0.00001, lon: spot.lon, confidence: 0.9, deviceId: 'dev-b', now: 2 });
    const c = createHazard({ cls: 'crack', ...spot, confidence: 0.6, deviceId: 'dev-a', now: 1 });
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });

  it('derives ttlMs from the class: flooded_road 6 h, pothole and crack 21 days', () => {
    expect(TTL_MS.flooded_road).toBe(6 * HOUR_MS);
    expect(TTL_MS.pothole).toBe(21 * DAY_MS);
    expect(TTL_MS.crack).toBe(21 * DAY_MS);
    for (const cls of HAZARD_CLASSES) {
      expect(createHazard({ cls, ...spot, confidence: 0.5, deviceId: 'd', now: 0 }).ttlMs).toBe(ttlFor(cls));
    }
  });

  it('starts with one confirmation, equal first/last seen, and clamps confidence to 0..1', () => {
    const h = createHazard({ cls: 'crack', ...spot, confidence: 1.7, deviceId: 'dev-a', now: 5000 });
    expect(h.deviceIds).toEqual(['dev-a']);
    expect(confirmationCount(h)).toBe(1);
    expect([h.firstSeen, h.lastSeen]).toEqual([5000, 5000]);
    expect(h.confidence).toBe(1);
    expect(createHazard({ cls: 'crack', ...spot, confidence: -3, deviceId: 'd', now: 0 }).confidence).toBe(0);
  });
});

describe('mergeHazard: semantics', () => {
  it('unions deviceIds, takes max confidence, min firstSeen and max lastSeen', () => {
    const a: Hazard = { ...randomHazard(mulberry32(1)), confidence: 0.6, deviceIds: ['dev-a', 'dev-b'], firstSeen: 1000, lastSeen: 5000 };
    const b: Hazard = { ...a, confidence: 0.9, deviceIds: ['dev-b', 'dev-c'], firstSeen: 2000, lastSeen: 9000 };
    const m = mergeHazard(a, b);
    expect(m.deviceIds).toEqual(['dev-a', 'dev-b', 'dev-c']);
    expect(m.confidence).toBe(0.9);
    expect(m.firstSeen).toBe(1000);
    expect(m.lastSeen).toBe(9000);
    expect(confirmationCount(m)).toBe(3);
    expect(confirmationCount(m)).toBe(m.deviceIds.length);
  });

  it('confirmation count is the number of DISTINCT devices: the same phone reporting twice does not inflate it', () => {
    const base = createHazard({ cls: 'pothole', lat: 14.585, lon: 121.176, confidence: 0.7, deviceId: 'dev-a', now: 1 });
    const again = createHazard({ cls: 'pothole', lat: 14.585, lon: 121.176, confidence: 0.8, deviceId: 'dev-a', now: 2 });
    const other = createHazard({ cls: 'pothole', lat: 14.585, lon: 121.176, confidence: 0.5, deviceId: 'dev-b', now: 3 });
    expect(confirmationCount(mergeHazard(base, again))).toBe(1);
    expect(confirmationCount(mergeHazard(mergeHazard(base, again), other))).toBe(2);
  });

  it('keeps the position of the highest-confidence observation', () => {
    const a: Hazard = { ...randomHazard(mulberry32(2)), confidence: 0.4, lat: 14.58501, lon: 121.1761 };
    const b: Hazard = { ...a, confidence: 0.9, lat: 14.58502, lon: 121.1762 };
    const m = mergeHazard(a, b);
    expect([m.lat, m.lon]).toEqual([b.lat, b.lon]);
    expect(mergeHazard(b, a)).toEqual(m);
  });

  it('resolves equal-confidence position ties the same way in both argument orders', () => {
    const a: Hazard = { ...randomHazard(mulberry32(3)), confidence: 0.5, lat: 14.58501, lon: 121.17601 };
    const b: Hazard = { ...a, lat: 14.58502, lon: 121.17600 };
    expect(mergeHazard(a, b)).toEqual(mergeHazard(b, a));
    expect(mergeHazard(a, b).lat).toBe(14.58501); // lower latitude wins the tie
  });

  it('treats deviceIds as a set: order and duplicates are irrelevant, output is canonical', () => {
    const a: Hazard = { ...randomHazard(mulberry32(4)), deviceIds: ['dev-c', 'dev-a', 'dev-c'] };
    const b: Hazard = { ...a, deviceIds: ['dev-b', 'dev-a'] };
    expect(mergeHazard(a, b).deviceIds).toEqual(['dev-a', 'dev-b', 'dev-c']);
    expect(normalizeDeviceIds(['z', 'a', 'z'])).toEqual(['a', 'z']);
  });

  it('throws when asked to merge two different hazards', () => {
    const a = randomHazard(mulberry32(5), { cls: 'pothole' });
    const b = randomHazard(mulberry32(5), { cls: 'crack' });
    expect(() => mergeHazard(a, b)).toThrow(/id mismatch/);
  });

  it('is pure: never mutates its inputs (frozen inputs would throw)', () => {
    const rng = mulberry32(6);
    const a = deepFreeze(randomHazard(rng));
    const b = deepFreeze(randomHazard(rng));
    expect(() => mergeHazard(a, b)).not.toThrow();
    const m = mergeHazard(a, b);
    expect(m.deviceIds).not.toBe(a.deviceIds);
    expect(m.deviceIds).not.toBe(b.deviceIds);
  });
});

describe('mergeHazard: algebraic properties (randomised, seeded, ties deliberately frequent)', () => {
  it(`is commutative: merge(a, b) = merge(b, a) over ${ROUNDS} random pairs`, () => {
    const rng = mulberry32(1001);
    for (let i = 0; i < ROUNDS; i++) {
      const a = randomHazard(rng);
      const b = randomHazard(rng);
      expect(mergeHazard(a, b)).toEqual(mergeHazard(b, a));
    }
  });

  it(`is associative: merge(merge(a, b), c) = merge(a, merge(b, c)) over ${ROUNDS} random triples`, () => {
    const rng = mulberry32(1002);
    for (let i = 0; i < ROUNDS; i++) {
      const a = randomHazard(rng);
      const b = randomHazard(rng);
      const c = randomHazard(rng);
      expect(mergeHazard(mergeHazard(a, b), c)).toEqual(mergeHazard(a, mergeHazard(b, c)));
    }
  });

  it(`is idempotent: merge(a, a) = a, and re-delivering either side changes nothing, over ${ROUNDS} rounds`, () => {
    const rng = mulberry32(1003);
    for (let i = 0; i < ROUNDS; i++) {
      const a = randomHazard(rng);
      const b = randomHazard(rng);
      expect(mergeHazard(a, a)).toEqual(a);
      const ab = mergeHazard(a, b);
      expect(mergeHazard(ab, a)).toEqual(ab);
      expect(mergeHazard(ab, b)).toEqual(ab);
      expect(mergeHazard(ab, ab)).toEqual(ab);
    }
  });

  it('holds with continuous (tie-free) values too', () => {
    const rng = mulberry32(1004);
    for (let i = 0; i < ROUNDS; i++) {
      const a = randomHazard(rng, { discrete: false });
      const b = randomHazard(rng, { discrete: false });
      const c = randomHazard(rng, { discrete: false });
      expect(mergeHazard(a, b)).toEqual(mergeHazard(b, a));
      expect(mergeHazard(mergeHazard(a, b), c)).toEqual(mergeHazard(a, mergeHazard(b, c)));
      expect(mergeHazard(a, a)).toEqual(a);
    }
  });

  it('holds for every class', () => {
    const rng = mulberry32(1005);
    for (const cls of HAZARD_CLASSES) {
      for (let i = 0; i < 100; i++) {
        const a = randomHazard(rng, { cls });
        const b = randomHazard(rng, { cls });
        const c = randomHazard(rng, { cls });
        expect(mergeHazard(a, b)).toEqual(mergeHazard(b, a));
        expect(mergeHazard(mergeHazard(a, b), c)).toEqual(mergeHazard(a, mergeHazard(b, c)));
        expect(mergeHazard(a, a)).toEqual(a);
      }
    }
  });

  it('replicas converge whatever the order, grouping or repetition of deliveries', () => {
    const rng = mulberry32(1006);
    for (let round = 0; round < 100; round++) {
      const updates = Array.from({ length: 2 + Math.floor(rng() * 6) }, () => randomHazard(rng));
      const reference = updates.reduce((acc, u) => mergeHazard(acc, u));

      // shuffled order
      const shuffled = shuffle(rng, updates).reduce((acc, u) => mergeHazard(acc, u));
      expect(shuffled).toEqual(reference);

      // with duplicated deliveries mixed in
      const withDupes = shuffle(rng, [...updates, ...updates.filter(() => rng() < 0.5), pick(rng, updates)]);
      expect(withDupes.reduce((acc, u) => mergeHazard(acc, u))).toEqual(reference);

      // as two partial replicas that later exchange state
      const cut = 1 + Math.floor(rng() * (updates.length - 1));
      const left = updates.slice(0, cut).reduce((acc, u) => mergeHazard(acc, u));
      const right = updates.slice(cut).reduce((acc, u) => mergeHazard(acc, u));
      expect(mergeHazard(left, right)).toEqual(reference);
      expect(mergeHazard(right, left)).toEqual(reference);
    }
  });

  it('only ever moves "up": confidence, lastSeen, confirmations never decrease; firstSeen never increases', () => {
    const rng = mulberry32(1007);
    for (let i = 0; i < ROUNDS; i++) {
      const a = randomHazard(rng);
      const b = randomHazard(rng);
      const m = mergeHazard(a, b);
      expect(m.confidence).toBeGreaterThanOrEqual(a.confidence);
      expect(m.lastSeen).toBeGreaterThanOrEqual(a.lastSeen);
      expect(m.firstSeen).toBeLessThanOrEqual(a.firstSeen);
      expect(m.deviceIds.length).toBeGreaterThanOrEqual(a.deviceIds.length);
    }
  });
});

describe('expiry', () => {
  const T0 = 1_760_000_000_000;
  const mk = (cls: 'pothole' | 'crack' | 'flooded_road') =>
    createHazard({ cls, lat: 14.585, lon: 121.176, confidence: 0.8, deviceId: 'dev-a', now: T0 });

  it('flooded_road expires 6 hours after it was last seen (inclusive boundary)', () => {
    const h = mk('flooded_road');
    expect(expiresAt(h)).toBe(T0 + 6 * HOUR_MS);
    expect(isExpired(h, T0)).toBe(false);
    expect(isExpired(h, T0 + 6 * HOUR_MS - 1)).toBe(false);
    expect(isExpired(h, T0 + 6 * HOUR_MS)).toBe(true);
    expect(isExpired(h, T0 + 7 * HOUR_MS)).toBe(true);
  });

  it.each(['pothole', 'crack'] as const)('%s expires 21 days after it was last seen', (cls) => {
    const h = mk(cls);
    expect(isExpired(h, T0 + 6 * HOUR_MS)).toBe(false); // outlives a flood
    expect(isExpired(h, T0 + 20 * DAY_MS)).toBe(false);
    expect(isExpired(h, T0 + 21 * DAY_MS - 1)).toBe(false);
    expect(isExpired(h, T0 + 21 * DAY_MS)).toBe(true);
  });

  it('a fresh sighting merged in extends the lifetime (expiry follows lastSeen)', () => {
    const old = mk('flooded_road');
    const fresh = createHazard({ cls: 'flooded_road', lat: 14.585, lon: 121.176, confidence: 0.7, deviceId: 'dev-b', now: T0 + 5 * HOUR_MS });
    const merged = mergeHazard(old, fresh);
    const now = T0 + 7 * HOUR_MS;
    expect(isExpired(old, now)).toBe(true);
    expect(isExpired(merged, now)).toBe(false);
    expect(isExpired(merged, T0 + 11 * HOUR_MS)).toBe(true);
  });

  it('merging an OLDER sighting never shortens life or resurrects anything', () => {
    const fresh = mk('pothole');
    const older = createHazard({ cls: 'pothole', lat: 14.585, lon: 121.176, confidence: 0.7, deviceId: 'dev-b', now: T0 - 30 * DAY_MS });
    const merged = mergeHazard(fresh, older);
    expect(merged.lastSeen).toBe(T0);
    expect(merged.firstSeen).toBe(T0 - 30 * DAY_MS);
    expect(isExpired(older, T0)).toBe(true);
    expect(isExpired(merged, T0)).toBe(false);
  });
});

describe('hazardDigest', () => {
  it('is equal exactly when the hazards are equal (no collisions over thousands of random pairs)', () => {
    const rng = mulberry32(2001);
    let equalPairs = 0;
    for (let i = 0; i < 3000; i++) {
      const a = randomHazard(rng);
      const b = randomHazard(rng);
      expect(hazardDigest(a) === hazardDigest(b)).toBe(hazardsEqual(a, b));
      if (hazardsEqual(a, b)) equalPairs += 1;
    }
    expect(equalPairs).toBeLessThan(3000); // the generator does produce both equal and different pairs
  });

  it('is stable across a JSON round trip and sensitive to every field', () => {
    const h = randomHazard(mulberry32(2002));
    expect(hazardDigest(JSON.parse(JSON.stringify(h)))).toBe(hazardDigest(h));
    const variants: Hazard[] = [
      { ...h, lat: h.lat + 1e-9 },
      { ...h, lon: h.lon + 1e-9 },
      { ...h, confidence: h.confidence + 0.001 },
      { ...h, deviceIds: [...h.deviceIds, 'dev-z'] },
      { ...h, firstSeen: h.firstSeen - 1 },
      { ...h, lastSeen: h.lastSeen + 1 },
      { ...h, ttlMs: h.ttlMs + 1 },
    ];
    for (const v of variants) expect(hazardDigest(v)).not.toBe(hazardDigest(h));
  });

  it('cannot be confused by ids that contain separator characters', () => {
    const h = randomHazard(mulberry32(2003));
    const a = { ...h, deviceIds: ['a,b'] };
    const b = { ...h, deviceIds: ['a', 'b'] };
    expect(hazardDigest(a)).not.toBe(hazardDigest(b));
  });
});
