import { describe, expect, it } from 'vitest';
import {
  computeDiff,
  createHazard,
  DAY_MS,
  hazardDigest,
  hazardsEqual,
  HOUR_MS,
  mergeHazard,
  reconcile,
  summarize,
  type Hazard,
  type SummaryEntry,
} from '../src/index.js';
import { mulberry32, pick, shuffle, type Rng } from './helpers.js';

const NOW = 1_760_000_000_000;
const at = (cls: Hazard['cls'], lat: number, deviceId: string, now: number, confidence = 0.8): Hazard =>
  createHazard({ cls, lat, lon: 121.176, confidence, deviceId, now });

describe('summarize / computeDiff', () => {
  const h1 = at('pothole', 14.585, 'dev-a', NOW);
  const h2 = at('crack', 14.586, 'dev-a', NOW);

  it('summarises id, lastSeen and a content digest; leaves out expired ones when given a clock', () => {
    const stale = at('flooded_road', 14.587, 'dev-a', NOW - 7 * HOUR_MS);
    expect(summarize([h1, stale])).toEqual([
      { id: h1.id, lastSeen: NOW, d: hazardDigest(h1) },
      { id: stale.id, lastSeen: NOW - 7 * HOUR_MS, d: hazardDigest(stale) },
    ]);
    expect(summarize([h1, stale], NOW).map((e) => e.id)).toEqual([h1.id]);
  });

  it('offers hazards the peer is missing', () => {
    expect(computeDiff([h1, h2], [], NOW)).toEqual([h1, h2]);
    expect(computeDiff([h1, h2], summarize([h1]), NOW)).toEqual([h2]);
  });

  it('offers hazards the peer has older (lower lastSeen)', () => {
    const newer = mergeHazard(h1, at('pothole', 14.585, 'dev-b', NOW + 5000));
    expect(computeDiff([newer], summarize([h1]), NOW + 6000)).toEqual([newer]);
  });

  it('does not offer what the peer already has, or has newer', () => {
    const newer = mergeHazard(h1, at('pothole', 14.585, 'dev-b', NOW + 5000));
    expect(computeDiff([h1], summarize([h1]), NOW)).toEqual([]);
    expect(computeDiff([h1], summarize([newer]), NOW + 6000)).toEqual([]);
  });

  it('never offers expired hazards (no resurrection through sync)', () => {
    const stale = at('flooded_road', 14.587, 'dev-a', NOW - 7 * HOUR_MS);
    expect(computeDiff([stale], [], NOW)).toEqual([]);
  });

  it('detects a late confirmation that does not raise lastSeen', () => {
    // Phone A saw it at t=100; phone B saw it EARLIER (t=90) but was offline, so its report reached the hub last.
    const a = at('pothole', 14.585, 'dev-a', NOW + 100);
    const b = at('pothole', 14.585, 'dev-b', NOW + 90);
    const hub = mergeHazard(a, b); // lastSeen = NOW+100, devices [a, b]
    const phoneThatMissedB = a; //     lastSeen = NOW+100, devices [a]
    expect(hub.lastSeen).toBe(phoneThatMissedB.lastSeen); // lastSeen alone would call these identical
    expect(computeDiff([hub], summarize([phoneThatMissedB]), NOW + 1000)).toEqual([hub]);
  });

  it('detects replicas that share the newest observation but differ in older ones, even with equal confirmation counts', () => {
    // The case that (lastSeen, count) cannot see: same newest report, same number of confirmations, different devices.
    const top = at('pothole', 14.585, 'dev-a', NOW + 100);
    const x = mergeHazard(top, at('pothole', 14.585, 'dev-b', NOW + 50));
    const y = mergeHazard(top, at('pothole', 14.585, 'dev-c', NOW + 40));
    expect([x.lastSeen, x.deviceIds.length]).toEqual([y.lastSeen, y.deviceIds.length]);
    expect(computeDiff([x], summarize([y]), NOW + 1000)).toEqual([x]);
    expect(computeDiff([y], summarize([x]), NOW + 1000)).toEqual([y]);
  });

  it('detects two phones that stamped the same hazard in the same millisecond', () => {
    const a = at('pothole', 14.585, 'dev-a', NOW);
    const b = at('pothole', 14.585, 'dev-b', NOW);
    expect(computeDiff([a], summarize([b]), NOW)).toEqual([a]);
  });

  it('offers nothing when both sides hold byte-identical state', () => {
    const merged = mergeHazard(at('pothole', 14.585, 'dev-a', NOW), at('pothole', 14.585, 'dev-b', NOW + 5));
    expect(computeDiff([merged], summarize([{ ...merged, deviceIds: [...merged.deviceIds] }]), NOW + 10)).toEqual([]);
  });
});

