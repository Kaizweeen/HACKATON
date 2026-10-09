/**
 * Fake device: connects to the hub exactly like a phone would and emits plausible hazards along a
 * route through Antipolo, Rizal (the Demo Mode loop on real streets around 14.5847 N, 121.1757 E), so the hub and the map can be tested with
 * no camera, no model and no GPS.
 *
 *   npm run fake-device                          # 2 devices, 1 hazard/s in total, runs until Ctrl+C
 *   npm run fake-device -- --rate 5 --count 40   # 5 hazards/s, stop after 40
 *   npm run fake-device -- --devices 3 --jitter 4
 *
 * It is also a compact reference for the client side of the protocol: hello on connect, answer the hub's
 * hello with a diff, merge incoming hazards with the shared reconcile(), correct the sender when ahead,
 * reconnect with backoff and catch up through the same handshake. All numbers below (route, class mix,
 * confidences) are SYNTHETIC test data and say nothing about real model accuracy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import {
  computeDiff,
  createHazard,
  demoRoute,
  DEMO_CENTER,
  diffMessages,
  encodeWsMessage,
  newDeviceId,
  offsetMeters,
  parseWsMessage,
  pointAlongPath,
  polylineLengthMeters,
  reconcile,
  summarize,
  WS_PATH,
  type Hazard,
  type HazardClass,
  type LatLon,
  type WsMessage,
} from '@lubak/shared';

const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Fake device for Lubak Alert

Usage: npm run fake-device -- [options]

  --url <url>       hub address, default $HUB_URL or https://localhost:8443 (http(s) or ws(s) accepted)
  --ca <file>       CA certificate to trust, default hub/.certs/lubak-hub-ca.crt when it exists
  --insecure        do NOT verify the hub certificate (prints a warning)
  --rate <n>        hazards per second across all fake devices, default 1
  --devices <n>     number of fake phones (separate connections / device ids), default 2
  --spots <n>       distinct hazard locations along the route, default 30
  --jitter <m>      GPS noise in metres (standard deviation), default 2
  --center <lat,lon> route centre, default 14.58471,121.175709 (the demo loop follows real streets only there)
  --seed <n>        random seed, default 1
  --count <n>       stop after n hazards (default: run until Ctrl+C)
  -h, --help
`;

// --------------------------------------------------------------------------------------------------
// deterministic randomness
// --------------------------------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (rng: () => number): number => {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};

// --------------------------------------------------------------------------------------------------
// the synthetic world
// --------------------------------------------------------------------------------------------------
interface Spot {
  cls: HazardClass;
  at: LatLon;
}

function buildSpots(center: LatLon, count: number, rng: () => number): Spot[] {
  const route = demoRoute(center);
  const total = polylineLengthMeters(route);
  const spots: Spot[] = [];
  let previous: HazardClass = 'pothole';
  for (let i = 0; i < count; i++) {
    const distance = ((i + 0.2 + 0.6 * rng()) / count) * total;
    const p = pointAlongPath(route, distance, false);
    // flooding comes in stretches, potholes and cracks in patches
    const r = rng();
    const cls: HazardClass =
      previous === 'flooded_road' && r < 0.5 ? 'flooded_road' : r < 0.55 ? 'pothole' : r < 0.9 ? 'crack' : 'flooded_road';
    previous = cls;
    spots.push({ cls, at: { lat: p.lat, lon: p.lon } });
  }
  return spots;
}

/** Synthetic confidence per class (clipped normal). Test data only. */
function fakeConfidence(cls: HazardClass, rng: () => number): number {
  const [mean, sd, lo, hi] = cls === 'pothole' ? [0.72, 0.12, 0.45, 0.97] : cls === 'crack' ? [0.62, 0.12, 0.4, 0.95] : [0.78, 0.1, 0.5, 0.98];
  return Math.min(hi, Math.max(lo, mean + sd * gaussian(rng)));
}

// --------------------------------------------------------------------------------------------------
// one fake phone
// --------------------------------------------------------------------------------------------------
interface DeviceOptions {
  index: number;
  url: string;
  wsOptions: { ca?: string; rejectUnauthorized?: boolean };
  log: (message: string) => void;
}

