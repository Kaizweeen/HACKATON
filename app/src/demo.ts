/**
 * demo.ts: Demo Mode, a prerecorded 60-second drive that replays through the REAL pipeline.
 *
 * If the model or camera misbehaves on stage, flip the Demo Mode switch: a synthetic camera, scripted detections,
 * scripted accelerometer jolts and a GPS path along the Antipolo test route feed the same Confirmer -> store -> sync ->
 * map code that real data would. Hazards land at fixed places (each encounter has a fixed spot on the route), so two
 * phones running the demo confirm the SAME hazards and the map shows "x2".
 *
 * Honesty: everything here is labelled DEMO in the UI and in the Debug screen. Nothing in this file is a measurement.
 * The script deliberately contains a blip that is too short and a stretch that is below threshold, which the Confirmer must reject.
 */

import { demoRoute, pointAlongPath, type HazardClass } from '@lubak/shared';
import type { CameraState, Frame, FrameProvider } from './camera.js';
import { classIdOf, clampBox, type Box, type Detection, type DetectResult, type Detector, type DetectorInfo, type FrameSource } from './detector.js';
import { clamp, mulberry32 } from './rng.js';
import type { GeoFix, GeoStatus, JoltEvent, LocationSource, MotionSource, MotionStatus } from './sensors.js';

export const DEMO_FPS = 8;
export const DEMO_LAP_S = 60;
/** About 25 km/h. */
export const DEMO_SPEED_MPS = 7;

export interface DemoEncounter {
  /** Seconds into the lap when the object first appears. */
  at: number;
  cls: HazardClass;
  confidence: number;
  /** Consecutive frames it stays in view. */
  frames: number;
  /** A jolt this long (seconds) after the confirmation, with this peak. Omitted = no bump (cracks, floods, blips). */
  jolt?: { delay: number; magnitude: number };
  /** What the Confirmer is expected to do, used by the unit test that guards this script. */
  expect: 'confirm' | 'reject';
}

export const DEMO_ENCOUNTERS: readonly DemoEncounter[] = [
  { at: 5, cls: 'pothole', confidence: 0.84, frames: 6, jolt: { delay: 0.8, magnitude: 7.2 }, expect: 'confirm' },
  { at: 11, cls: 'crack', confidence: 0.63, frames: 6, jolt: { delay: 1.0, magnitude: 4.6 }, expect: 'confirm' },
  { at: 16, cls: 'pothole', confidence: 0.72, frames: 2, expect: 'reject' }, // strong but only 2 frames
  { at: 20, cls: 'flooded_road', confidence: 0.77, frames: 10, expect: 'confirm' },
  { at: 27, cls: 'pothole', confidence: 0.79, frames: 5, jolt: { delay: 0.7, magnitude: 6.1 }, expect: 'confirm' },
  { at: 32, cls: 'crack', confidence: 0.2, frames: 7, expect: 'reject' }, // long but below any crack threshold (the app's floor is 0.25)
  { at: 36, cls: 'crack', confidence: 0.58, frames: 6, expect: 'confirm' },
  { at: 42, cls: 'pothole', confidence: 0.9, frames: 7, jolt: { delay: 0.9, magnitude: 8.4 }, expect: 'confirm' },
  { at: 48, cls: 'flooded_road', confidence: 0.69, frames: 9, expect: 'confirm' },
  { at: 54, cls: 'pothole', confidence: 0.52, frames: 4, jolt: { delay: 0.8, magnitude: 5.0 }, expect: 'confirm' },
];

export interface DemoScript {
  /** Detections per frame, index = frame number within the lap. */
  frames: Detection[][];
  /** Jolts as lap times (ms). */
  jolts: { t: number; magnitude: number }[];
  frameMs: number;
  lapMs: number;
}

