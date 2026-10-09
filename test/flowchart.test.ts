/**
 * The flowchart, as a test.
 *
 * docs/flowchart.md draws how Lubak Alert is meant to work:
 *
 *   Camera -> Detector -> "3 consecutive frames above the class threshold and past the 5 s cooldown?"
 *       NO: drop it, keep sampling.
 *       YES: Confirmed hazard + lat/lon + geohash (boost confidence on a jolt within 1.5 s, pothole and crack)
 *   -> Save locally (store + shared mergeHazard + pending-sync flag) -> Offline map
 *   -> "Hub reachable over hotspot?"
 *       NO: queue, reconnect with backoff.
 *       YES: WebSocket client (hello, then diff + hazard updates)
 *   -> Hub (over HTTPS: merge every hazard, answer hello with a diff, broadcast, JSON snapshot every 10 s, sweep expired)
 *   -> Other phones (apply diff, merge, update store + map).      Fake device tool -> Hub.
 *
 * Every describe below is one box or arrow of that chart, named after it, and runs the REAL code on both sides of the boundary it
 * crosses: the app's pipeline, confirmer, store and sync client talk over TLS to the real hub, all in this process. Only what physics
 * provides is scripted: camera frames, the detector's boxes, the accelerometer and the GPS fix. The map itself (Leaflet) needs a
 * browser, so here we check the data it is fed from (docs/flowchart.md says how the drawing, the camera and the service worker were checked).
 *
 * If a test here fails, the code has stopped doing what the chart says: fix the code, or change the chart on purpose.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  confirmationCount,
  createHazard,
  DEMO_CENTER,
  encodeGeohash,
  haversineMeters,
  HAZARD_CLASSES,
  HOUR_MS,
  mergeHazard,
  newDeviceId,
  offsetMeters,
  type Hazard,
  type LatLon,
  type SummaryEntry,
  type WsMessage,
} from '@lubak/shared';
import { videoConstraints } from '../app/src/camera.js';
import { CLASS_STYLE } from '../app/src/classes.js';
import { Confirmer, DEFAULT_CONFIRMER_CONFIG } from '../app/src/confirmer.js';
import { clampFps, loadConfig, MODEL_INPUT_SIZE, SAMPLE_FPS_MAX, SAMPLE_FPS_MIN } from '../app/src/config.js';
import { buildDemoScript, DemoGeo, DemoMotion, ReplayDetector } from '../app/src/demo.js';
import { computeLetterbox, createDetector, ModelLoadError, OnnxDetector, type Detection, type OrtLike } from '../app/src/detector.js';
import { Pipeline, type PipelineEvent } from '../app/src/pipeline.js';
import { HazardStore as PhoneStore, type StoreChange } from '../app/src/store.js';
import { SyncClient, type WebSocketLike } from '../app/src/sync.js';
import { det, FRAME_MS } from '../app/test/helpers.js';
import { FakeCamera, FakeGeo, FakeMotion, flush, ScriptedDetector } from '../app/test/pipeline-harness.js';
import { ensureTls, type TlsMaterial } from '../hub/src/certs.js';
import { loadConfig as loadHubConfig } from '../hub/src/config.js';
import { createHub, type Hub } from '../hub/src/hub.js';
import { silentLogger } from '../hub/src/log.js';
import { HazardStore as HubStore, SNAPSHOT_FILE } from '../hub/src/store.js';
import { TestClient } from '../hub/test/harness.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = DEFAULT_CONFIRMER_CONFIG;

/** Spots along the Antipolo test route, far enough apart (100 m) to be different geohash cells. */
const spot = (northM: number, eastM = 0): LatLon => offsetMeters(DEMO_CENTER, northM, eastM);

// ---------------------------------------------------------------------------------------------------
// the world: a real hub over TLS, and phones with the real app code
// ---------------------------------------------------------------------------------------------------

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let tls: TlsMaterial;
beforeAll(async () => {
  tls = await ensureTls({ dir: tempDir('lubak-flow-tls-'), names: ['localhost', '127.0.0.1'], preferMkcert: false, log: silentLogger });
});
afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface World {
  hub: Hub;
  hubStore: HubStore;
  dataDir: string;
  /** What the hub serves as the PWA (an empty temp folder until a test puts files in it). */
  staticDir: string;
  url: string;
  /** Move the hub's clock forward, so hazards age. The phones keep real time. */
  ageBy(ms: number): void;
  start(): Promise<void>;
}

const worlds: World[] = [];
const phones: { stop(): void }[] = [];

afterEach(async () => {
  for (const phone of phones.splice(0)) phone.stop();
  await Promise.all(worlds.splice(0).map((w) => w.hub.stop()));
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** A GET over TLS that trusts only the hub's own CA, like a phone that installed it. */
function httpsGet(url: string): Promise<{ status: number; type: string; cacheControl: string; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { ca: tls.caCertPem }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), cacheControl: String(res.headers['cache-control'] ?? ''), body }));
      })
      .on('error', reject);
  });
}

