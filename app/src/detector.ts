/**
 * detector.ts: the detection contract and its implementations.
 *
 *   interface Detector { init(); detect(frame, nowMs) -> { detections, inferenceMs }; info(); dispose() }
 *
 * - MockDetector  : random but temporally coherent boxes, so the whole pipeline runs before a model exists.
 * - OnnxDetector  : onnxruntime-web (WebGPU with automatic WASM fallback) running the YOLOv8n export. (stage 4)
 * - ReplayDetector (demo.ts) implements the same interface for Demo Mode.
 *
 * Boxes are NORMALISED to the source frame (0..1, top-left origin), so overlays never depend on resolution.
 */

import { HAZARD_CLASSES, type HazardClass } from '@lubak/shared';
import type { AppConfig, DetectorChoice } from './config.js';
import { between, clamp, intBetween, mulberry32, weightedPick, type Rng } from './rng.js';

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Detection {
  cls: HazardClass;
  /** Index into HAZARD_CLASSES (the model's class index). */
  classId: number;
  confidence: number;
  box: Box;
}

export interface DetectResult {
  detections: Detection[];
  /** Wall-clock time spent inside detect(), measured, never simulated. */
  inferenceMs: number;
}

export type FrameSource = HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | ImageBitmap;

export interface DetectorInfo {
  kind: 'mock' | 'onnx' | 'replay';
  /** 'mock', 'replay', 'webgpu' or 'wasm'. */
  backend: string;
  ready: boolean;
  model: string | null;
  loadMs: number | null;
  error: string | null;
}

export interface Detector {
  init(): Promise<void>;
  detect(frame: FrameSource, nowMs: number): Promise<DetectResult>;
  info(): DetectorInfo;
  dispose(): void;
}

export const classIdOf = (cls: HazardClass): number => HAZARD_CLASSES.indexOf(cls);

// ---------------------------------------------------------------------------------------------------
// MockDetector
// ---------------------------------------------------------------------------------------------------

export interface MockDetectorOptions {
  seed?: number;
  /** Gap between virtual hazards appearing, ms. */
  spawnEveryMs?: readonly [number, number];
  /** How many consecutive frames a virtual hazard stays in view. */
  framesVisible?: readonly [number, number];
}

interface VirtualHazard {
  cls: HazardClass;
  baseConfidence: number;
  total: number;
  seen: number;
  /** Start and end centre / size, as fractions of the frame: the object grows and slides down as the vehicle approaches. */
  from: { cx: number; cy: number; w: number; h: number };
  to: { cx: number; cy: number; w: number; h: number };
}

/**
 * Random boxes, but not white noise: every few seconds a virtual hazard "appears", stays in view for several
 * frames while drifting towards the camera, then disappears; low-confidence junk boxes are sprinkled in too.
 * That is what a real detector looks like to the Confirmer, so streaks, thresholds and cooldowns all get exercised.
 * Reports REAL elapsed time as inferenceMs (it is simply tiny).
 */
export class MockDetector implements Detector {
  private readonly rng: Rng;
  private readonly gap: readonly [number, number];
  private readonly visible: readonly [number, number];
  private active: VirtualHazard[] = [];
  private nextSpawnAt: number | null = null;
  private ready = false;

  constructor(options: MockDetectorOptions = {}) {
    this.rng = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.gap = options.spawnEveryMs ?? [2500, 6000];
    this.visible = options.framesVisible ?? [4, 9];
  }

  async init(): Promise<void> {
    this.ready = true;
  }

  info(): DetectorInfo {
    return { kind: 'mock', backend: 'mock', ready: this.ready, model: null, loadMs: 0, error: null };
  }