function boxFor(cls: HazardClass, p: number, lane: number, jitter: number): Box {
  const cy = 0.55 + p * 0.33;
  const cx = lane + (lane - 0.5) * p * 0.6;
  const [w, h] =
    cls === 'pothole' ? [0.06 + p * 0.22, 0.05 + p * 0.15] : cls === 'crack' ? [0.12 + p * 0.28, 0.025 + p * 0.07] : [0.3 + p * 0.5, 0.06 + p * 0.16];
  return clampBox({ x1: cx - w / 2 + jitter, y1: cy - h / 2, x2: cx + w / 2 + jitter, y2: cy + h / 2 });
}

/** Deterministic: the same script every time. */
export function buildDemoScript(encounters: readonly DemoEncounter[] = DEMO_ENCOUNTERS, seed = 11): DemoScript {
  const rng = mulberry32(seed);
  const frameMs = 1000 / DEMO_FPS;
  const lapMs = DEMO_LAP_S * 1000;
  const total = Math.round(lapMs / frameMs);
  const frames: Detection[][] = Array.from({ length: total }, () => []);
  const jolts: { t: number; magnitude: number }[] = [];

  encounters.forEach((e, i) => {
    const first = Math.round(e.at * DEMO_FPS);
    const lane = 0.5 + 0.14 * Math.sin(i * 2.1);
    for (let k = 0; k < e.frames && first + k < total; k++) {
      const p = e.frames === 1 ? 1 : k / (e.frames - 1);
      frames[first + k]!.push({
        cls: e.cls,
        classId: classIdOf(e.cls),
        confidence: clamp(e.confidence + (rng() - 0.5) * 0.06, 0.01, 0.99),
        box: boxFor(e.cls, p, lane, (rng() - 0.5) * 0.01),
      });
    }
    if (e.jolt) {
      // the wheel reaches the object a moment after the third frame confirms it
      jolts.push({ t: (e.at + 2 / DEMO_FPS + e.jolt.delay) * 1000, magnitude: e.jolt.magnitude });
    }
  });
  jolts.sort((a, b) => a.t - b.t);
  return { frames, jolts, frameMs, lapMs };
}

const lapTime = (tMs: number, lapMs: number): number => ((tMs % lapMs) + lapMs) % lapMs;

// ---------------------------------------------------------------------------------------------------
// replacement sources
// ---------------------------------------------------------------------------------------------------

export class ReplayDetector implements Detector {
  constructor(private readonly script: DemoScript) {}

  async init(): Promise<void> {}

  info(): DetectorInfo {
    return { kind: 'replay', backend: 'replay', ready: true, model: 'DEMO script', loadMs: 0, error: null };
  }

  async detect(_frame: FrameSource, nowMs: number): Promise<DetectResult> {
    const started = performance.now();
    const detections = this.detectionsAt(nowMs).map((d) => ({ ...d, box: { ...d.box } }));
    return { detections, inferenceMs: performance.now() - started };
  }

  detectionsAt(nowMs: number): Detection[] {
    const i = Math.floor(lapTime(nowMs, this.script.lapMs) / this.script.frameMs) % this.script.frames.length;
    return this.script.frames[i] ?? [];
  }

  dispose(): void {}
}

export class DemoMotion implements MotionSource {
  private listeners = new Set<(jolt: JoltEvent) => void>();
  private active = false;
  private lastTick = 0;
  private lastJolt: JoltEvent | null = null;
  private count = 0;

  constructor(private readonly script: DemoScript) {}