async function makeWorld(opts: { running?: boolean; snapshotMs?: number; sweepMs?: number } = {}): Promise<World> {
  const running = opts.running ?? true;
  let skew = 0;
  const now = (): number => Date.now() + skew;
  const dataDir = tempDir('lubak-flow-data-');
  const staticDir = tempDir('lubak-flow-static-');
  const hubStore = new HubStore({ dataDir, now });
  const port = running ? 0 : await freePort();
  const hub = createHub({
    config: { host: '127.0.0.1', httpsPort: port, staticDir, snapshotMs: opts.snapshotMs ?? 60_000, sweepMs: opts.sweepMs ?? 60_000, heartbeatMs: 60_000 },
    tls: { key: tls.key, cert: tls.cert },
    store: hubStore,
    log: silentLogger,
    now,
  });
  const world: World = {
    hub,
    hubStore,
    dataDir,
    staticDir,
    url: '',
    ageBy: (ms) => void (skew += ms),
    start: async () => {
      await hub.start();
      world.url = `wss://127.0.0.1:${hub.port}/ws`;
    },
  };
  world.url = `wss://127.0.0.1:${port}/ws`;
  worlds.push(world);
  if (running) await world.start();
  return world;
}

/** The app's own sync client, talking to the hub over TLS, and noting what it puts on the wire. */
function syncClientFor(url: string, deviceId: string, store: PhoneStore, sent: WsMessage['type'][]): SyncClient {
  return new SyncClient({
    url,
    deviceId,
    store,
    random: () => 0, // the shortest backoff: first retry after 0.75 s
    createSocket: (u) => {
      const ws = new WebSocket(u, { ca: tls.caCertPem });
      const send = ws.send.bind(ws) as (data: string) => void;
      (ws as unknown as { send: (data: string) => void }).send = (data) => {
        sent.push((JSON.parse(data) as WsMessage).type);
        send(data);
      };
      return ws as unknown as WebSocketLike;
    },
  });
}

/** One phone: the app's own pipeline, confirmer, store and sync client; only the sensors are scripted. */
class Phone {
  readonly deviceId = newDeviceId();
  readonly store = PhoneStore.inMemory();
  readonly camera = new FakeCamera();
  readonly detector = new ScriptedDetector();
  readonly motion = new FakeMotion();
  readonly geo = new FakeGeo();
  readonly pipeline: Pipeline;
  readonly sync: SyncClient;
  /** Message types this phone put on the wire, in order. */
  readonly sent: WsMessage['type'][] = [];
  /** What the map is told: every change of this phone's store. */
  readonly changes: StoreChange[] = [];
  readonly events: PipelineEvent[] = [];
  private clock = 0;
  private where: LatLon | null = null;

  constructor(url = 'wss://127.0.0.1:9/ws') {
    this.pipeline = new Pipeline({ camera: this.camera, detector: this.detector, confirmer: new Confirmer(), motion: this.motion, geo: this.geo, store: this.store, deviceId: this.deviceId });
    this.pipeline.onEvent((e) => this.events.push(e));
    this.store.subscribe((c) => this.changes.push(c));
    this.sync = syncClientFor(url, this.deviceId, this.store, this.sent);
    this.pipeline.start();
    phones.push(this);
  }

  /** Start talking to the hub (it may not be up yet). */
  connect(): this {
    this.sync.start();
    return this;
  }

  stop(): void {
    this.pipeline.stop();
    this.sync.stop();
  }

  placeAt(where: LatLon): this {
    this.where = where;
    return this;
  }

  /** The detector shows `detections` for `frames` consecutive frames (8 fps), and everything settles. */
  async look(detections: Detection[], frames = 1): Promise<void> {
    for (let i = 0; i < frames; i++) {
      if (this.where) this.geo.fix = { ...this.where, accuracy: 5, speed: 7, heading: 90, t: this.clock };
      this.detector.queue.push(detections);
      this.camera.emit(this.clock);
      this.clock += FRAME_MS;
      await flush();
    }
  }

  /** Time passes with nothing on the road. */
  wait(ms: number): void {
    this.clock += ms;
  }

  /** The accelerometer reports a jolt this long after the last frame. */
  async joltAfter(ms: number, magnitude = 7): Promise<void> {
    this.motion.jolt({ t: this.clock - FRAME_MS + ms, magnitude });
    await flush();
  }

  async joltAt(t: number, magnitude = 7): Promise<void> {
    this.motion.jolt({ t, magnitude });
    await flush();
  }

  get confirmed(): number {
    return this.events.filter((e) => e.type === 'confirmed').length;
  }

  /** The one hazard this phone holds (fails the test if there are none or several). */
  async only(): Promise<Hazard> {
    const all = await this.store.getAll();
    expect(all).toHaveLength(1);
    return all[0]!;
  }
}