describe('reconcile', () => {
  const mine = at('pothole', 14.585, 'dev-a', NOW);
  const theirs = at('pothole', 14.585, 'dev-b', NOW + 1000, 0.95);

  it('first sight: stored as-is, sender is not behind', () => {
    const r = reconcile(undefined, mine);
    expect(r.changed).toBe(true);
    expect(r.senderBehind).toBe(false);
    expect(hazardsEqual(r.merged, mine)).toBe(true);
  });

  it('identical copy: nothing changes and nothing is sent back', () => {
    const r = reconcile(mine, { ...mine });
    expect(r.changed).toBe(false);
    expect(r.senderBehind).toBe(false);
  });

  it('incoming is a strict superset: store changes, sender is not behind', () => {
    const superset = mergeHazard(mine, theirs);
    const r = reconcile(mine, superset);
    expect(r.changed).toBe(true);
    expect(r.senderBehind).toBe(false);
    expect(hazardsEqual(r.merged, superset)).toBe(true);
  });

  it('local state has information the sender lacks: sender must be corrected', () => {
    const both = mergeHazard(mine, theirs);
    const r = reconcile(both, mine);
    expect(r.changed).toBe(false);
    expect(r.senderBehind).toBe(true);
    expect(hazardsEqual(r.merged, both)).toBe(true);
  });

  it('concurrent updates: both sides changed, so both directions have news', () => {
    const r = reconcile(mine, theirs);
    expect(r.merged.deviceIds).toEqual(['dev-a', 'dev-b']);
    expect(r.changed).toBe(true);
    expect(r.senderBehind).toBe(true); // theirs lacks dev-a
  });
});

// ---------------------------------------------------------------------------------------------------
// Protocol-level simulation: replicas run exactly the rules the hub and app run (hello -> diff, then
// "correct the sender"), over a lossless in-order queue, and must end up identical.
// ---------------------------------------------------------------------------------------------------

type Msg = { to: number; from: number; kind: 'hello'; summary: SummaryEntry[] } | { to: number; from: number; kind: 'diff'; hazards: Hazard[] };

function syncUntilQuiet(peers: Map<string, Hazard>[], pairs: [number, number][], now: number): number {
  const queue: Msg[] = [];
  for (const [a, b] of pairs) {
    queue.push({ to: b, from: a, kind: 'hello', summary: summarize(peers[a]!.values(), now) });
    queue.push({ to: a, from: b, kind: 'hello', summary: summarize(peers[b]!.values(), now) });
  }
  let processed = 0;
  while (queue.length > 0) {
    if (++processed > 10_000) throw new Error('sync did not quiesce: correction ping-pong?');
    const m = queue.shift()!;
    const me = peers[m.to]!;
    if (m.kind === 'hello') {
      const hazards = computeDiff(me.values(), m.summary, now);
      if (hazards.length > 0) queue.push({ to: m.from, from: m.to, kind: 'diff', hazards });
    } else {
      const corrections: Hazard[] = [];
      for (const incoming of m.hazards) {
        const r = reconcile(me.get(incoming.id), incoming);
        if (r.changed) me.set(incoming.id, r.merged);
        if (r.senderBehind) corrections.push(r.merged);
      }
      if (corrections.length > 0) queue.push({ to: m.from, from: m.to, kind: 'diff', hazards: corrections });
    }
  }
  return processed;
}