  start(): boolean {
    this.active = true;
    return true;
  }
  stop(): void {
    this.active = false;
  }
  onJolt(listener: (jolt: JoltEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit every scripted jolt that fell between the previous tick and this one (handles lap wrap-around). */
  tick(tMs: number): void {
    if (!this.active) return;
    const { lapMs, jolts } = this.script;
    for (let lap = Math.floor(this.lastTick / lapMs); lap <= Math.floor(tMs / lapMs); lap++) {
      for (const j of jolts) {
        const abs = lap * lapMs + j.t;
        if (abs > this.lastTick && abs <= tMs) {
          const event: JoltEvent = { t: abs, magnitude: j.magnitude };
          this.lastJolt = event;
          this.count += 1;
          for (const l of this.listeners) l(event);
        }
      }
    }
    this.lastTick = tMs;
  }

  status(): MotionStatus {
    const age = this.lastJolt ? this.lastTick - this.lastJolt.t : Infinity;
    return {
      supported: true,
      permission: 'not-required',
      active: this.active,
      sampleRateHz: 0,
      lastSampleAgeMs: null,
      vertical: this.lastJolt && age < 600 ? this.lastJolt.magnitude * Math.exp(-age / 150) : 0,
      peak: this.lastJolt && age < 1000 ? this.lastJolt.magnitude : 0,
      thresholdMs2: 0,
      joltCount: this.count,
      lastJolt: this.lastJolt,
      note: 'DEMO: scripted jolts, no real sensor in use.',
    };
  }
}

export class DemoGeo implements LocationSource {
  private listeners = new Set<(fix: GeoFix) => void>();
  private _fix: GeoFix | null = null;
  private active = false;
  private lastSlot = -1;
  private readonly route = demoRoute();

  get fix(): GeoFix | null {
    return this._fix;
  }
  start(): boolean {
    this.active = true;
    return true;
  }
  stop(): void {
    this.active = false;
  }
  onFix(listener: (fix: GeoFix) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * One fix per second, like a phone GPS. The vehicle covers the same stretch of road every lap, and each fix is taken at a
   * whole second of lap time, not whenever a frame happens to arrive: every phone and every lap then reports the SAME
   * positions, so a scripted hazard lands in the same geohash cell everywhere (cells along a street are only ~19 m long,
   * and timer jitter of up to a second would move a fix by 7 m).
   */
  tick(tMs: number, lapMs: number): void {
    const slot = Math.floor(tMs / 1000);
    if (!this.active || slot === this.lastSlot) return;
    this.lastSlot = slot;
    const distance = DEMO_SPEED_MPS * Math.floor(lapTime(tMs, lapMs) / 1000);
    const p = pointAlongPath(this.route, distance, false);
    this._fix = { lat: p.lat, lon: p.lon, accuracy: 4, speed: DEMO_SPEED_MPS, heading: p.headingDeg, t: tMs };
    for (const l of this.listeners) l(this._fix);
  }

  status(): GeoStatus {
    return { supported: true, active: this.active, fix: this._fix, fixAgeMs: null, error: null };
  }
}

/** A drawn road scene with the scripted hazards painted where the replay detections are. Watermarked DEMO. */
export class DemoCamera implements FrameProvider {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private listeners = new Set<(frame: Frame) => void>();
  private _state: CameraState = 'idle';
  private seq = 0;
  private delivered: number[] = [];

  constructor(private readonly detector: ReplayDetector) {
    this.canvas.width = 640;
    this.canvas.height = 360;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
  }

  get state(): CameraState {
    return this._state;
  }
  get error(): string | null {
    return null;
  }
  get previewSource(): CanvasImageSource | null {
    return this._state === 'running' ? this.canvas : null;
  }
  get frameSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }
  get measuredFps(): number {
    const now = performance.now();
    this.delivered = this.delivered.filter((t) => now - t <= 2000);
    return this.delivered.length / 2;
  }
  async start(): Promise<void> {
    this._state = 'running';
  }
  stop(): void {
    this._state = 'idle';
  }
  setFps(): void {
    /* the replay runs at its recorded rate */
  }
  onFrame(listener: (frame: Frame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Draw the frame for demo time `tMs` and deliver it. */
  emit(tMs: number): void {
    if (this._state !== 'running') return;
    this.draw(tMs);
    this.delivered.push(performance.now());
    const frame: Frame = { canvas: this.canvas, width: this.canvas.width, height: this.canvas.height, t: tMs, seq: this.seq++ };
    for (const l of this.listeners) l(frame);
  }

  private draw(tMs: number): void {
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const horizon = H * 0.42;

    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#6aa8e6');
    sky.addColorStop(1, '#d6ebff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, horizon);
    ctx.fillStyle = '#5d7a4c';
    ctx.fillRect(0, horizon, W, H - horizon);

    // road
    ctx.fillStyle = '#3a3e44';
    ctx.beginPath();
    ctx.moveTo(W * 0.465, horizon);
    ctx.lineTo(W * 0.535, horizon);
    ctx.lineTo(W * 0.96, H);
    ctx.lineTo(W * 0.04, H);
    ctx.closePath();
    ctx.fill();

    // scrolling centre dashes in rough perspective
    const phase = ((tMs / 1000) * 1.4) % 1;
    ctx.fillStyle = '#f2f2f2';
    for (let k = 0; k < 9; k++) {
      const u0 = (k + phase) / 9;
      const u1 = u0 + 0.05;
      if (u1 > 1) continue;
      const y0 = horizon + (H - horizon) * u0 ** 2;
      const y1 = horizon + (H - horizon) * u1 ** 2;
      const w0 = 1 + 7 * u0;
      const w1 = 1 + 7 * u1;
      ctx.beginPath();
      ctx.moveTo(W / 2 - w0, y0);
      ctx.lineTo(W / 2 + w0, y0);
      ctx.lineTo(W / 2 + w1, y1);
      ctx.lineTo(W / 2 - w1, y1);
      ctx.closePath();
      ctx.fill();
    }

    // the scripted hazards, drawn under their boxes
    for (const d of this.detector.detectionsAt(tMs)) this.paintHazard(d, W, H);

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, 8, 74, 22);
    ctx.fillStyle = '#ffd24d';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText('DEMO', 16, 24);
  }

  private paintHazard(d: Detection, W: number, H: number): void {
    const { ctx } = this;
    const x = ((d.box.x1 + d.box.x2) / 2) * W;
    const y = ((d.box.y1 + d.box.y2) / 2) * H;
    const w = (d.box.x2 - d.box.x1) * W;
    const h = (d.box.y2 - d.box.y1) * H;
    ctx.save();
    if (d.cls === 'pothole') {
      ctx.fillStyle = '#17181a';
      ctx.beginPath();
      ctx.ellipse(x, y, w * 0.42, h * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#6b6f76';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (d.cls === 'crack') {
      ctx.strokeStyle = '#111';
      ctx.lineWidth = Math.max(2, h * 0.18);
      ctx.beginPath();
      ctx.moveTo(x - w * 0.45, y);
      for (let i = 1; i <= 6; i++) ctx.lineTo(x - w * 0.45 + (w * 0.9 * i) / 6, y + (i % 2 === 0 ? -1 : 1) * h * 0.35);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(66,133,244,0.78)';
      ctx.beginPath();
      ctx.ellipse(x, y, w * 0.48, h * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(x - w * 0.3, y + i * h * 0.18);
        ctx.lineTo(x + w * 0.3, y + i * h * 0.18);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** All four scripted sources on one virtual clock. */
export class DemoSession {
  readonly script = buildDemoScript();
  readonly detector = new ReplayDetector(this.script);
  readonly camera = new DemoCamera(this.detector);
  readonly motion = new DemoMotion(this.script);
  readonly geo = new DemoGeo();
  private t0 = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** ms since the demo started (monotonic); this is the `t` of every frame, jolt and fix. */
  readonly clock = (): number => performance.now() - this.t0;

  get running(): boolean {
    return this.timer !== null;
  }

  async start(): Promise<void> {
    if (this.timer !== null) return;
    this.t0 = performance.now();
    this.geo.start();
    this.motion.start();
    await this.camera.start();
    this.tick();
    this.timer = setInterval(() => this.tick(), this.script.frameMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.camera.stop();
    this.motion.stop();
    this.geo.stop();
  }

  private tick(): void {
    const t = this.clock();
    this.geo.tick(t, this.script.lapMs); // position and jolts first, so they are current when the frame is processed
    this.motion.tick(t);
    this.camera.emit(t);
  }
}