  async detect(_frame: FrameSource, nowMs: number): Promise<DetectResult> {
    const started = performance.now();
    const { rng } = this;

    if (this.nextSpawnAt === null) this.nextSpawnAt = nowMs + between(rng, 800, 2000);
    if (nowMs >= this.nextSpawnAt) {
      this.active.push(this.spawn());
      this.nextSpawnAt = nowMs + between(rng, this.gap[0], this.gap[1]);
    }

    const detections: Detection[] = [];
    for (const h of this.active) {
      const p = h.total <= 1 ? 1 : h.seen / (h.total - 1);
      const lerp = (a: number, b: number): number => a + (b - a) * p;
      const cx = lerp(h.from.cx, h.to.cx) + between(rng, -0.01, 0.01);
      const cy = lerp(h.from.cy, h.to.cy) + between(rng, -0.01, 0.01);
      const w = lerp(h.from.w, h.to.w);
      const ht = lerp(h.from.h, h.to.h);
      detections.push({
        cls: h.cls,
        classId: classIdOf(h.cls),
        confidence: clamp(h.baseConfidence + between(rng, -0.05, 0.05), 0.01, 0.99),
        box: clampBox({ x1: cx - w / 2, y1: cy - ht / 2, x2: cx + w / 2, y2: cy + ht / 2 }),
      });
      h.seen += 1;
    }
    this.active = this.active.filter((h) => h.seen < h.total);

    // low-confidence junk the Confirmer must ignore
    const junk = rng() < 0.4 ? intBetween(rng, 1, 2) : 0;
    for (let i = 0; i < junk; i++) {
      const cls = HAZARD_CLASSES[intBetween(rng, 0, HAZARD_CLASSES.length - 1)]!;
      const cx = between(rng, 0.1, 0.9);
      const cy = between(rng, 0.4, 0.95);
      const w = between(rng, 0.05, 0.2);
      const h = between(rng, 0.04, 0.15);
      detections.push({
        cls,
        classId: classIdOf(cls),
        confidence: between(rng, 0.06, 0.28),
        box: clampBox({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 }),
      });
    }

    return { detections, inferenceMs: performance.now() - started };
  }

  dispose(): void {
    this.active = [];
    this.ready = false;
  }

  private spawn(): VirtualHazard {
    const { rng } = this;
    const cls = weightedPick<HazardClass>(rng, [
      ['pothole', 0.5],
      ['crack', 0.35],
      ['flooded_road', 0.15],
    ]);
    const lane = between(rng, 0.25, 0.75);
    const wide = cls === 'flooded_road';
    return {
      cls,
      baseConfidence: between(rng, 0.45, 0.92),
      total: intBetween(rng, this.visible[0], this.visible[1]),
      seen: 0,
      from: { cx: lane, cy: 0.5, w: wide ? 0.3 : 0.08, h: wide ? 0.08 : 0.06 },
      to: { cx: clamp(lane + between(rng, -0.12, 0.12), 0.1, 0.9), cy: between(rng, 0.78, 0.92), w: wide ? 0.8 : 0.3, h: wide ? 0.2 : 0.2 },
    };
  }
}

export function clampBox(b: Box): Box {
  return { x1: clamp(b.x1, 0, 1), y1: clamp(b.y1, 0, 1), x2: clamp(b.x2, 0, 1), y2: clamp(b.y2, 0, 1) };
}

// ---------------------------------------------------------------------------------------------------
// Selecting a detector
// ---------------------------------------------------------------------------------------------------

export interface DetectorSelection {
  detector: Detector;
  requested: DetectorChoice;
  /** Why the requested detector was not used (e.g. model file missing). null when it was. */
  fellBackBecause: string | null;
}

/**
 * Pick the detector named by the flag. `auto` tries the real model and falls back to the mock WITH A REASON, which the
 * Drive screen shows as a red MOCK badge: a silent fallback would let a demo pass off random boxes as real inference.
 */
export async function createDetector(config: Pick<AppConfig, 'detector' | 'modelUrl' | 'inputSize'>): Promise<DetectorSelection> {
  if (config.detector === 'mock') {
    const detector = new MockDetector();
    await detector.init();
    return { detector, requested: 'mock', fellBackBecause: null };
  }
  // The ONNX detector is wired in the next commit; until then 'auto' means mock and 'onnx' is an explicit error.
  if (config.detector === 'onnx') throw new Error('The ONNX detector is not wired yet (stage 4).');
  const detector = new MockDetector();
  await detector.init();
  return { detector, requested: 'auto', fellBackBecause: 'real detector not wired yet' };
}
