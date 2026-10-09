import { describe, expect, it } from 'vitest';
import {
  createHazard,
  diffMessages,
  hazardDigest,
  encodeWsMessage,
  HUB_DEVICE_ID,
  LIMITS,
  MAX_HAZARDS_PER_DIFF,
  parseWsMessage,
  sanitizeHazard,
  TTL_MS,
  type Hazard,
  type WsMessage,
} from '../src/index.js';

const NOW = 1_760_000_000_000;
const hazard = (over: Partial<Parameters<typeof createHazard>[0]> = {}): Hazard =>
  createHazard({ cls: 'pothole', lat: 14.585, lon: 121.176, confidence: 0.8, deviceId: 'dev-a', now: NOW, ...over });

const roundTrip = (m: WsMessage) => parseWsMessage(encodeWsMessage(m));

describe('WebSocket messages', () => {
  it('round-trips each of the four message types', () => {
    const h = hazard();
    const messages: WsMessage[] = [
      { type: 'hello', deviceId: 'dev-a', summary: [{ id: h.id, lastSeen: h.lastSeen, d: hazardDigest(h) }] },
      { type: 'diff', hazards: [h] },
      { type: 'hazard', hazard: h },
      { type: 'ping', t: NOW },
    ];
    for (const m of messages) {
      const parsed = roundTrip(m);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.message).toEqual(m);
    }
  });

  it('is a closed discriminated union (the switch below only compiles if all four types are handled)', () => {
    const describeMessage = (m: WsMessage): string => {
      switch (m.type) {
        case 'hello':
          return `hello from ${m.deviceId} with ${m.summary.length} entries`;
        case 'diff':
          return `diff of ${m.hazards.length}`;
        case 'hazard':
          return `hazard ${m.hazard.id}`;
        case 'ping':
          return m.ack ? 'pong' : 'ping';
        default: {
          const unreachable: never = m;
          return unreachable;
        }
      }
    };
    expect(describeMessage({ type: 'ping', t: 1, ack: true })).toBe('pong');
    expect(HUB_DEVICE_ID).toBe('hub');
  });

  it('rejects garbage without throwing', () => {
    for (const raw of ['', 'not json', '[]', '42', 'null', '{}', '{"type":"nope"}', '{"type":"hello"}', '{"type":"ping"}']) {
      expect(parseWsMessage(raw).ok).toBe(false);
    }
  });

  it('hello: validates deviceId and summary, and reads a missing digest as "" (never matches, so it is over-sent to)', () => {
    expect(parseWsMessage('{"type":"hello","deviceId":"","summary":[]}').ok).toBe(false);
    expect(parseWsMessage('{"type":"hello","deviceId":"x","summary":"nope"}').ok).toBe(false);
    expect(parseWsMessage('{"type":"hello","deviceId":"x","summary":[{"id":1,"lastSeen":2}]}').ok).toBe(false);
    const legacy = parseWsMessage('{"type":"hello","deviceId":"x","summary":[{"id":"a:b","lastSeen":5}]}');
    expect(legacy.ok && legacy.message.type === 'hello' && legacy.message.summary[0]?.d).toBe('');
  });

  it('ping: ack and serverTime survive; an ack is distinguishable from a ping', () => {
    const p = parseWsMessage('{"type":"ping","t":7,"ack":true,"serverTime":9}');
    expect(p.ok && p.message).toEqual({ type: 'ping', t: 7, ack: true, serverTime: 9 });
    const q = parseWsMessage('{"type":"ping","t":7}');
    expect(q.ok && q.message).toEqual({ type: 'ping', t: 7 });
  });

  it('diff: drops invalid hazards individually and reports why', () => {
    const good = hazard();
    const bad = { ...good, lat: 999 };
    const raw = JSON.stringify({ type: 'diff', hazards: [good, bad, 'junk'] });
    const parsed = parseWsMessage(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'diff') {
      expect(parsed.message.hazards).toEqual([good]);
      expect(parsed.rejected).toEqual(['bad-coordinates', 'not-an-object']);
    }
  });

  it('hazard: an invalid hazard fails the whole message', () => {
    const raw = JSON.stringify({ type: 'hazard', hazard: { ...hazard(), confidence: 5 } });
    expect(parseWsMessage(raw)).toEqual({ ok: false, reason: 'bad-hazard:bad-confidence' });
  });

  it('diffMessages splits large lists into bounded messages', () => {
    const many = Array.from({ length: MAX_HAZARDS_PER_DIFF * 2 + 3 }, (_, i) => hazard({ lat: 14 + i * 0.001 }));
    const parts = diffMessages(many);
    expect(parts.map((p) => p.hazards.length)).toEqual([MAX_HAZARDS_PER_DIFF, MAX_HAZARDS_PER_DIFF, 3]);
    expect(diffMessages([])).toEqual([]);
  });
});

