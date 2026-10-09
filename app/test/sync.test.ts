import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHazard, hazardDigest, mergeHazard, WS_CLOSE_PIN_REQUIRED, type Hazard, type WsMessage } from '@lubak/shared';
import { HazardStore } from '../src/store.js';
import { BACKOFF_MAX_MS, backoffDelayMs, SyncClient, type WebSocketLike } from '../src/sync.js';

/** A WebSocket we control by hand. close() on the client side does not fire onclose, like a browser after we detach handlers. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: WsMessage[] = [];
  closedByClient = false;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as WsMessage);
  }
  close(): void {
    this.readyState = 3;
    this.closedByClient = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: WsMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({ code: 1006 });
  }
  of<T extends WsMessage['type']>(type: T): Extract<WsMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<WsMessage, { type: T }> => m.type === type);
  }
}

const T0 = 1_760_000_000_000;
const mk = (deviceId: string, over: Partial<Parameters<typeof createHazard>[0]> = {}): Hazard =>
  createHazard({ cls: 'pothole', lat: 14.585, lon: 121.176, confidence: 0.7, deviceId, now: Date.now(), ...over });

function rig(url = 'wss://hub.test/ws') {
  const store = HazardStore.inMemory();
  const sockets: FakeSocket[] = [];
  const client = new SyncClient({
    url,
    deviceId: 'dev-me',
    store,
    random: () => 0.5, // jitter factor exactly 1, so delays are 1 s, 2 s, 4 s ...
    createSocket: (u) => {
      const s = new FakeSocket(u);
      sockets.push(s);
      return s;
    },
  });
  return { store, sockets, client, last: () => sockets[sockets.length - 1]! };
}

const settle = async (ms = 50): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('backoffDelayMs', () => {
  it('doubles from 1 s up to a 15 s ceiling, with +-25% jitter', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelayMs(n, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(backoffDelayMs(3, () => 0)).toBe(3000);
    expect(backoffDelayMs(3, () => 1)).toBe(5000);
  });
});

describe('SyncClient: handshake', () => {
  it('connects, says hello with its summary, and pushes the offline queue', async () => {
    const { store, client, last, sockets } = rig();
    const queued = mk('dev-me');
    await store.putLocal(queued); // detected while the hub was unreachable
    const old = mk('dev-me', { lat: 14.6, now: Date.now() - 1000 });
    await store.applyRemote(old); // already known by the hub

    client.start();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://hub.test/ws');
    expect(client.status.state).toBe('connecting');

    last().open();
    await settle();
    expect(client.status.state).toBe('connected');

    const [hello] = last().of('hello');
    expect(hello).toMatchObject({ type: 'hello', deviceId: 'dev-me' });
    expect(hello!.summary.map((e) => e.id).sort()).toEqual([queued.id, old.id].sort());
    expect(hello!.summary.find((e) => e.id === queued.id)?.d).toBe(hazardDigest(queued));

    expect(last().of('hazard').map((m) => m.hazard.id)).toEqual([queued.id]); // only the pending one
    client.stop();
  });

  it('answers the hub\'s hello with exactly what the hub is missing or has older', async () => {
    const { store, client, last } = rig();
    const known = mk('dev-me', { lat: 14.585 });
    const unknown = mk('dev-me', { lat: 14.59 });
    await store.applyRemote(known);
    await store.applyRemote(unknown);
    client.start();
    last().open();
    await settle();
    last().sent.length = 0;

    last().receive({ type: 'hello', deviceId: 'hub', summary: [{ id: known.id, lastSeen: known.lastSeen, d: hazardDigest(known) }] });
    await settle();
    const diffs = last().of('diff');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.hazards.map((h) => h.id)).toEqual([unknown.id]);
    client.stop();
  });

  it('stays quiet when the hub already has everything', async () => {
    const { store, client, last } = rig();
    const h = mk('dev-me');
    await store.applyRemote(h);
    client.start();
    last().open();
    await settle();
    last().sent.length = 0;
    last().receive({ type: 'hello', deviceId: 'hub', summary: [{ id: h.id, lastSeen: h.lastSeen, d: hazardDigest(h) }] });
    await settle();
    expect(last().sent).toEqual([]);
    client.stop();
  });
});

describe('SyncClient: data flow', () => {
  it('sends a live detection immediately, and the hub echo clears the pending flag', async () => {
    const { store, client, last } = rig();
    client.start();
    last().open();
    await settle();
    last().sent.length = 0;

    const h = mk('dev-me');
    await store.putLocal(h);
    await settle(100);
    expect(last().of('hazard').map((m) => m.hazard.id)).toEqual([h.id]);
    expect(client.status.pending).toBe(1);

    last().receive({ type: 'hazard', hazard: h }); // hub echoes the merged state back
    await settle();
    expect(client.status.pending).toBe(0);
    expect(await store.getPending()).toEqual([]);
    client.stop();
  });

  it('applies hazards from other phones to the local store', async () => {
    const { store, client, last } = rig();
    client.start();
    last().open();
    await settle();
    const theirs = mk('dev-other', { lat: 14.6 });
    last().receive({ type: 'hazard', hazard: theirs });
    last().receive({ type: 'diff', hazards: [mk('dev-other', { lat: 14.61 }), mk('dev-other', { lat: 14.62 })] });
    await settle();
    expect((await store.getAll()).length).toBe(3);
    expect(await store.getPending()).toEqual([]); // received data is not queued for sending
    expect(client.status.received).toBe(3);
    client.stop();
  });

  it('corrects a hub that is behind: sends the merged state back and keeps it pending until acked', async () => {
    const { store, client, last } = rig();
    const mine = mk('dev-me');
    const theirs = mk('dev-other', { now: Date.now() + 500 });
    await store.putLocal(mine);
    client.start();
    last().open();
    await settle();
    last().sent.length = 0;

    last().receive({ type: 'hazard', hazard: theirs }); // the hub only knows dev-other's sighting
    await settle();
    const corrections = last().of('hazard');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.hazard.deviceIds).toEqual(['dev-me', 'dev-other']);
    expect(client.status.pending).toBe(1);

    last().receive({ type: 'hazard', hazard: mergeHazard(mine, theirs) }); // hub now holds both
    await settle();
    expect(client.status.pending).toBe(0);
    client.stop();
  });

  it('works fully while the hub is unreachable: detections queue in the store and flush on the next connection', async () => {
    const { store, client, sockets, last } = rig();
    client.start();
    sockets[0]!.drop(); // hub down
    expect(client.status.state).toBe('backoff');

    const queued = [mk('dev-me', { lat: 14.585 }), mk('dev-me', { lat: 14.586 }), mk('dev-me', { lat: 14.587 })];
    for (const h of queued) await store.putLocal(h);
    expect(await store.pendingCount()).toBe(3);
    expect(client.status.pending).toBe(3);

    await settle(1000); // retry after 1 s
    expect(sockets).toHaveLength(2);
    last().open();
    await settle();
    const sentIds = last().of('diff').flatMap((m) => m.hazards.map((h) => h.id));
    expect(sentIds.sort()).toEqual(queued.map((h) => h.id).sort());

    last().receive({ type: 'diff', hazards: queued }); // hub acks all three
    await settle();
    expect(client.status.pending).toBe(0);
    client.stop();
  });

  it('ignores garbage, binary frames and data that has already expired', async () => {
    const { store, client, last } = rig();
    client.start();
    last().open();
    await settle();
    last().receiveRaw('not json');
    last().receiveRaw(new ArrayBuffer(8));
    last().receiveRaw(JSON.stringify({ type: 'weird' }));
    last().receive({ type: 'hazard', hazard: { ...mk('dev-other', { cls: 'flooded_road' }), firstSeen: 1, lastSeen: 2 } }); // from 1970
    await settle();
    expect(await store.getAll()).toEqual([]);
    expect(client.status.state).toBe('connected');
    client.stop();
  });
});

describe('SyncClient: reconnect', () => {
  it('retries with exponential backoff and resets once the hub actually answers', async () => {
    const { client, sockets, last } = rig();
    client.start();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      last().drop();
      delays.push(client.status.retryInMs!);
      await settle(client.status.retryInMs!);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(sockets).toHaveLength(5);
    expect(client.status.attempt).toBe(4);

    last().open();
    await settle();
    expect(client.status.attempt).toBe(4); // an open socket alone proves nothing
    last().receive({ type: 'hello', deviceId: 'hub', summary: [] });
    await settle();
    expect(client.status.attempt).toBe(0);

    last().drop();
    expect(client.status.retryInMs).toBe(1000); // back to the short delay
    client.stop();
  });

  it('notices a connection that went silent (hotspot vanished without closing the socket) and reconnects', async () => {
    const { client, sockets, last } = rig();
    client.start();
    last().open();
    await settle();
    last().receive({ type: 'hello', deviceId: 'hub', summary: [] });
    await settle(31_000); // nothing ever arrives again, not even ping acks: the 30 s heartbeat finds it dead
    expect(client.status.error).toMatch(/stopped answering/);
    expect(sockets.length).toBeGreaterThanOrEqual(2); // and a fresh attempt is already under way
    client.stop();
  });

  it('also notices a hub that accepts the socket and never says a word', async () => {
    const { client, sockets, last } = rig();
    client.start();
    last().open();
    await settle(40_000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    client.stop();
  });

  it('gives up on a connect attempt that hangs', async () => {
    const { client, sockets } = rig();
    client.start();
    await settle(9000); // socket never opens
    expect(client.status.error).toMatch(/timed out/i);
    await settle(2000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    client.stop();
  });

  it('keeps the connection alive with pings and measures round trip time and clock skew from the ack', async () => {
    const { client, last } = rig();
    client.start();
    last().open();
    await settle(1);
    const ping = last().of('ping')[0]!;
    expect(ping.ack).toBeUndefined();
    await settle(40); // 40 ms round trip
    last().receive({ type: 'ping', t: ping.t, ack: true, serverTime: ping.t + 20 + 5000 }); // hub clock is 5 s ahead
    await settle(1);
    expect(client.status.rttMs).toBeGreaterThanOrEqual(40);
    expect(client.status.rttMs).toBeLessThan(60);
    expect(client.status.clockSkewMs).toBeGreaterThan(4900);
    expect(client.status.clockSkewMs).toBeLessThan(5100);

    last().sent.length = 0;
    last().receive({ type: 'ping', t: 99 }); // a ping from the hub is answered with an ack
    await settle(1);
    expect(last().of('ping')).toEqual([{ type: 'ping', t: 99, ack: true }]);

    last().sent.length = 0;
    await settle(10_000);
    expect(last().of('ping').length).toBeGreaterThanOrEqual(1); // periodic ping
    client.stop();
  });
});

describe('SyncClient: control', () => {
  it('stop() closes the socket and never retries', async () => {
    const { client, sockets, last } = rig();
    client.start();
    last().open();
    await settle();
    const socket = last();
    client.stop();
    expect(socket.closedByClient).toBe(true);
    expect(client.status.state).toBe('idle');
    await settle(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('setUrl reconnects to the new address and reconnectNow skips the wait', async () => {
    const { client, sockets, last } = rig();
    client.start();
    last().drop();
    expect(client.status.state).toBe('backoff');
    client.reconnectNow();
    expect(sockets).toHaveLength(2);
    expect(client.status.state).toBe('connecting');

    client.setUrl('wss://other.test/ws');
    expect(sockets).toHaveLength(3);
    expect(last().url).toBe('wss://other.test/ws');
    expect(sockets[1]!.closedByClient).toBe(true);
    client.stop();
  });

  it('dials with the event PIN but never shows it, says plainly when the hub refuses it, and retries slowly until it changes', async () => {
    const store = HazardStore.inMemory();
    const sockets: FakeSocket[] = [];
    const client = new SyncClient({
      url: 'wss://hub.test/ws',
      pin: 'antipolo-26',
      deviceId: 'dev-me',
      store,
      random: () => 0.5,
      createSocket: (u) => {
        const s = new FakeSocket(u);
        sockets.push(s);
        return s;
      },
    });
    client.start();
    expect(sockets[0]!.url).toBe('wss://hub.test/ws?pin=antipolo-26');
    expect(client.status.url).toBe('wss://hub.test/ws');

    // the hub completes the handshake, then closes with 4401
    sockets[0]!.open();
    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: WS_CLOSE_PIN_REQUIRED, reason: 'event PIN required' });
    expect(client.status.state).toBe('backoff');
    expect(client.status.error).toMatch(/refused this event PIN/);
    expect(client.status.retryInMs).toBe(BACKOFF_MAX_MS); // not 1 s: retrying fast cannot fix a PIN

    client.setPin('the-right-one');
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toBe('wss://hub.test/ws?pin=the-right-one');
    sockets[1]!.open();
    expect(client.status.state).toBe('connected');
    expect(client.status.error).toBeNull();

    client.setPin(null);
    expect(sockets[2]!.url).toBe('wss://hub.test/ws');
    sockets[2]!.open();
    sockets[2]!.readyState = 3;
    sockets[2]!.onclose?.({ code: WS_CLOSE_PIN_REQUIRED });
    expect(client.status.error).toMatch(/needs the event PIN/);
    client.stop();
  });

  it('survives a socket factory that throws (e.g. a malformed URL) and keeps retrying', async () => {
    const store = HazardStore.inMemory();
    let attempts = 0;
    const client = new SyncClient({
      url: 'wss://x/ws',
      deviceId: 'd',
      store,
      random: () => 0.5,
      createSocket: () => {
        attempts += 1;
        throw new Error('bad url');
      },
    });
    client.start();
    expect(client.status).toMatchObject({ state: 'backoff', error: 'bad url' });
    await settle(1000);
    expect(attempts).toBe(2);
    client.stop();
  });

  it('reports state changes to listeners', async () => {
    const { client, last } = rig();
    const states: string[] = [];
    client.onStatus((s) => states.push(s.state));
    client.start();
    last().open();
    await settle();
    last().drop();
    client.stop();
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(states).toContain('backoff');
    expect(states.at(-1)).toBe('idle');
  });
});
