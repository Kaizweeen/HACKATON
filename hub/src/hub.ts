/**
 * The hub: one HTTPS server that serves the built PWA and the /ws WebSocket endpoint.
 *
 * Message handling (the shared package implements the rules; this file only wires sockets to them):
 *   connect         -> send our hello (summary) so the device can push what we lack
 *   hello           -> reply diff(what the device is missing or has older)
 *   hazard / diff   -> merge each hazard into the store; echo the merged state back to the sender
 *                      (that echo is the ack that lets a phone clear its pending flag, and it also
 *                      corrects a phone that is behind); broadcast whatever changed to everyone else
 *   ping            -> answer with ack + serverTime
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import compression from 'compression';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import {
  confirmationCount,
  diffMessages,
  encodeWsMessage,
  HUB_DEVICE_ID,
  HUB_PIN_PARAM,
  MAX_MESSAGE_BYTES,
  parseWsMessage,
  summarize,
  WS_CLOSE_PIN_REQUIRED,
  WS_PATH,
  type Hazard,
  type WsMessage,
} from '@lubak/shared';
import type { HubConfig } from './config.js';
import { silentLogger, type Logger } from './log.js';
import type { HazardStore } from './store.js';

const MAX_MESSAGES_PER_SECOND = 200;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface HubOptions {
  config: Pick<HubConfig, 'host' | 'httpsPort' | 'staticDir' | 'snapshotMs' | 'sweepMs' | 'heartbeatMs'> & { pin?: string | null };
  /** Omit for plain HTTP. */
  tls?: { key: string; cert: string } | undefined;
  store: HazardStore;
  log?: Logger;
  now?: () => number;
}

export interface ClientInfo {
  id: number;
  ws: WebSocket;
  deviceId: string | null;
  remote: string;
  connectedAt: number;
  alive: boolean;
  windowStart: number;
  windowCount: number;
}

export interface HubStats {
  clients: number;
  hazards: number;
  startedAt: number;
  rejectedMessages: number;
}

export interface Hub {
  readonly app: express.Express;
  /** Actual bound port (differs from the configured one when that was 0). */
  readonly port: number;
  readonly clients: ReadonlySet<ClientInfo>;
  start(): Promise<void>;
  stop(): Promise<void>;
  stats(): HubStats;
}

function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

const stripV4Prefix = (addr: string | undefined): string => (addr ?? 'unknown').replace(/^::ffff:/, '');

function setCacheHeaders(res: http.ServerResponse, filePath: string): void {
  const base = path.basename(filePath);
  if (base === 'index.html' || base === 'sw.js' || base === 'registerSW.js' || base.endsWith('.webmanifest')) {
    // the service worker and shell must always be revalidated or updates never reach phones
    res.setHeader('Cache-Control', 'no-cache');
  } else if (filePath.split(path.sep).includes('assets')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // content-hashed by Vite
  }
}

