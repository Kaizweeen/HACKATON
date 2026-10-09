/**
 * sync.ts: WebSocket client that keeps this phone's store and the hub's store converged.
 *
 *   const sync = new SyncClient({ url, deviceId, store });
 *   sync.start();                       // connects, reconnects forever with backoff
 *   sync.onStatus((s) => ...);          // state, pending count, rtt, ...
 *
 * It never gets in the way of detecting: with the hub unreachable the app keeps writing to IndexedDB, those records
 * are flagged `pending` (the offline queue), and they are pushed the moment a connection is back.
 *
 * Protocol (rules shared with the hub, implemented by @lubak/shared):
 *   on open        send hello{deviceId, summary}; flush pending
 *   hub hello      answer with diff(what the hub is missing or has older)
 *   diff / hazard  apply each with store.applyRemote(); if we hold MORE than we were sent, send the merged state back
 *   our hazards    pending until the hub's echo shows it holds everything we have (see store.ts)
 */

import { computeDiff, diffMessages, encodeWsMessage, parseWsMessage, type Hazard, type WsMessage } from '@lubak/shared';
import type { HazardStore, StoreChange } from './store.js';

export type SyncState = 'idle' | 'connecting' | 'connected' | 'backoff' | 'offline';

export interface SyncStatus {
  state: SyncState;
  url: string;
  /** Consecutive failed attempts since the last good connection. */
  attempt: number;
  retryInMs: number | null;
  everConnected: boolean;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
  rttMs: number | null;
  /** hub clock minus this phone's clock, ms. Large values make the hub reject our hazards as "from the future". */
  clockSkewMs: number | null;
  /** Records waiting for the hub (the offline queue). */
  pending: number;
  sent: number;
  received: number;
  /** Last connection problem, human readable. */
  error: string | null;
}

/** The slice of WebSocket this client needs, so tests can inject a fake. */
export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SyncOptions {
  url: string;
  deviceId: string;
  store: HazardStore;
  log?: (message: string) => void;
  /** Epoch ms. */
  now?: () => number;
  random?: () => number;
  createSocket?: (url: string) => WebSocketLike;
}

const OPEN = 1;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 15_000;
const PING_EVERY_MS = 10_000;
const DEAD_AFTER_MS = 25_000;
const CONNECT_TIMEOUT_MS = 8000;
const FLUSH_EVERY_MS = 10_000;

