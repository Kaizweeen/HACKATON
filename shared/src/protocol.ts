/**
 * WebSocket protocol between a device (phone, fake device) and the hub. Both directions use the same
 * four messages, discriminated by `type`:
 *
 *   hello   { deviceId, summary }   "this is what I have" (sent by BOTH sides right after connecting)
 *   diff    { hazards }             hazards the receiver is missing or has older (also used as ack/correction)
 *   hazard  { hazard }              a single live update
 *   ping    { t, ack? }             keep-alive. Receiver answers a ping with `ack: true` (never answers an ack).
 *
 * Handshake: A sends hello(summaryA); B answers with diff(computeDiff(B, summaryA)). B also sends its own
 * hello, A answers likewise. Whenever a receiver ends up with MORE than what it was sent (reconcile().senderBehind)
 * it sends the merged hazard back, so a single exchange converges both sides.
 */

import type { Hazard } from './hazard.js';
import { sanitizeHazard, type RejectReason } from './validate.js';
import type { SummaryEntry } from './summary.js';

export const WS_PATH = '/ws';
/** Query parameter that carries the hub's optional event PIN (`wss://<hub>/ws?pin=...`, `/api/hazards?pin=...`). */
export const HUB_PIN_PARAM = 'pin';
/** WebSocket close code the hub uses when the event PIN is missing or wrong (4000-4999 are for applications). */
export const WS_CLOSE_PIN_REQUIRED = 4401;
/** deviceId the hub uses in its own hello. */
export const HUB_DEVICE_ID = 'hub';

/** Hard cap on one frame; the hub configures `ws` with this. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Senders split large diffs into messages of at most this many hazards. */
export const MAX_HAZARDS_PER_DIFF = 500;
/** Receivers reject a summary bigger than this. */
export const MAX_SUMMARY_ENTRIES = 50_000;

export interface HelloMessage {
  type: 'hello';
  deviceId: string;
  summary: SummaryEntry[];
}

export interface DiffMessage {
  type: 'diff';
  hazards: Hazard[];
}

export interface HazardMessage {
  type: 'hazard';
  hazard: Hazard;
}

export interface PingMessage {
  type: 'ping';
  /** Sender's clock, epoch ms. An ack echoes it back so the sender can measure round-trip time. */
  t: number;
  /** True when this ping is the answer to a ping. */
  ack?: boolean;
  /** Only on acks sent by the hub: the hub's clock, so devices can warn about clock skew. */
  serverTime?: number;
}

export type WsMessage = HelloMessage | DiffMessage | HazardMessage | PingMessage;
export type WsMessageType = WsMessage['type'];

export function encodeWsMessage(message: WsMessage): string {
  return JSON.stringify(message);
}

/** Split hazards into diff messages no larger than MAX_HAZARDS_PER_DIFF. */
export function diffMessages(hazards: readonly Hazard[], chunkSize: number = MAX_HAZARDS_PER_DIFF): DiffMessage[] {
  const out: DiffMessage[] = [];
  for (let i = 0; i < hazards.length; i += chunkSize) {
    out.push({ type: 'diff', hazards: hazards.slice(i, i + chunkSize) });
  }
  return out;
}

export type ParseResult =
  | {
      ok: true;
      message: WsMessage;
      /** Reasons for any individual hazards dropped from a diff / hazard message because they failed validation. */
      rejected: RejectReason[];
    }
  | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse and validate one text frame. Never throws. Hazards inside are re-canonicalised by sanitizeHazard
 * (pass `now` to enable the future-timestamp guard). A `diff` with some bad hazards still parses: the bad ones
 * are dropped and listed in `rejected`. A `hazard` whose hazard is invalid fails as a whole.
 */
export function parseWsMessage(raw: string, opts: { now?: number } = {}): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!isRecord(data)) return { ok: false, reason: 'not-an-object' };

  switch (data['type']) {
    case 'hello': {
      const deviceId = data['deviceId'];
      const summary = data['summary'];
      if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 64) {
        return { ok: false, reason: 'bad-device-id' };
      }
      if (!Array.isArray(summary) || summary.length > MAX_SUMMARY_ENTRIES) {
        return { ok: false, reason: 'bad-summary' };
      }
      const entries: SummaryEntry[] = [];
      for (const e of summary) {
        if (!isRecord(e) || typeof e['id'] !== 'string' || typeof e['lastSeen'] !== 'number' || !Number.isFinite(e['lastSeen'])) {
          return { ok: false, reason: 'bad-summary-entry' };
        }
        const d = e['d'];
        entries.push({
          id: e['id'],
          lastSeen: e['lastSeen'],
          d: typeof d === 'string' && d.length <= 32 ? d : '',
        });
      }
      return { ok: true, message: { type: 'hello', deviceId, summary: entries }, rejected: [] };
    }

    case 'diff': {
      const list = data['hazards'];
      if (!Array.isArray(list) || list.length > MAX_HAZARDS_PER_DIFF * 20) return { ok: false, reason: 'bad-hazards' };
      const hazards: Hazard[] = [];
      const rejected: RejectReason[] = [];
      for (const item of list) {
        const result = sanitizeHazard(item, opts);
        if (result.ok) hazards.push(result.hazard);
        else rejected.push(result.reason);
      }
      return { ok: true, message: { type: 'diff', hazards }, rejected };
    }

    case 'hazard': {
      const result = sanitizeHazard(data['hazard'], opts);
      if (!result.ok) return { ok: false, reason: `bad-hazard:${result.reason}` };
      return { ok: true, message: { type: 'hazard', hazard: result.hazard }, rejected: [] };
    }

    case 'ping': {
      const t = data['t'];
      if (typeof t !== 'number' || !Number.isFinite(t)) return { ok: false, reason: 'bad-ping' };
      const message: PingMessage = { type: 'ping', t };
      if (data['ack'] === true) message.ack = true;
      const serverTime = data['serverTime'];
      if (typeof serverTime === 'number' && Number.isFinite(serverTime)) message.serverTime = serverTime;
      return { ok: true, message, rejected: [] };
    }

    default:
      return { ok: false, reason: 'unknown-type' };
  }
}