const NOT_BUILT_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lubak Alert hub</title>
<body style="font:16px/1.5 system-ui;margin:2rem;max-width:34rem">
<h1>Lubak Alert hub is running</h1>
<p>The PWA has not been built yet. On the computer, run <code>npm run build</code> and reload this page.</p>
<p>The WebSocket endpoint at <code>${WS_PATH}</code> is already live.</p></body>`;

/** Constant-time PIN check; no PIN configured means open. */
export function pinAccepted(expected: string | null | undefined, given: string | null | undefined): boolean {
  if (!expected) return true;
  if (typeof given !== 'string' || given === '') return false;
  const digest = (v: string): Buffer => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(digest(expected), digest(given));
}

export function createHub(opts: HubOptions): Hub {
  const { config, store } = opts;
  const log = opts.log ?? silentLogger;
  const now = opts.now ?? Date.now;
  const startedAt = now();

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // gzip on the way out: the onnxruntime WASM shrinks from ~27 MB to ~7 MB, which is what every phone downloads over the
  // hotspot on its first visit. PNG tiles and the ONNX weights barely compress and are skipped by size/type rules.
  app.use(compression({ threshold: 1024 }));

  const clients = new Set<ClientInfo>();
  let nextClientId = 1;
  let rejectedMessages = 0;
  let boundPort = config.httpsPort;

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, hazards: store.size, clients: clients.size, uptimeSec: Math.round((now() - startedAt) / 1000) });
  });
  app.get('/api/hazards', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const given = typeof req.query[HUB_PIN_PARAM] === 'string' ? (req.query[HUB_PIN_PARAM] as string) : req.get('x-lubak-pin');
    if (!pinAccepted(config.pin, given)) {
      res.status(401).json({ error: 'event PIN required' });
      return;
    }
    res.json(store.all());
  });
  app.use(express.static(config.staticDir, { setHeaders: setCacheHeaders, index: 'index.html' }));
  app.get('/', (_req, res) => {
    if (fs.existsSync(path.join(config.staticDir, 'index.html'))) res.status(404).end();
    else res.status(200).type('html').send(NOT_BUILT_PAGE);
  });

  const server: http.Server | https.Server = opts.tls ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, app) : http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    if (url.pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!pinAccepted(config.pin, url.searchParams.get(HUB_PIN_PARAM))) {
      // Finish the handshake and close with a code the app understands: a plain 401 would look like "cannot reach the hub".
      // The socket never joins `clients`, so nothing it sends is read and nothing is broadcast to it.
      log.warn(`refused a phone without the event PIN (${req.socket.remoteAddress ?? '?'})`);
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(WS_CLOSE_PIN_REQUIRED, 'event PIN required'));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function send(client: ClientInfo, message: WsMessage): void {
    const { ws } = client;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      log.warn(`client #${client.id} is not keeping up (${ws.bufferedAmount} bytes queued); dropping it`);
      ws.terminate();
      return;
    }
    ws.send(encodeWsMessage(message));
  }

  function sendHazards(client: ClientInfo, hazards: readonly Hazard[]): void {
    if (hazards.length === 1) send(client, { type: 'hazard', hazard: hazards[0]! });
    else for (const message of diffMessages(hazards)) send(client, message);
  }

  function broadcast(hazards: readonly Hazard[], except: ClientInfo): void {
    if (hazards.length === 0) return;
    for (const c of clients) if (c !== except) sendHazards(c, hazards);
  }

  /** Merge hazards from one client; echo merged state to it; broadcast what changed. */
  function ingest(client: ClientInfo, incoming: readonly Hazard[], asSingle: boolean): void {
    const echo: Hazard[] = [];
    const changed: Hazard[] = [];
    for (const h of incoming) {
      const existing = store.get(h.id);
      const result = store.ingest(h);
      if (result === null) continue; // expired or store full: no ack, the device will drop it on its own sweep
      echo.push(result.merged);
      if (result.changed) {
        changed.push(result.merged);
        const n = confirmationCount(result.merged);
        log[existing === undefined ? 'info' : 'debug'](
          `${existing === undefined ? '+' : '~'} ${result.merged.cls} ${result.merged.geohash} conf ${result.merged.confidence.toFixed(2)} x${n}`,
        );
      }
    }
    if (echo.length > 0) {
      if (asSingle && echo.length === 1) send(client, { type: 'hazard', hazard: echo[0]! });
      else for (const message of diffMessages(echo)) send(client, message);
    }
    broadcast(changed, client);
  }

  function onMessage(client: ClientInfo, text: string): void {
    const parsed = parseWsMessage(text, { now: now() });
    if (!parsed.ok) {
      rejectedMessages += 1;
      log.warn(`client #${client.id} sent an invalid message (${parsed.reason}); ignored`);
      return;
    }
    if (parsed.rejected.length > 0) {
      rejectedMessages += parsed.rejected.length;
      log.warn(`client #${client.id}: dropped ${parsed.rejected.length} invalid hazard(s): ${[...new Set(parsed.rejected)].join(', ')}`);
    }
    const message = parsed.message;
    switch (message.type) {
      case 'hello': {
        client.deviceId = message.deviceId;
        const missing = store.diffFor(message.summary);
        log.info(`client #${client.id} is device ${message.deviceId.slice(0, 8)} (has ${message.summary.length}, sending ${missing.length})`);
        for (const m of diffMessages(missing)) send(client, m);
        break;
      }
      case 'diff':
        ingest(client, message.hazards, false);
        break;
      case 'hazard':
        ingest(client, [message.hazard], true);
        break;
      case 'ping':
        if (!message.ack) send(client, { type: 'ping', t: message.t, ack: true, serverTime: now() });
        break;
      default: {
        const unreachable: never = message;
        void unreachable;
      }
    }
  }

  wss.on('connection', (ws, req) => {
    const client: ClientInfo = {
      id: nextClientId++,
      ws,
      deviceId: null,
      remote: stripV4Prefix(req.socket.remoteAddress),
      connectedAt: now(),
      alive: true,
      windowStart: now(),
      windowCount: 0,
    };
    clients.add(client);
    log.info(`client #${client.id} connected from ${client.remote} (${clients.size} online)`);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      const t = now();
      if (t - client.windowStart >= 1000) {
        client.windowStart = t;
        client.windowCount = 0;
      }
      if (++client.windowCount > MAX_MESSAGES_PER_SECOND) {
        log.warn(`client #${client.id} exceeded ${MAX_MESSAGES_PER_SECOND} messages/s (a sync loop?); closing it`);
        ws.close(1008, 'rate limit');
        return;
      }
      if (isBinary) {
        rejectedMessages += 1;
        return;
      }
      try {
        onMessage(client, rawToString(data));
      } catch (err) {
        log.error(`client #${client.id}: handler crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    });
    ws.on('close', () => {
      clients.delete(client);
      log.info(`client #${client.id} left (${clients.size} online)`);
    });
    ws.on('error', (err) => log.debug(`client #${client.id} socket error: ${err.message}`));

    send(client, { type: 'hello', deviceId: HUB_DEVICE_ID, summary: summarize(store.all(), now()) });
  });

  const timers: NodeJS.Timeout[] = [];

  return {
    app,
    get port() {
      return boundPort;
    },
    clients,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.httpsPort, config.host, () => {
          server.off('error', reject);
          boundPort = (server.address() as AddressInfo).port;
          resolve();
        });
      });
      timers.push(
        setInterval(() => void store.snapshot(), config.snapshotMs),
        setInterval(() => {
          const removed = store.sweep();
          if (removed > 0) log.info(`swept ${removed} expired hazard(s); ${store.size} left`);
        }, config.sweepMs),
        setInterval(() => {
          for (const c of clients) {
            if (!c.alive) {
              log.info(`client #${c.id} stopped answering; dropping it`);
              c.ws.terminate();
              continue;
            }
            c.alive = false;
            c.ws.ping();
          }
        }, config.heartbeatMs),
      );
      for (const t of timers) t.unref();
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      for (const c of clients) c.ws.close(1001, 'hub shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.snapshot();
    },
    stats() {
      return { clients: clients.size, hazards: store.size, startedAt, rejectedMessages };
    },
  };
}