/** A phone in Demo Mode: the same pipeline, store and sync client, fed by the prerecorded drive instead of a camera, model, GPS and accelerometer. */
const demoScript = buildDemoScript();
class DemoPhone {
  readonly deviceId = newDeviceId();
  readonly store = PhoneStore.inMemory();
  readonly sent: WsMessage['type'][] = [];
  readonly changes: StoreChange[] = [];
  readonly pipeline: Pipeline;
  readonly sync: SyncClient;
  private readonly camera = new FakeCamera();
  private readonly motion = new DemoMotion(demoScript);
  private readonly geo = new DemoGeo();

  constructor(url: string) {
    this.motion.start();
    this.geo.start();
    this.pipeline = new Pipeline({ camera: this.camera, detector: new ReplayDetector(demoScript), confirmer: new Confirmer(), motion: this.motion, geo: this.geo, store: this.store, deviceId: this.deviceId });
    this.store.subscribe((c) => this.changes.push(c));
    this.sync = syncClientFor(url, this.deviceId, this.store, this.sent);
    this.pipeline.start();
    phones.push(this);
  }

  connect(): this {
    this.sync.start();
    return this;
  }

  stop(): void {
    this.pipeline.stop();
    this.sync.stop();
  }

  /** One 60 s lap of the recorded drive, as fast as the machine allows. */
  async replayLap(): Promise<void> {
    for (let t = 0; t < demoScript.lapMs; t += demoScript.frameMs) {
      this.geo.tick(t, demoScript.lapMs);
      this.motion.tick(t);
      this.camera.emit(t);
      await flush();
    }
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** What a phone and a scripted-demo phone have in common. */
interface Peer {
  readonly store: PhoneStore;
  readonly sync: SyncClient;
}
const byId = (a: SummaryEntry, b: SummaryEntry): number => (a.id < b.id ? -1 : 1);
const phoneState = async (p: Peer): Promise<SummaryEntry[]> => (await p.store.summary()).sort(byId);
const hubState = (w: World): SummaryEntry[] => w.hubStore.summary().sort(byId);
const connected = (...ps: Peer[]): boolean => ps.every((p) => p.sync.status.state === 'connected');

// ---------------------------------------------------------------------------------------------------
// Camera -> Detector
// ---------------------------------------------------------------------------------------------------

describe('Camera (5-10 fps) and Detector (lubak.onnx: YOLOv8n, 320 input, pothole / crack / flooded_road)', () => {
  it('samples at a configurable 5 to 10 fps, and the model contract is 320 px with the three classes in the model\'s order', () => {
    expect([SAMPLE_FPS_MIN, SAMPLE_FPS_MAX]).toEqual([5, 10]);
    expect([clampFps(1), clampFps(8), clampFps(60)]).toEqual([5, 8, 10]);
    expect(loadConfig('?fps=6', { protocol: 'https:', host: 'x' }).sampleFps).toBe(6);
    expect(MODEL_INPUT_SIZE).toBe(320);
    expect([...HAZARD_CLASSES]).toEqual(['pothole', 'crack', 'flooded_road']);
  });

  it('lubak.onnx\'s YOLOv8 output [1, 7, 2100] is decoded through the 320 letterbox with class-aware NMS into boxes in the camera frame, and three frames in a row confirm them (WebGPU unavailable: WASM runs it)', async () => {
    const N = 2100;
    const output = new Float32Array(7 * N);
    const anchor = (i: number, cx: number, cy: number, w: number, h: number, scores: [number, number, number]): void => {
      [cx, cy, w, h, ...scores].forEach((v, channel) => (output[channel * N + i] = v)); // channel-major, like the real export
    };
    anchor(5, 160, 160, 64, 48, [0.9, 0.1, 0.05]); // a pothole in the middle of the model's 320 px input ...
    anchor(6, 162, 161, 66, 48, [0.7, 0.1, 0.05]); // ... its near-duplicate from the neighbouring anchor: NMS must drop it ...
    anchor(900, 160, 160, 64, 48, [0.05, 0.1, 0.8]); // ... and a flooded road in the very same box: another class, so NMS must keep it

    const created: string[] = [];
    const ort: OrtLike = {
      env: { wasm: {} },
      Tensor: class {
        constructor(readonly type: 'float32', readonly data: Float32Array, readonly dims: readonly number[]) {}
      },
      InferenceSession: {
        async create(_model, options) {
          const provider = options.executionProviders[0]!;
          created.push(provider);
          if (provider === 'webgpu') throw new Error('no WebGPU on this phone');
          return {
            inputNames: ['images'],
            outputNames: ['output0'],
            run: async () => ({ output0: { dims: [1, 7, N], data: output, location: 'cpu' } }),
          };
        },
      },
    };
    const detector = new OnnxDetector({
      modelUrl: 'https://hub.invalid/models/lubak.onnx',
      inputSize: MODEL_INPUT_SIZE,
      loadOrt: async () => ort,
      fetchImpl: async () => new Response(new Uint8Array(4096).fill(8), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      preprocessor: { data: new Float32Array(3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE), prepare: () => computeLetterbox(640, 360, MODEL_INPUT_SIZE) }, // the camera's 640x360 frame
      tryWebGpu: true,
    });
    await detector.init();
    expect(created).toEqual(['webgpu', 'wasm']);
    expect(detector.info()).toMatchObject({ kind: 'onnx', backend: 'wasm', ready: true });

    const store = PhoneStore.inMemory();
    const camera = new FakeCamera();
    const geo = new FakeGeo();
    const pipeline = new Pipeline({ camera, detector, confirmer: new Confirmer(), motion: new FakeMotion(), geo, store, deviceId: newDeviceId() });
    const seen: Detection[][] = [];
    pipeline.onResult((r) => seen.push(r.detections));
    pipeline.start();
    for (let i = 0; i < 3; i++) {
      geo.fix = { ...spot(0), accuracy: 5, speed: 7, heading: 90, t: i * FRAME_MS };
      camera.emit(i * FRAME_MS);
      await flush();
      await flush();
    }
    pipeline.stop();

    // 640x360 into 320: scale 0.5, 70 px of grey above and below. The pothole is centred at (320, 180) of the frame, 128 x 96 px big.
    expect(seen).toHaveLength(3);
    const first = seen[0]!;
    expect(first.map((d) => d.cls).sort()).toEqual(['flooded_road', 'pothole']); // three anchors in, two detections out
    const pothole = first.find((d) => d.cls === 'pothole')!;
    expect(pothole.confidence).toBeCloseTo(0.9, 5);
    expect(pothole.box.x1).toBeCloseTo(0.4, 5);
    expect(pothole.box.x2).toBeCloseTo(0.6, 5);
    expect(pothole.box.y1).toBeCloseTo(0.5 - 96 / 2 / 360, 5);
    expect(pothole.box.y2).toBeCloseTo(0.5 + 96 / 2 / 360, 5);

    expect((await store.getAll()).map((h) => h.cls).sort()).toEqual(['flooded_road', 'pothole']); // confirmed after the third frame, not before
    expect(pipeline.stats).toMatchObject({ framesProcessed: 3, confirmed: 2, errors: 0 });
  });

  it('looks at the road with the rear camera. (The light flowchart labels the camera "Front Camera", the architecture drawing and the brief say rear: rear is the default, ?camera=front is for testing.)', () => {
    expect(loadConfig('', { protocol: 'https:', host: 'x' }).camera).toBe('rear');
    expect(videoConstraints('rear').facingMode).toEqual({ ideal: 'environment' });
    expect(videoConstraints('front').facingMode).toEqual({ ideal: 'user' });
  });
});

// ---------------------------------------------------------------------------------------------------
// MockDetector / Demo Mode replay (dashed)
// ---------------------------------------------------------------------------------------------------

describe('MockDetector / Demo Mode replay (the dashed fallback into the Detector)', () => {
  it('no model file: the app says so and runs the mock, and "onnx" refuses to fall back, so random boxes are never passed off as inference', async () => {
    const missing = { modelUrl: 'http://127.0.0.1:9/models/lubak.onnx', inputSize: MODEL_INPUT_SIZE };
    const choice = await createDetector({ ...missing, detector: 'auto' });
    expect(choice.detector.info().kind).toBe('mock');
    expect(choice.fellBackBecause).toMatch(/Could not download the model/);
    await expect(createDetector({ ...missing, detector: 'onnx' })).rejects.toBeInstanceOf(ModelLoadError);
  });

  it('Demo Mode on two phones, through the real hub: the same 8 hazards, each confirmed by both, identical on the hub and on both phones', async () => {
    const world = await makeWorld();
    const a = new DemoPhone(world.url).connect();
    const b = new DemoPhone(world.url).connect();
    await until(() => connected(a, b), 'both demo phones to reach the hub');

    await Promise.all([a.replayLap(), b.replayLap()]); // the confirmer decides which of the 10 scripted encounters count
    expect(a.pipeline.stats).toMatchObject({ confirmed: 8, errors: 0, noFix: 0 });

    await until(() => world.hubStore.size === 8 && world.hubStore.all().every((h) => confirmationCount(h) === 2), 'the hub to hold 8 hazards, each confirmed twice');
    const hubSide = hubState(world);
    await until(async () => JSON.stringify(await phoneState(a)) === JSON.stringify(hubSide) && JSON.stringify(await phoneState(b)) === JSON.stringify(hubSide), 'both phones to hold what the hub holds');
    for (const demo of [a, b]) {
      expect(await demo.store.pendingCount()).toBe(0);
      expect(demo.changes.some((c) => c.kind === 'upsert' && c.origin === 'local')).toBe(true); // the map was fed by the replay ...
      expect(demo.changes.some((c) => c.kind === 'upsert' && c.origin === 'remote')).toBe(true); // ... and by the other phone
      expect(demo.sent).toContain('hello');
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------------------------------

describe('"3 consecutive frames above the class threshold and past the 5 s cooldown?"', () => {
  it('NO: below its class threshold, too few frames, or a broken streak: dropped, and the camera keeps being sampled', async () => {
    const p = new Phone().placeAt(spot(0));
    let fed = 0;
    for (const cls of HAZARD_CLASSES) {
      await p.look([det(cls, T.thresholds[cls] - 0.01)], 5); // each class has its own threshold
      fed += 5;
      p.wait(2000);
    }
    await p.look([det('pothole', 0.9)], 2); // only two frames
    p.wait(2000);
    await p.look([det('pothole', 0.9)], 2);
    await p.look([], 1); // an empty frame breaks the streak
    await p.look([det('pothole', 0.9)], 2);
    fed += 2 + 5;

    expect(p.confirmed).toBe(0);
    expect(await p.store.getAll()).toEqual([]);
    expect(p.pipeline.stats.framesProcessed).toBe(fed); // keep sampling: every single frame still went through the detector
  });

  it('YES: three consecutive frames above the class\'s own threshold confirm it, each class at its own bar', async () => {
    const p = new Phone().placeAt(spot(0));
    expect(T.consecutiveFrames).toBe(3);
    await p.look(
      HAZARD_CLASSES.map((cls) => det(cls, T.thresholds[cls] + 0.01)),
      3,
    );
    expect(p.confirmed).toBe(3);
    expect((await p.store.getAll()).map((h) => h.cls).sort()).toEqual([...HAZARD_CLASSES].sort());
    expect(new Set(Object.values(T.thresholds)).size).toBeGreaterThan(1); // the bars really do differ per class
  });

  it('the cooldown: the same class is muted for 5 s after a confirmation, then counts again', async () => {
    const p = new Phone().placeAt(spot(0));
    expect(T.cooldownMs).toBe(5000);

    await p.look([det('pothole', 0.8)], 3);
    expect(p.confirmed).toBe(1);

    p.wait(1500);
    await p.look([det('pothole', 0.8)], 3); // a complete new streak, but inside the cooldown
    expect(p.confirmed).toBe(1);

    p.wait(6000);
    await p.look([det('pothole', 0.8)], 3); // past it
    expect(p.confirmed).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// Confirmed hazard
// ---------------------------------------------------------------------------------------------------

describe('Confirmed hazard + lat/lon + geohash (+ jolt boost within 1.5 s, pothole and crack)', () => {
  it('carries the GPS position and its geohash; the id is geohash:class', async () => {
    const p = new Phone().placeAt({ lat: 14.58512, lon: 121.17634 });
    await p.look([det('crack', 0.7)], 3);
    const h = await p.only();
    expect(h).toMatchObject({ cls: 'crack', lat: 14.58512, lon: 121.17634, geohash: encodeGeohash(14.58512, 121.17634), deviceIds: [p.deviceId] });
    expect(h.id).toBe(`${h.geohash}:crack`);
  });

  it('without a usable GPS fix nothing is saved, and the pipeline says why instead of inventing a position', async () => {
    const p = new Phone(); // never placed: no fix
    await p.look([det('pothole', 0.9)], 3);
    expect(await p.store.getAll()).toEqual([]);
    expect(p.events).toEqual([expect.objectContaining({ type: 'no-fix', reason: expect.stringMatching(/GPS/) })]);
  });

  it('a jolt within 1.5 s raises pothole and crack, whether it came just before or just after', async () => {
    for (const cls of ['pothole', 'crack'] as const) {
      const after = new Phone().placeAt(spot(0));
      await after.look([det(cls, 0.6)], 3);
      await after.joltAfter(900); // the usual order: the camera sees it first, the wheel hits it later
      expect((await after.only()).confidence).toBeCloseTo(0.6 + T.joltBoost, 10);

      const before = new Phone().placeAt(spot(0));
      await before.joltAt(100);
      await before.look([det(cls, 0.6)], 3);
      expect((await before.only()).confidence).toBeCloseTo(0.6 + T.joltBoost, 10);
    }
    expect(T.joltWindowMs).toBe(1500);
  });

  it('never boosts a flooded road, and a jolt outside the 1.5 s window boosts nothing', async () => {
    const water = new Phone().placeAt(spot(0));
    await water.look([det('flooded_road', 0.7)], 3);
    await water.joltAfter(500);
    expect((await water.only()).confidence).toBeCloseTo(0.7, 10);

    const late = new Phone().placeAt(spot(0));
    await late.look([det('pothole', 0.6)], 3);
    await late.joltAfter(1600);
    expect((await late.only()).confidence).toBeCloseTo(0.6, 10);
  });
});

// ---------------------------------------------------------------------------------------------------
// Save locally
// ---------------------------------------------------------------------------------------------------

describe('Save locally: store + shared mergeHazard + pending-sync flag', () => {
  it('a confirmed hazard is stored on the phone and flagged pending-sync, with no hub anywhere', async () => {
    const p = new Phone().placeAt(spot(0));
    await p.look([det('pothole', 0.8)], 3);
    expect(await p.store.getAll()).toHaveLength(1);
    expect(await p.store.getPending()).toHaveLength(1);
    expect(p.sync.status.state).toBe('idle'); // never connected, and it did not matter
  });

  it('seeing the same pothole again merges into the same record instead of piling up', async () => {
    const p = new Phone().placeAt(spot(0));
    await p.look([det('pothole', 0.7)], 3);
    p.wait(6000);
    await p.look([det('pothole', 0.9)], 3);
    expect(p.confirmed).toBe(2);
    const h = await p.only();
    expect(h.confidence).toBeCloseTo(0.9, 10);
    expect(confirmationCount(h)).toBe(1); // one phone seeing it twice is still one confirmation
  });

  it('another phone\'s report of the same spot is merged with the shared mergeHazard (a second confirmation, the higher confidence)', async () => {
    const p = new Phone().placeAt(spot(0));
    await p.look([det('pothole', 0.7)], 3);
    const mine = await p.only();
    const theirs = createHazard({ cls: 'pothole', lat: mine.lat, lon: mine.lon, confidence: 0.95, deviceId: 'someone-else', now: Date.now() });

    await p.store.applyRemote(theirs);
    const merged = await p.only();
    expect(merged).toEqual(mergeHazard(mine, theirs));
    expect(confirmationCount(merged)).toBe(2);
    expect(merged.confidence).toBeCloseTo(0.95, 10);
  });
});

// ---------------------------------------------------------------------------------------------------
// Offline map
// ---------------------------------------------------------------------------------------------------

describe('Offline map (Leaflet, colour per class, confirmation count, local tiles)', () => {
  it('is fed by the local store alone: a detection reaches it with no hub and no internet', async () => {
    const p = new Phone().placeAt(spot(0));
    await p.look([det('flooded_road', 0.8)], 3);
    expect(p.changes).toEqual([expect.objectContaining({ kind: 'upsert', origin: 'local', hazard: expect.objectContaining({ cls: 'flooded_road' }) })]);
  });

  it('a colour per class, a count taken from the confirming devices, and tiles from the app\'s own origin', () => {
    expect(new Set(HAZARD_CLASSES.map((cls) => CLASS_STYLE[cls].color)).size).toBe(HAZARD_CLASSES.length);
    const two = createHazard({ cls: 'pothole', lat: 14.585, lon: 121.176, confidence: 0.8, deviceId: 'a', now: Date.now() });
    expect(confirmationCount(mergeHazard(two, { ...two, deviceIds: ['b'] }))).toBe(2);
    expect(loadConfig('', { protocol: 'https:', host: '192.168.43.2:8443' }).tiles.urlTemplate).toBe('/tiles/{z}/{x}/{y}.png'); // no tile server on the internet
  });
});

// ---------------------------------------------------------------------------------------------------
// Hub reachable? / queue / WebSocket client
// ---------------------------------------------------------------------------------------------------

describe('"Hub reachable over hotspot?"', () => {
  it('NO: detections are saved and queued while the hub is down; YES (on reconnect): hello first, then the queue as a diff, then live hazard updates', async () => {
    const world = await makeWorld({ running: false });
    const a = new Phone(world.url).placeAt(spot(0)).connect();
    await until(() => ['backoff', 'offline'].includes(a.sync.status.state), 'A to notice the hub is down');

    // two hazards found with no hub: both saved, both queued, and the map has them
    await a.look([det('pothole', 0.8)], 3);
    a.wait(6000);
    a.placeAt(spot(100));
    await a.look([det('crack', 0.7)], 3);
    expect(await a.store.getAll()).toHaveLength(2);
    expect(await a.store.pendingCount()).toBe(2);
    await until(() => a.sync.status.pending === 2, 'the queue length to show in the sync status');
    expect(world.hubStore.size).toBe(0);

    // the hotspot comes back: the client finds it again by itself (backoff), no tap needed
    await world.start();
    await until(() => connected(a), 'A to reconnect on its own', 15_000);
    await until(() => world.hubStore.size === 2, 'the queued hazards to reach the hub');
    await until(async () => (await a.store.pendingCount()) === 0, "the hub's acknowledgement to empty the queue");

    const onTheWire = a.sent.filter((type) => type !== 'ping');
    expect(onTheWire[0]).toBe('hello'); // hello first ...
    expect(onTheWire.slice(1)).toContain('diff'); // ... then the queue, as a diff
    expect(onTheWire.filter((type) => type === 'hazard' || type === 'diff').length).toBeGreaterThan(0);

    // connected now: the next detection goes out on its own, as a single hazard update
    a.wait(6000);
    a.placeAt(spot(200));
    await a.look([det('flooded_road', 0.9)], 3);
    await until(() => world.hubStore.size === 3, 'the live hazard to reach the hub');
    expect(a.sent.filter((type) => type !== 'ping').at(-1)).toBe('hazard');
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------------------------------

describe('Hub: express + ws over HTTPS, merge every hazard, answer hello with diff, broadcast, JSON snapshot every 10 s, sweep expired', () => {
  it('is HTTPS: a client that does not trust the hub\'s CA cannot even connect', async () => {
    const world = await makeWorld();
    expect(world.url.startsWith('wss://')).toBe(true);
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(world.url);
        ws.once('open', () => resolve('connected'));
        ws.once('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('express: serves the built PWA over HTTPS, so every phone gets the same app from the same place as the WebSocket', async () => {
    const world = await makeWorld();
    fs.mkdirSync(path.join(world.staticDir, 'assets'));
    fs.writeFileSync(path.join(world.staticDir, 'index.html'), '<!doctype html><title>Lubak Alert</title><div id="app"></div>');
    fs.writeFileSync(path.join(world.staticDir, 'assets', 'app-0f3a9c.js'), 'console.log("lubak alert")');

    const root = `https://127.0.0.1:${world.hub.port}`;
    expect(await httpsGet(`${root}/`)).toMatchObject({ status: 200, type: expect.stringMatching(/text\/html/), body: expect.stringContaining('<div id="app">'), cacheControl: 'no-cache' }); // the shell is always revalidated
    expect(await httpsGet(`${root}/assets/app-0f3a9c.js`)).toMatchObject({ status: 200, cacheControl: expect.stringMatching(/immutable/) }); // hashed assets are cached for good
    expect(JSON.parse((await httpsGet(`${root}/healthz`)).body)).toMatchObject({ ok: true });
  });

  it('merges every hazard: a report of a spot the hub already knows becomes ONE hazard with both confirmations and the higher confidence, merged by the shared function, and the sender is told the result', async () => {
    const world = await makeWorld();
    const a = new Phone(world.url).placeAt(spot(0)).connect();
    await until(() => connected(a), 'A to reach the hub');
    await a.look([det('pothole', 0.7)], 3);
    await until(() => world.hubStore.size === 1, "A's report");
    a.sync.stop(); // A drives off: from now on only the hub remembers what A saw

    // A bare protocol client has no store and merges nothing, so if what comes back is merged, the hub did it.
    const first = await a.only();
    const second = createHazard({ cls: 'pothole', lat: first.lat, lon: first.lon, confidence: 0.9, deviceId: 'bare-client', now: Date.now() });
    const client = await TestClient.connect(world.url, { ca: tls.caCertPem });
    client.send({ type: 'hazard', hazard: second });
    const ack = await client.waitFor('hazard', (m) => m.hazard.id === first.id);
    await client.close();

    expect(ack.hazard).toEqual(mergeHazard(first, second)); // the hub's reply to the sender is the merged state ...
    expect(confirmationCount(ack.hazard)).toBe(2);
    expect(ack.hazard.confidence).toBeCloseTo(0.9, 10);
    expect(world.hubStore.size).toBe(1); // ... one hazard, not two records ...
    expect(world.hubStore.all()[0]).toEqual(ack.hazard); // ... and that is what the hub keeps
  });

  it('two phones at the same pothole end as one hazard with two confirmations and the higher confidence on the hub and on both phones, even though the first had left in between', async () => {
    const world = await makeWorld();
    const a = new Phone(world.url).placeAt(spot(0)).connect();
    await until(() => connected(a), 'A to reach the hub');
    await a.look([det('pothole', 0.7)], 3);
    await until(() => world.hubStore.size === 1, "A's report");
    a.sync.stop(); // A drives off

    const b = new Phone(world.url).placeAt(spot(0)).connect(); // B's hello brings it A's hazard, so B's own store merges the two
    await until(() => connected(b), 'B to reach the hub');
    await b.look([det('pothole', 0.9)], 3);
    await until(() => world.hubStore.all().some((h) => confirmationCount(h) === 2), 'the hub to hold the second confirmation');
    expect(world.hubStore.size).toBe(1);
    expect(world.hubStore.all()[0]!.confidence).toBeCloseTo(0.9, 10);
    await until(async () => confirmationCount(await b.only()) === 2, 'B to hold it too');

    a.sync.start(); // A comes back: its hello gets the merged hazard as a diff
    await until(async () => confirmationCount(await a.only()) === 2, 'A to catch up');
    expect(await phoneState(a)).toEqual(hubState(world));
    expect(await phoneState(b)).toEqual(hubState(world));
  });

  it('broadcasts: a phone that is already connected hears about a hazard without asking, and its map is told', async () => {
    const world = await makeWorld();
    const a = new Phone(world.url).placeAt(spot(0)).connect();
    const b = new Phone(world.url).connect();
    await until(() => connected(a, b), 'both phones to reach the hub');

    await a.look([det('crack', 0.8)], 3);
    await until(async () => (await b.store.getAll()).length === 1, 'B to hear about it');
    expect(b.changes).toEqual([expect.objectContaining({ kind: 'upsert', origin: 'remote' })]); // what the map listens to
    expect(await b.store.getPending()).toEqual([]); // it is the hub's data, nothing for B to send back
  });

  it('answers a hello with a diff: a phone that joins later receives everything it lacks and ends identical to the hub', async () => {
    const world = await makeWorld();
    const a = new Phone(world.url).placeAt(spot(0)).connect();
    await until(() => connected(a), 'A to reach the hub');
    await a.look([det('pothole', 0.8)], 3);
    a.wait(6000);
    a.placeAt(spot(100));
    await a.look([det('crack', 0.7)], 3);
    await until(() => world.hubStore.size === 2, 'the hub to hold both');

    const late = new Phone(world.url).connect();
    await until(async () => (await late.store.getAll()).length === 2, 'the late phone to receive the diff');
    expect(await phoneState(late)).toEqual(hubState(world));
  });

  it('writes a JSON snapshot on a timer (every 10 s by default) and a fresh hub restores it', async () => {
    const cfg = loadHubConfig({}, []);
    expect(cfg === 'help' ? null : cfg.snapshotMs).toBe(10_000);

    const world = await makeWorld({ snapshotMs: 40 }); // same code, shorter clock
    const a = new Phone(world.url).placeAt(spot(0)).connect();
    await until(() => connected(a), 'A to reach the hub');
    await a.look([det('pothole', 0.8)], 3);

    const file = path.join(world.dataDir, SNAPSHOT_FILE);
    await until(() => fs.existsSync(file), 'the snapshot file');
    const reborn = new HubStore({ dataDir: world.dataDir });
    expect(reborn.load()).toBe(1);
    expect(reborn.all()[0]).toEqual(world.hubStore.all()[0]);
  });

  it('sweeps expired hazards: a flooded road is gone after its 6 h, a pothole is still there, and a later phone is not handed the dead one', async () => {
    const world = await makeWorld({ sweepMs: 40 });
    const a = new Phone(world.url).placeAt(spot(0)).connect();
    await until(() => connected(a), 'A to reach the hub');
    await a.look([det('flooded_road', 0.9)], 3);
    a.wait(6000);
    a.placeAt(spot(100));
    await a.look([det('pothole', 0.8)], 3);
    await until(() => world.hubStore.size === 2, 'the hub to hold both');

    world.ageBy(7 * HOUR_MS);
    await until(() => world.hubStore.size === 1, 'the sweep to drop the flooded road');
    expect(world.hubStore.all().map((h) => h.cls)).toEqual(['pothole']);

    const late = new Phone(world.url).connect();
    await until(() => connected(late), 'the late phone to connect');
    await until(async () => (await late.store.getAll()).length === 1, 'the late phone to receive the diff');
    expect((await late.store.getAll()).map((h) => h.cls)).toEqual(['pothole']);
  });
});

// ---------------------------------------------------------------------------------------------------
// Other phones, and the fake device
// ---------------------------------------------------------------------------------------------------

describe('Other phones: apply diff, merge, update store + map', () => {
  it('the whole chart with three phones: detect, save, share, merge, catch up', async () => {
    const world = await makeWorld();
    const a = new Phone(world.url).connect();
    const b = new Phone(world.url).connect();
    await until(() => connected(a, b), 'A and B to reach the hub');

    // A drives past a pothole: confirmed (3 frames), saved locally, then shared
    a.placeAt(spot(0));
    await a.look([det('pothole', 0.8)], 3);
    await until(() => world.hubStore.size === 1, 'the hub to merge A\'s hazard');
    await until(async () => (await a.store.pendingCount()) === 0, "the hub's echo to clear A's queue");

    // B, already connected, applies it and its map is told
    await until(async () => (await b.store.getAll()).length === 1, 'B to apply it');
    expect(b.changes.some((c) => c.kind === 'upsert' && c.origin === 'remote')).toBe(true);

    // B rides over the same pothole: still one hazard, now confirmed by two phones, on every screen
    b.placeAt(spot(0));
    await b.look([det('pothole', 0.9)], 3);
    await until(async () => confirmationCount(await a.only()) === 2, 'A to learn that B confirmed it too');
    expect(world.hubStore.size).toBe(1);

    // C joins after the fact: the hub answers its hello with a diff
    const c = new Phone(world.url).connect();
    await until(async () => (await c.store.getAll()).length === 1, 'C to catch up');

    for (const phone of [a, b, c]) expect(await phoneState(phone)).toEqual(hubState(world));
  });
});

describe('Fake device tool: hazards near Antipolo, Rizal', () => {
  it('connects like a phone, reports hazards along the test route, and they reach the hub and a real phone', async () => {
    const world = await makeWorld();
    const b = new Phone(world.url).connect();
    await until(() => connected(b), 'the phone to reach the hub');

    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const run = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [tsx, path.join(REPO, 'hub', 'tools', 'fake-device.ts'), '--url', world.url, '--ca', tls.caCertPath, '--count', '8', '--rate', '20', '--devices', '2', '--spots', '6'], {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the fake device did not finish:\n${output}`));
      }, 25_000);
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });

    expect(run.code, run.output).toBe(0);
    expect(world.hubStore.size).toBeGreaterThan(0);
    for (const h of world.hubStore.all()) expect(haversineMeters(DEMO_CENTER, h)).toBeLessThan(5000); // Antipolo, not the middle of the ocean
    await until(async () => JSON.stringify(await phoneState(b)) === JSON.stringify(hubState(world)), 'the phone to hold what the hub holds');
  }, 40_000);
});