/** Observations with strictly unique timestamps (the documented limitation needs an exact tie). */
function randomObservations(rng: Rng, count: number): Hazard[] {
  const spots = [14.585, 14.5851, 14.586];
  const classes = ['pothole', 'crack', 'flooded_road'] as const;
  const out: Hazard[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      at(pick(rng, classes), pick(rng, spots), pick(rng, ['dev-a', 'dev-b', 'dev-c', 'dev-d']), NOW - Math.floor(rng() * 3 * HOUR_MS) - i, 0.3 + rng() * 0.7),
    );
  }
  return out;
}

describe('replica convergence under the hello/diff + correction rules', () => {
  it('three replicas with disjoint random observations converge after pairwise exchanges', () => {
    const rng = mulberry32(777);
    for (let round = 0; round < 60; round++) {
      const observations = randomObservations(rng, 12);
      const peers: Map<string, Hazard>[] = [new Map(), new Map(), new Map()];
      const expected = new Map<string, Hazard>();

      for (const obs of observations) {
        const peer = peers[Math.floor(rng() * peers.length)]!;
        const r = reconcile(peer.get(obs.id), obs);
        peer.set(obs.id, r.merged);
        const g = reconcile(expected.get(obs.id), obs);
        expected.set(obs.id, g.merged);
      }

      // Hub-and-spoke: peer 0 plays the hub; the others connect to it one after another, then again.
      syncUntilQuiet(peers, [[1, 0]], NOW);
      syncUntilQuiet(peers, [[2, 0]], NOW);
      syncUntilQuiet(peers, [[1, 0]], NOW);

      for (const peer of peers) {
        expect(peer.size).toBe(expected.size);
        for (const [id, h] of expected) expect(hazardsEqual(peer.get(id)!, h)).toBe(true);
      }
    }
  });

  it('random gossip order and a late joiner still converge, and re-running is a no-op', () => {
    const rng = mulberry32(888);
    for (let round = 0; round < 40; round++) {
      const observations = randomObservations(rng, 15);
      const peers: Map<string, Hazard>[] = [new Map(), new Map(), new Map(), new Map()];
      const expected = new Map<string, Hazard>();
      for (const obs of observations) {
        const peer = peers[Math.floor(rng() * 3)]!; // peer 3 starts empty (late joiner)
        peer.set(obs.id, reconcile(peer.get(obs.id), obs).merged);
        expected.set(obs.id, reconcile(expected.get(obs.id), obs).merged);
      }

      const allPairs: [number, number][] = [];
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) allPairs.push([a, b]);
      for (const pair of shuffle(rng, allPairs)) syncUntilQuiet(peers, [pair], NOW);
      for (const pair of shuffle(rng, allPairs)) syncUntilQuiet(peers, [pair], NOW);

      for (const peer of peers) {
        for (const [id, h] of expected) expect(hazardsEqual(peer.get(id)!, h)).toBe(true);
      }
      // converged state is stable: another full round exchanges nothing but hellos
      const messages = syncUntilQuiet(peers, [[0, 1], [1, 2], [2, 3]], NOW);
      expect(messages).toBe(6);
    }
  });

  it('expired hazards are not resurrected by a peer that still holds them', () => {
    const stale = at('flooded_road', 14.587, 'dev-a', NOW - 2 * DAY_MS);
    const fresh = at('pothole', 14.585, 'dev-a', NOW - 1000);
    const peers: Map<string, Hazard>[] = [new Map([[fresh.id, fresh]]), new Map([[stale.id, stale], [fresh.id, fresh]])];
    syncUntilQuiet(peers, [[0, 1]], NOW);
    expect(peers[0]!.has(stale.id)).toBe(false);
  });
});