class FakeDevice {
  readonly deviceId = newDeviceId();
  readonly replica = new Map<string, Hazard>();
  sent = 0;
  received = 0;
  connected = false;
  everConnected = false;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private timers = new Set<NodeJS.Timeout>();

  constructor(private readonly opts: DeviceOptions) {}

  private tag(): string {
    return `dev ${this.opts.index + 1} (${this.deviceId.slice(0, 6)})`;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.ws?.close(1000, 'bye');
  }

  private send(message: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeWsMessage(message));
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url, this.opts.wsOptions);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.everConnected = true;
      this.attempt = 0;
      this.opts.log(`${this.tag()} connected to the hub`);
      this.send({ type: 'hello', deviceId: this.deviceId, summary: summarize(this.replica.values(), Date.now()) });
      const keepAlive = setInterval(() => this.send({ type: 'ping', t: Date.now() }), 15_000);
      keepAlive.unref();
      ws.once('close', () => clearInterval(keepAlive));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const parsed = parseWsMessage(data.toString(), { now: Date.now() });
      if (!parsed.ok) return;
      const m = parsed.message;
      if (m.type === 'hello') {
        // the hub told us what it has; push whatever it lacks or has older (this is how offline work catches up)
        for (const d of diffMessages(computeDiff(this.replica.values(), m.summary, Date.now()))) this.send(d);
      } else if (m.type === 'diff' || m.type === 'hazard') {
        const incoming = m.type === 'diff' ? m.hazards : [m.hazard];
        const corrections: Hazard[] = [];
        for (const h of incoming) {
          this.received += 1;
          const r = reconcile(this.replica.get(h.id), h);
          if (r.changed) this.replica.set(h.id, r.merged);
          if (r.senderBehind) corrections.push(r.merged);
        }
        for (const d of diffMessages(corrections)) this.send(d);
      } else if (m.type === 'ping' && !m.ack) {
        this.send({ type: 'ping', t: m.t, ack: true });
      }
    });

    ws.on('error', (err) => {
      if (!this.connected) this.opts.log(`${this.tag()} cannot reach the hub: ${err.message}`);
    });

    ws.on('close', () => {
      const was = this.connected;
      this.connected = false;
      if (this.stopped) return;
      this.attempt += 1;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(this.attempt, 5));
      if (was) this.opts.log(`${this.tag()} lost the hub; retrying in ${(delay / 1000).toFixed(1)}s (keeps working offline)`);
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.connect();
      }, delay);
      this.timers.add(t);
    });
  }

  /** "Detect" a hazard: merge it into our replica and tell the hub if we are connected. */
  report(spot: Spot, jitterM: number, rng: () => number): Hazard {
    const noisy = offsetMeters(spot.at, gaussian(rng) * jitterM, gaussian(rng) * jitterM);
    const fresh = createHazard({
      cls: spot.cls,
      lat: noisy.lat,
      lon: noisy.lon,
      confidence: fakeConfidence(spot.cls, rng),
      deviceId: this.deviceId,
      now: Date.now(),
    });
    const { merged } = reconcile(this.replica.get(fresh.id), fresh);
    this.replica.set(merged.id, merged);
    this.sent += 1;
    this.send({ type: 'hazard', hazard: merged });
    return merged;
  }
}