/** Exponential backoff with +-25% jitter: ~1 s, 2 s, 4 s, 8 s, then 15 s forever. Attempt starts at 1. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + 0.5 * random()));
}

export class SyncClient {
  private readonly store: HazardStore;
  private readonly deviceId: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: (message: string) => void;
  private readonly createSocket: (url: string) => WebSocketLike;

  private url: string;
  private ws: WebSocketLike | null = null;
  private generation = 0;
  private started = false;
  private state: SyncState = 'idle';
  private attempt = 0;
  private retryAt: number | null = null;
  private everConnected = false;
  private lastConnectedAt: number | null = null;
  private lastMessageAt: number | null = null;
  /** Last time anything arrived on THIS connection (or the moment it opened). Drives the dead-connection watchdog. */
  private heardAt = 0;
  private heardSinceOpen = false;
  private rttMs: number | null = null;
  private clockSkewMs: number | null = null;
  private pendingCount = 0;
  private sent = 0;
  private received = 0;
  private error: string | null = null;

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushSoonTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incoming messages are handled strictly in order. */
  private inbox: Promise<void> = Promise.resolve();
  private listeners = new Set<(status: SyncStatus) => void>();
  private cleanup: (() => void)[] = [];

  constructor(options: SyncOptions) {
    this.url = options.url;
    this.deviceId = options.deviceId;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => undefined);
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  }

  get status(): SyncStatus {
    return {
      state: this.state,
      url: this.url,
      attempt: this.attempt,
      retryInMs: this.retryAt === null ? null : Math.max(0, this.retryAt - this.now()),
      everConnected: this.everConnected,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      rttMs: this.rttMs,
      clockSkewMs: this.clockSkewMs,
      pending: this.pendingCount,
      sent: this.sent,
      received: this.received,
      error: this.error,
    };
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.cleanup.push(
      this.store.subscribe((change) => this.onStoreChange(change)),
    );
    if (typeof window !== 'undefined') {
      const retryNow = (): void => {
        if (this.state !== 'connected' && this.state !== 'connecting') this.connect();
      };
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') retryNow();
      };
      window.addEventListener('online', retryNow);
      document.addEventListener('visibilitychange', onVisible);
      this.cleanup.push(
        () => window.removeEventListener('online', retryNow),
        () => document.removeEventListener('visibilitychange', onVisible),
      );
    }
    void this.refreshPending();
    this.connect();
  }

  stop(): void {
    this.started = false;
    for (const c of this.cleanup.splice(0)) c();
    this.generation += 1;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      detach(ws);
      try {
        ws.close(1000, 'client stopping');
      } catch {
        /* already closed */
      }
    }
    this.retryAt = null;
    this.setState('idle');
  }

  setUrl(url: string): void {
    if (url === this.url) return;
    this.url = url;
    this.attempt = 0;
    if (this.started) this.connect();
    else this.emit();
  }

  /** Drop the current connection (if any) and try again immediately. */
  reconnectNow(): void {
    if (!this.started) return;
    this.attempt = 0;
    this.connect();
  }

  // -----------------------------------------------------------------------------------------------
  // connection lifecycle
  // -----------------------------------------------------------------------------------------------

  private connect(): void {
    this.clearTimers();
    const previous = this.ws;
    this.ws = null;
    if (previous) {
      detach(previous);
      try {
        previous.close();
      } catch {
        /* ignore */
      }
    }
    const generation = ++this.generation;
    this.retryAt = null;
    this.heardSinceOpen = false;
    this.setState('connecting');

    let ws: WebSocketLike;
    try {
      ws = this.createSocket(this.url);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      if (generation !== this.generation || ws.readyState === OPEN) return;
      this.error = 'Timed out connecting to the hub.';
      this.dropConnection(generation);
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (generation !== this.generation) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.error = null;
      this.everConnected = true;
      this.lastConnectedAt = this.heardAt = this.now();
      this.setState('connected');
      this.log('connected to the hub');
      void this.sendHello(generation);
      this.sendPing();
      this.pingTimer = setInterval(() => this.heartbeat(generation), PING_EVERY_MS);
      this.flushTimer = setInterval(() => void this.flushPending(), FLUSH_EVERY_MS);
    };
    ws.onmessage = (ev) => {
      if (generation !== this.generation || typeof ev.data !== 'string') return;
      const raw = ev.data;
      this.inbox = this.inbox.then(() => this.handleMessage(raw, generation)).catch((err: unknown) => {
        this.log(`message handler failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    ws.onerror = () => {
      if (generation !== this.generation) return;
      this.error = this.everConnected ? 'Connection to the hub was lost.' : 'Cannot reach the hub. Is it running, and is this phone on its Wi-Fi / hotspot?';
    };
    ws.onclose = () => {
      if (generation !== this.generation) return;
      this.dropConnection(generation);
    };
  }

  private dropConnection(generation: number): void {
    if (generation !== this.generation) return;
    this.generation += 1; // invalidate every callback of the old socket
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      detach(ws);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (this.started) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.attempt += 1;
    const delay = backoffDelayMs(this.attempt, this.random);
    this.retryAt = this.now() + delay;
    this.setState(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'backoff');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.started) this.connect();
    }, delay);
  }

  private clearTimers(): void {
    for (const t of [this.retryTimer, this.connectTimer, this.flushSoonTimer]) if (t) clearTimeout(t);
    for (const t of [this.pingTimer, this.flushTimer]) if (t) clearInterval(t);
    this.retryTimer = this.connectTimer = this.flushSoonTimer = this.pingTimer = this.flushTimer = null;
  }

  private heartbeat(generation: number): void {
    if (generation !== this.generation) return;
    if (this.now() - this.heardAt > DEAD_AFTER_MS) {
      // A hotspot can vanish without the socket ever closing. No answer for 25 s means it is gone.
      this.error = 'The hub stopped answering.';
      this.log('hub stopped answering; reconnecting');
      this.dropConnection(generation);
      return;
    }
    this.sendPing();
  }

  // -----------------------------------------------------------------------------------------------
  // sending
  // -----------------------------------------------------------------------------------------------

  private send(message: WsMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(encodeWsMessage(message));
    this.sent += message.type === 'diff' ? message.hazards.length : message.type === 'hazard' ? 1 : 0;
    return true;
  }

  private sendPing(): void {
    this.send({ type: 'ping', t: this.now() });
  }

  private async sendHello(generation: number): Promise<void> {
    const summary = await this.store.summary(this.now());
    if (generation !== this.generation) return;
    this.send({ type: 'hello', deviceId: this.deviceId, summary });
    await this.flushPending();
  }

  private sendHazards(hazards: readonly Hazard[]): void {
    if (hazards.length === 1) this.send({ type: 'hazard', hazard: hazards[0]! });
    else for (const m of diffMessages(hazards)) this.send(m);
  }

  /** Push the offline queue. Harmless to call often: the hub's echo is what clears the pending flags. */
  async flushPending(): Promise<void> {
    if (this.state !== 'connected') return;
    const pending = await this.store.getPending(this.now());
    if (pending.length > 0) this.sendHazards(pending);
    await this.refreshPending();
  }

  private onStoreChange(change: StoreChange): void {
    if (change.kind === 'upsert' && change.origin === 'local') {
      if (this.flushSoonTimer) clearTimeout(this.flushSoonTimer);
      this.flushSoonTimer = setTimeout(() => {
        this.flushSoonTimer = null;
        void this.flushPending();
      }, 30);
    }
    void this.refreshPending();
  }

  private async refreshPending(): Promise<void> {
    const count = await this.store.pendingCount(this.now());
    if (count !== this.pendingCount) {
      this.pendingCount = count;
      this.emit();
    }
  }

  // -----------------------------------------------------------------------------------------------
  // receiving
  // -----------------------------------------------------------------------------------------------

  private async handleMessage(raw: string, generation: number): Promise<void> {
    const parsed = parseWsMessage(raw, { now: this.now() });
    if (!parsed.ok || generation !== this.generation) return;
    this.lastMessageAt = this.heardAt = this.now();
    if (!this.heardSinceOpen) {
      this.heardSinceOpen = true;
      this.attempt = 0; // the hub really answered: forgive earlier failures
    }
    const message = parsed.message;

    switch (message.type) {
      case 'hello': {
        const missing = computeDiff(await this.store.getAll(this.now()), message.summary, this.now());
        for (const m of diffMessages(missing)) this.send(m);
        break;
      }
      case 'diff':
      case 'hazard': {
        const incoming = message.type === 'diff' ? message.hazards : [message.hazard];
        const corrections: Hazard[] = [];
        for (const h of incoming) {
          const result = await this.store.applyRemote(h, this.now());
          this.received += 1;
          if (result.senderBehind) corrections.push(result.hazard); // we know more than the hub: tell it
        }
        if (corrections.length > 0) this.sendHazards(corrections);
        await this.refreshPending();
        break;
      }
      case 'ping': {
        if (message.ack) {
          this.rttMs = Math.max(0, this.now() - message.t);
          if (message.serverTime !== undefined) this.clockSkewMs = message.serverTime - (message.t + this.rttMs / 2);
        } else {
          this.send({ type: 'ping', t: message.t, ack: true });
        }
        break;
      }
      default: {
        const unreachable: never = message;
        void unreachable;
      }
    }
    this.emit();
  }

  // -----------------------------------------------------------------------------------------------
  // status
  // -----------------------------------------------------------------------------------------------

  private setState(state: SyncState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    const status = this.status;
    for (const l of this.listeners) {
      try {
        l(status);
      } catch (err) {
        console.error('sync status listener failed:', err);
      }
    }
  }
}

function detach(ws: WebSocketLike): void {
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
}
