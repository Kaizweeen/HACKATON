# @lubak/shared — the contract

Written once, imported by both the **app** (`import { mergeHazard } from '@lubak/shared'`) and the **hub**.
Pure TypeScript, zero runtime dependencies, runs in browsers and Node. Run its tests with `npm test` from the repo root.

If you change anything here, change it for everyone: it is the agreement between phones and hub.

## The `Hazard` record

| field | meaning |
| --- | --- |
| `id` | deterministic: `` `${geohash}:${cls}` `` — two phones seeing the same spot produce the same id |
| `cls` | `pothole` \| `crack` \| `flooded_road` (this order **is** the model's class-index order) |
| `geohash` | `encodeGeohash(lat, lon, 8)`; a precision-8 cell is about 37 m × 19 m near Antipolo |
| `lat`, `lon` | position of the highest-confidence observation |
| `confidence` | max confidence seen, 0..1 |
| `deviceIds` | random per-install ids that confirmed it; a **set** (kept sorted + unique) |
| `firstSeen`, `lastSeen` | epoch ms of earliest / latest observation |
| `ttlMs` | derived from `cls`: `flooded_road` 6 h, `pothole` and `crack` 21 days |

Confirmation count is `deviceIds.length` (`confirmationCount(h)`), so one phone re-reporting a pothole never inflates it.
Build new hazards **only** with `createHazard()` so id / geohash / ttl are always derived the same way.

## `mergeHazard(a, b)` — commutative, associative, idempotent

| field | rule |
| --- | --- |
| `deviceIds` | set union |
| `confidence` | max |
| `firstSeen` / `lastSeen` | min / max |
| `ttlMs` | max (always equal on valid records) |
| `lat` / `lon` | taken from the observation that is the lexicographic max of `(confidence, -lat, -lon)` — a total order, so the winner never depends on argument order |

Every field uses a join-semilattice operation, so replicas converge whatever the delivery order, grouping or repetition.
`test/hazard.test.ts` checks the three laws over hundreds of seeded random cases (ties included) plus convergence under shuffled and duplicated deliveries.
Merging hazards with different ids throws — it is a programming error, not data.

`isExpired(h, now)` is `now >= h.lastSeen + h.ttlMs` (inclusive). A fresher sighting merged in extends life; an older one never shortens it.
Expired hazards are never offered in a diff and are dropped on arrival, so sync cannot resurrect them. Both sides sweep them locally; there is no delete message.

## WebSocket protocol (`src/protocol.ts`)

A discriminated union on `type`, the same four messages in both directions:

| type | payload | meaning |
| --- | --- | --- |
| `hello` | `deviceId`, `summary: {id, lastSeen, d}[]` | "this is what I have". **Both** sides send one right after connecting |
| `diff` | `hazards[]` | hazards the receiver is missing or has older. Also used as ack / correction |
| `hazard` | `hazard` | one live update |
| `ping` | `t`, `ack?`, `serverTime?` | keep-alive; answer a ping with `ack: true`, never answer an ack |

Rules both hub and app follow (the shared functions implement them):

1. On `hello`, reply with `diff(computeDiff(mine, theirSummary, now))` — only if non-empty.
2. On `diff` / `hazard`, run `reconcile(existing, incoming)` per hazard: store `merged` if `changed`; if `senderBehind` (you hold more than you were sent) send `merged` back.
3. The hub additionally echoes the merged state to the sender (that is the ack that lets a phone clear its pending flag) and broadcasts changes to everyone else.
4. Validate everything from the wire with `parseWsMessage` / `sanitizeHazard`. They re-derive `id` and `ttlMs`, so a client cannot invent an immortal hazard.

### Deviation from the brief: the summary carries a digest `d`

The brief says the summary is "id and lastSeen pairs". `lastSeen` alone cannot reveal a missing confirmation: a late report from a
phone that was offline adds a deviceId without raising `lastSeen`, so two replicas look identical while differing.
Each entry therefore also carries `d = hazardDigest(h)`, a 53-bit content hash. With it the protocol converges for any pair of replicas
(see the simulation tests in `test/summary.test.ts`, which failed before this change). Peers that omit `d` still work; they just receive more data.

## Known limits (by design, for the hackathon)

* **No auth.** Anyone on the hotspot can post hazards. Input is validated and size-capped, not authenticated.
* **Cell-boundary duplicates.** A pothole near a geohash cell edge, seen by phones with different GPS error, can become two hazards. The id is deterministic by spec; merging neighbouring cells is future work.
* **Camera sees ahead of the phone.** The reported position is the phone's, not the pothole's. A real deployment needs a lookahead offset along the heading.
* **Clocks.** Records from more than 10 minutes in the future are rejected (the app's Debug panel shows the skew to the hub).