// --------------------------------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------------------------------
function normalizeUrl(raw: string): string {
  const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.pathname === '/' || u.pathname === '') u.pathname = WS_PATH;
  return u.toString();
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number, got "${raw}"`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      ca: { type: 'string' },
      insecure: { type: 'boolean' },
      rate: { type: 'string' },
      devices: { type: 'string' },
      spots: { type: 'string' },
      jitter: { type: 'string' },
      center: { type: 'string' },
      seed: { type: 'string' },
      count: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  const rate = positiveNumber(values.rate, 1, 'rate');
  const deviceCount = Math.floor(positiveNumber(values.devices, 2, 'devices'));
  const spotCount = Math.floor(positiveNumber(values.spots, 30, 'spots'));
  const jitterM = values.jitter === undefined ? 2 : Math.max(0, Number(values.jitter));
  const seed = values.seed === undefined ? 1 : Number(values.seed);
  const limit = values.count === undefined ? Infinity : Math.floor(positiveNumber(values.count, 1, 'count'));
  const [clat, clon] = (values.center ?? `${DEMO_CENTER.lat},${DEMO_CENTER.lon}`).split(',').map(Number);
  if (clat === undefined || clon === undefined || !Number.isFinite(clat) || !Number.isFinite(clon)) {
    throw new Error('--center must look like 14.585,121.176');
  }

  const url = normalizeUrl(values.url ?? process.env['HUB_URL'] ?? 'https://localhost:8443');
  const wsOptions: DeviceOptions['wsOptions'] = {};
  const caFile = values.ca ?? path.join(HUB_ROOT, '.certs', 'lubak-hub-ca.crt');
  if (values.insecure) {
    wsOptions.rejectUnauthorized = false;
    console.warn('WARNING: --insecure given, the hub certificate is NOT being verified.');
  } else if (url.startsWith('wss:') && fs.existsSync(caFile)) {
    wsOptions.ca = fs.readFileSync(caFile, 'utf8');
  } else if (values.ca) {
    throw new Error(`--ca file not found: ${caFile}`);
  }

  const rng = mulberry32(seed);
  const spots = buildSpots({ lat: clat, lon: clon }, spotCount, rng);
  const log = (m: string): void => console.log(`${new Date().toTimeString().slice(0, 8)} ${m}`);
  const devices = Array.from({ length: deviceCount }, (_, index) => new FakeDevice({ index, url, wsOptions, log }));

  log(`fake device(s): ${deviceCount} phone(s), ${rate} hazard(s)/s total, ${spotCount} synthetic spots near ${clat}, ${clon}`);
  log(`hub: ${url}${wsOptions.ca ? `  (trusting ${path.relative(process.cwd(), caFile) || caFile})` : ''}`);
  for (const d of devices) d.start();

  // Each phone walks the route spot by spot, starting at a different place, so spots collect several confirmations.
  const cursor = devices.map((_, i) => Math.floor((i * spots.length) / deviceCount));
  let emitted = 0;
  const started = Date.now();

  const finish = (code: number): void => {
    clearInterval(tick);
    clearTimeout(connectWatchdog);
    setTimeout(() => {
      const neverConnected = !devices.some((d) => d.everConnected);
      for (const d of devices) d.stop();
      const sent = devices.reduce((n, d) => n + d.sent, 0);
      const known = new Set(devices.flatMap((d) => [...d.replica.keys()]));
      log(`done: ${sent} report(s) sent, ${known.size} distinct hazard(s) known, ${devices.reduce((n, d) => n + d.received, 0)} update(s) received from the hub`);
      if (neverConnected) {
        console.error(`never connected to ${url}: nothing reached the hub. Is it running (npm run hub)?`);
        process.exit(1);
      }
      process.exit(code);
    }, 600);
  };

  const tick = setInterval(() => {
    const i = emitted % devices.length;
    const device = devices[i]!;
    const spot = spots[cursor[i]! % spots.length]!;
    cursor[i] = (cursor[i]! + 1) % spots.length;
    const h = device.report(spot, jitterM, rng);
    emitted += 1;
    log(
      `${device.connected ? '→' : '·'} dev ${i + 1}  ${h.cls.padEnd(12)} ${h.geohash} conf ${h.confidence.toFixed(2)} (${h.lat.toFixed(5)}, ${h.lon.toFixed(5)}) x${h.deviceIds.length}${device.connected ? '' : '  [offline, queued in replica]'}`,
    );
    if (emitted >= limit) finish(0);
  }, 1000 / rate);

  // With --count the tool is used in scripts: fail loudly if the hub never answers.
  const connectWatchdog = setTimeout(() => {
    if (limit !== Infinity && !devices.some((d) => d.everConnected)) {
      console.error(`could not connect to ${url} within 15 s; is the hub running (npm run hub)?`);
      clearInterval(tick);
      for (const d of devices) d.stop();
      process.exit(1);
    }
  }, 15_000);

  process.on('SIGINT', () => {
    log(`stopping after ${((Date.now() - started) / 1000).toFixed(0)} s`);
    finish(0);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
