import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOUR_MS, summarize, TTL_MS } from '@lubak/shared';
import { ensureTls, type TlsMaterial } from '../src/certs.js';
import { createHub, type Hub } from '../src/hub.js';
import { silentLogger } from '../src/log.js';
import { HazardStore } from '../src/store.js';
import { hazard, T0, tempDir, TestClient } from './harness.js';

let tls: TlsMaterial;
beforeAll(async () => {
  tls = await ensureTls({ dir: tempDir(), names: ['localhost', '127.0.0.1'], preferMkcert: false, log: silentLogger });
});

interface Rig {
  hub: Hub;
  store: HazardStore;
  wsUrl: string;
  baseUrl: string;
  setClock(t: number): void;
  staticDir: string;
  dataDir: string;
}

const rigs: Rig[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(rigs.splice(0).map((r) => r.hub.stop()));
});
afterAll(() => undefined);

async function startRig(over: { sweepMs?: number; snapshotMs?: number; staticDir?: string; withStatic?: boolean } = {}): Promise<Rig> {
  let clock = T0 + 1000;
  const dataDir = tempDir();
  const staticDir = over.staticDir ?? tempDir();
  if (over.withStatic !== false && over.staticDir === undefined) {
    fs.mkdirSync(path.join(staticDir, 'assets'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Lubak</title>');
    fs.writeFileSync(path.join(staticDir, 'sw.js'), '// service worker');
    fs.writeFileSync(path.join(staticDir, 'assets', 'app-abc123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(staticDir, 'model.onnx'), Buffer.from([1, 2, 3]));
  }
  const now = (): number => clock;
  const store = new HazardStore({ dataDir, now });
  const hub = createHub({
    config: {
      host: '127.0.0.1',
      httpsPort: 0,
      staticDir,
      snapshotMs: over.snapshotMs ?? 60_000,
      sweepMs: over.sweepMs ?? 60_000,
      heartbeatMs: 60_000,
    },
    tls: { key: tls.key, cert: tls.cert },
    store,
    log: silentLogger,
    now,
  });
  await hub.start();
  const rig: Rig = {
    hub,
    store,
    wsUrl: `wss://127.0.0.1:${hub.port}/ws`,
    baseUrl: `https://127.0.0.1:${hub.port}`,
    setClock: (t) => {
      clock = t;
    },
    staticDir,
    dataDir,
  };
  rigs.push(rig);
  return rig;
}

async function connect(rig: Rig, path = '/ws'): Promise<TestClient> {
  const c = await TestClient.connect(`wss://127.0.0.1:${rig.hub.port}${path}`, { ca: tls.caCertPem });
  clients.push(c);
  return c;
}

function get(url: string, ca: string | undefined = tls.caCertPem): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { ca, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

describe('handshake', () => {
  it('sends its own hello first, with a summary of what it holds', async () => {
    const rig = await startRig();
    const h = hazard();
    rig.store.ingest(h);
    const c = await connect(rig);
    const hello = await c.waitFor('hello');
    expect(hello.deviceId).toBe('hub');
    expect(hello.summary).toEqual(summarize([h], T0 + 1000));
  });

  it('answers a hello with exactly the hazards the device is missing or has older', async () => {
    const rig = await startRig();
    const h1 = hazard({ lat: 14.585 });
    const h2 = hazard({ lat: 14.586, cls: 'crack' });
    rig.store.ingest(h1);
    rig.store.ingest(h2);

    const empty = await connect(rig);
    empty.send({ type: 'hello', deviceId: 'phone-empty', summary: [] });
    const diff = await empty.waitFor('diff');
    expect(diff.hazards.map((h) => h.id).sort()).toEqual([h1.id, h2.id].sort());

    const partial = await connect(rig);
    partial.send({ type: 'hello', deviceId: 'phone-partial', summary: summarize([h1]) });
    const diff2 = await partial.waitFor('diff');
    expect(diff2.hazards.map((h) => h.id)).toEqual([h2.id]);

    const current = await connect(rig);
    current.send({ type: 'hello', deviceId: 'phone-current', summary: summarize([h1, h2]) });
    await current.expectNone('diff');
  });

  it('a device that was offline catches up: the hub learns what it lacks from the device diff', async () => {
    const rig = await startRig();
    const offlineWork = hazard({ deviceId: 'dev-offline', lat: 14.59, now: T0 + 500 });
    const c = await connect(rig);
    c.send({ type: 'hello', deviceId: 'dev-offline', summary: summarize([offlineWork]) });
    c.send({ type: 'diff', hazards: [offlineWork] });
    const echo = await c.waitFor('diff');
    expect(echo.hazards[0]?.id).toBe(offlineWork.id);
    expect(rig.store.get(offlineWork.id)?.deviceIds).toEqual(['dev-offline']);
  });
});

describe('live updates', () => {
  it('merges reports from two phones, acks the sender with the merged state and broadcasts changes to the others', async () => {
    const rig = await startRig();
    const a = await connect(rig);
    const b = await connect(rig);
    await a.waitFor('hello');
    await b.waitFor('hello');

    a.send({ type: 'hazard', hazard: hazard({ deviceId: 'dev-a', confidence: 0.6, now: T0 + 10 }) });
    const ackA = await a.waitFor('hazard');
    expect(ackA.hazard.deviceIds).toEqual(['dev-a']);
    const seenByB = await b.waitFor('hazard');
    expect(seenByB.hazard.deviceIds).toEqual(['dev-a']);

    a.clear();
    b.clear();
    b.send({ type: 'hazard', hazard: hazard({ deviceId: 'dev-b', confidence: 0.9, now: T0 + 20 }) });
    const ackB = await b.waitFor('hazard');
    expect(ackB.hazard.deviceIds).toEqual(['dev-a', 'dev-b']); // the echo is the merged truth, not just what B sent
    expect(ackB.hazard.confidence).toBe(0.9);
    const updateForA = await a.waitFor('hazard');
    expect(updateForA.hazard.deviceIds).toEqual(['dev-a', 'dev-b']);
    expect(rig.store.size).toBe(1);
  });

  it('does not re-broadcast an unchanged hazard (idempotent redelivery) but still acks it', async () => {
    const rig = await startRig();
    const a = await connect(rig);
    const b = await connect(rig);
    const h = hazard({ now: T0 + 10 });
    a.send({ type: 'hazard', hazard: h });
    await b.waitFor('hazard');
    a.clear();
    b.clear();
    a.send({ type: 'hazard', hazard: h });
    await a.waitFor('hazard');
    await b.expectNone('hazard');
  });

  it('corrects a sender that is behind: the echo carries what the hub already knew', async () => {
    const rig = await startRig();
    rig.store.ingest(hazard({ deviceId: 'dev-x', now: T0 + 50 }));
    rig.store.ingest(hazard({ deviceId: 'dev-y', now: T0 + 60 }));
    const c = await connect(rig);
    c.send({ type: 'hazard', hazard: hazard({ deviceId: 'dev-c', now: T0 + 40 }) });
    const echo = await c.waitFor('hazard');
    expect(echo.hazard.deviceIds).toEqual(['dev-c', 'dev-x', 'dev-y']);
    expect(echo.hazard.lastSeen).toBe(T0 + 60);
  });

  it('applies diffs from a device, echoes them as a diff and broadcasts them as a diff', async () => {
    const rig = await startRig();
    const sender = await connect(rig);
    const listener = await connect(rig);
    const batch = [hazard({ lat: 14.585 }), hazard({ lat: 14.586 }), hazard({ lat: 14.587 })];
    sender.send({ type: 'diff', hazards: batch });
    const echo = await sender.waitFor('diff');
    expect(echo.hazards).toHaveLength(3);
    const broadcast = await listener.waitFor('diff', (m) => m.hazards.length === 3);
    expect(broadcast.hazards.map((h) => h.id).sort()).toEqual(batch.map((h) => h.id).sort());
    expect(rig.store.size).toBe(3);
  });

  it('a client cannot make a hazard immortal by sending its own ttlMs', async () => {
    const rig = await startRig();
    const c = await connect(rig);
    const forged = { ...hazard({ cls: 'flooded_road' }), ttlMs: Number.MAX_SAFE_INTEGER };
    c.sendRaw(JSON.stringify({ type: 'hazard', hazard: forged }));
    await c.waitFor('hazard');
    expect(rig.store.get(forged.id)?.ttlMs).toBe(TTL_MS.flooded_road);
  });
});

describe('hostile or broken input', () => {
  it('ignores garbage, bad hazards and unknown types, and keeps the connection alive', async () => {
    const rig = await startRig();
    const c = await connect(rig);
    await c.waitFor('hello');
    c.sendRaw('not json');
    c.sendRaw('{"type":"explode"}');
    c.sendRaw(JSON.stringify({ type: 'hazard', hazard: { ...hazard(), geohash: 'zzzzzzzz' } }));
    c.sendRaw(JSON.stringify({ type: 'hazard', hazard: { ...hazard(), lat: 999 } }));
    c.send({ type: 'hazard', hazard: hazard() });
    await c.waitFor('hazard'); // the valid one still works
    expect(rig.store.size).toBe(1);
    expect(rig.hub.stats().rejectedMessages).toBeGreaterThanOrEqual(4);
  });

  it('refuses hazards that have already expired (no resurrection) and does not ack them', async () => {
    const rig = await startRig();
    const c = await connect(rig);
    c.send({ type: 'hazard', hazard: hazard({ cls: 'flooded_road', now: T0 - 7 * HOUR_MS }) });
    await c.expectNone('hazard', 200);
    expect(rig.store.size).toBe(0);
  });

  it('refuses hazards stamped far in the future (clock-skew guard)', async () => {
    const rig = await startRig();
    const c = await connect(rig);
    c.send({ type: 'hazard', hazard: hazard({ now: T0 + 3 * HOUR_MS }) });
    await c.expectNone('hazard', 200);
    expect(rig.store.size).toBe(0);
  });

  it('closes a client that floods it (e.g. a sync loop between a buggy client and the hub)', async () => {
    const rig = await startRig();
    const c = await connect(rig);
    for (let i = 0; i < 400; i++) c.send({ type: 'ping', t: i, ack: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(c.closedWith?.code).toBe(1008);
  });

  it('only upgrades on /ws', async () => {
    const rig = await startRig();
    await expect(connect(rig, '/other')).rejects.toThrow(/404/);
  });

  it('answers a ping with an ack that echoes t and carries the hub clock', async () => {
    const rig = await startRig();
    const c = await connect(rig);
    c.send({ type: 'ping', t: 123 });
    const pong = await c.waitFor('ping', (m) => m.ack === true);
    expect(pong).toEqual({ type: 'ping', t: 123, ack: true, serverTime: T0 + 1000 });
    c.clear();
    c.send({ type: 'ping', t: 5, ack: true }); // an ack is never answered
    await c.expectNone('ping');
  });
});

describe('housekeeping', () => {
  it('sweeps expired hazards on its timer', async () => {
    const rig = await startRig({ sweepMs: 20 });
    rig.store.ingest(hazard({ cls: 'flooded_road', now: T0 }));
    rig.store.ingest(hazard({ cls: 'pothole', lat: 14.6, now: T0 }));
    expect(rig.store.size).toBe(2);
    rig.setClock(T0 + 6 * HOUR_MS + 1);
    await waitUntil(() => rig.store.size === 1);
    expect(rig.store.all().map((h) => h.cls)).toEqual(['pothole']);
  });

  it('writes the JSON snapshot on its timer, and a fresh store restores it', async () => {
    const rig = await startRig({ snapshotMs: 20 });
    rig.store.ingest(hazard());
    const file = path.join(rig.dataDir, 'hazards.json');
    await waitUntil(() => fs.existsSync(file));
    const restored = new HazardStore({ dataDir: rig.dataDir, now: () => T0 + 1000 });
    expect(restored.load()).toBe(1);
  });

  it('writes a final snapshot when stopped', async () => {
    const rig = await startRig();
    rig.store.ingest(hazard());
    await rig.hub.stop();
    rigs.splice(rigs.indexOf(rig), 1);
    expect(new HazardStore({ dataDir: rig.dataDir, now: () => T0 + 1000 }).load()).toBe(1);
  });
});

describe('HTTPS and static files', () => {
  it('is really TLS: a client that does not trust the hub CA is refused', async () => {
    const rig = await startRig();
    await expect(TestClient.connect(rig.wsUrl)).rejects.toThrow(/certificate|issuer|self.signed/i);
    await expect(get(`${rig.baseUrl}/healthz`, '')).rejects.toThrow(/certificate|issuer|self.signed/i);
  });

  it('serves the PWA shell with revalidation headers, hashed assets as immutable, and the ONNX model as binary', async () => {
    const rig = await startRig();
    const index = await get(`${rig.baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.body).toContain('Lubak');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect((await get(`${rig.baseUrl}/sw.js`)).headers['cache-control']).toBe('no-cache');
    expect((await get(`${rig.baseUrl}/assets/app-abc123.js`)).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get(`${rig.baseUrl}/model.onnx`)).status).toBe(200);
  });

  it('answers 404 for missing files (map tiles!) instead of falling back to index.html', async () => {
    const rig = await startRig();
    const tile = await get(`${rig.baseUrl}/tiles/14/13412/7524.png`);
    expect(tile.status).toBe(404);
    expect(tile.body).not.toContain('<title>Lubak</title>');
  });

  it('explains itself when the PWA has not been built yet', async () => {
    const rig = await startRig({ staticDir: path.join(tempDir(), 'does-not-exist') });
    const page = await get(`${rig.baseUrl}/`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('has not been built');
  });

  it('exposes health and a read-only JSON view of live hazards', async () => {
    const rig = await startRig();
    rig.store.ingest(hazard());
    const health = JSON.parse((await get(`${rig.baseUrl}/healthz`)).body);
    expect(health).toMatchObject({ ok: true, hazards: 1, clients: 0 });
    const list = JSON.parse((await get(`${rig.baseUrl}/api/hazards`)).body);
    expect(list).toHaveLength(1);
    expect(list[0].cls).toBe('pothole');
  });
});

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
