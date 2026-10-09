/**
 * Anti-entropy helpers: the compact "what do I have" summary sent in `hello`, and the diff a peer
 * computes from it.
 *
 * Each summary entry is (id, lastSeen) as specified, plus `d`, a content digest. `d` is needed because
 * `lastSeen` alone cannot reveal a missing confirmation: a late-arriving report from another phone can add
 * a deviceId (or a higher confidence) without raising lastSeen, and then two replicas would look identical
 * while differing. Entries from peers that omit `d` read as d = '' which never matches, so they are over-sent to, never under-sent.
 */

import { hazardDigest, isExpired, type Hazard } from './hazard.js';

export interface SummaryEntry {
  id: string;
  lastSeen: number;
  /** hazardDigest() of the sender's copy. */
  d: string;
}

/** Summary of a collection. Pass `now` to leave out expired hazards. */
export function summarize(hazards: Iterable<Hazard>, now?: number): SummaryEntry[] {
  const out: SummaryEntry[] = [];
  for (const h of hazards) {
    if (now !== undefined && isExpired(h, now)) continue;
    out.push({ id: h.id, lastSeen: h.lastSeen, d: hazardDigest(h) });
  }
  return out;
}

/**
 * Hazards the remote peer is missing or has older, judged from its summary:
 * absent, or lower lastSeen, or the same lastSeen but different content.
 * Expired hazards are never offered. A peer that is AHEAD gets its turn through its own hello, and any
 * side that turns out to hold more than it was sent corrects the sender (see reconcile()).
 */
export function computeDiff(local: Iterable<Hazard>, remote: readonly SummaryEntry[], now: number): Hazard[] {
  const known = new Map<string, SummaryEntry>();
  for (const e of remote) known.set(e.id, e);

  const out: Hazard[] = [];
  for (const h of local) {
    if (isExpired(h, now)) continue;
    const theirs = known.get(h.id);
    if (
      theirs === undefined ||
      theirs.lastSeen < h.lastSeen ||
      (theirs.lastSeen === h.lastSeen && theirs.d !== hazardDigest(h))
    ) {
      out.push(h);
    }
  }
  return out;
}