describe('sanitizeHazard: the hub trusts nothing from the wire', () => {
  it('re-derives ttlMs so a client cannot make a hazard immortal', () => {
    const forged = { ...hazard({ cls: 'flooded_road' }), ttlMs: Number.MAX_SAFE_INTEGER };
    const r = sanitizeHazard(forged);
    expect(r.ok && r.hazard.ttlMs).toBe(TTL_MS.flooded_road);
  });

  it('canonicalises deviceIds (sorted, unique)', () => {
    const r = sanitizeHazard({ ...hazard(), deviceIds: ['b', 'a', 'b'] });
    expect(r.ok && r.hazard.deviceIds).toEqual(['a', 'b']);
  });

  it.each([
    ['not an object', 'text', 'not-an-object'],
    ['unknown class', { ...hazard(), cls: 'sinkhole' }, 'bad-class'],
    ['latitude out of range', { ...hazard(), lat: 91 }, 'bad-coordinates'],
    ['longitude is a string', { ...hazard(), lon: '121.1' }, 'bad-coordinates'],
    ['null coordinate (what JSON makes of NaN)', { ...hazard(), lat: null }, 'bad-coordinates'],
    ['geohash does not match lat/lon', { ...hazard(), lat: 10, lon: 10 }, 'geohash-mismatch'],
    ['malformed geohash', { ...hazard(), geohash: 'zzzz' }, 'bad-geohash'],
    ['id does not match geohash+class', { ...hazard(), id: 'x:pothole' }, 'id-mismatch'],
    ['confidence above 1', { ...hazard(), confidence: 1.01 }, 'bad-confidence'],
    ['lastSeen before firstSeen', { ...hazard(), firstSeen: 10, lastSeen: 5 }, 'bad-timestamps'],
    ['no deviceIds', { ...hazard(), deviceIds: [] }, 'bad-device-ids'],
    ['non-string deviceId', { ...hazard(), deviceIds: [1] }, 'bad-device-ids'],
    ['oversized deviceId', { ...hazard(), deviceIds: ['x'.repeat(LIMITS.maxDeviceIdLength + 1)] }, 'bad-device-ids'],
    ['too many deviceIds', { ...hazard(), deviceIds: Array.from({ length: LIMITS.maxDeviceIdsPerHazard + 1 }, (_, i) => `d${i}`) }, 'bad-device-ids'],
  ])('rejects: %s', (_label, input, reason) => {
    expect(sanitizeHazard(input)).toEqual({ ok: false, reason });
  });

  it('rejects timestamps from the future only when a clock is supplied (clock-skew guard)', () => {
    const future = hazard({ now: NOW + LIMITS.maxFutureSkewMs + 1000 });
    expect(sanitizeHazard(future).ok).toBe(true);
    expect(sanitizeHazard(future, { now: NOW })).toEqual({ ok: false, reason: 'from-the-future' });
    expect(sanitizeHazard(hazard({ now: NOW + 1000 }), { now: NOW }).ok).toBe(true);
  });

  it('does not rewrite valid records: sanitize is the identity on canonical hazards', () => {
    const h = hazard();
    const r = sanitizeHazard(JSON.parse(JSON.stringify(h)));
    expect(r.ok && r.hazard).toEqual(h);
  });
});
