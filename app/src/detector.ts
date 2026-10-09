/**
 * detector.ts: the detection contract and its implementations.
 *
 *   interface Detector { init(); detect(frame, nowMs) -> { detections, inferenceMs }; info(); dispose() }
 *
 * - MockDetector  : random but temporally coherent boxes, so the whole pipeline runs before a model exists.
 * - OnnxDetector  : onnxruntime-web (WebGPU with automatic WASM fallback) running the YOLOv8n export.
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
  /** Where the time of the last frame went (OnnxDetector only). */
  timings?: { preMs: number; runMs: number; postMs: number };
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
// Pure image / tensor maths (no DOM, no ORT): letterbox, YOLOv8 output parsing, class-aware NMS
// ---------------------------------------------------------------------------------------------------

/** How a source frame was fitted into the square model input. */
export interface Letterbox {
  size: number;
  srcW: number;
  srcH: number;
  /** Uniform scale before rounding the resized size. */
  scale: number;
  /**
   * The scale actually applied per axis once the resized width / height are rounded to whole pixels (newW / srcW, newH / srcH).
   * Map boxes back with THESE, as Ultralytics does: for odd frame sizes they differ from `scale` by up to ~0.2%.
   */
  scaleX: number;
  scaleY: number;
  /** Size of the resized picture inside the square. */
  newW: number;
  newH: number;
  /** Left / top padding in model-input pixels. */
  padX: number;
  padY: number;
}

/** Grey used for the padding, same as Ultralytics (114/255). */
export const LETTERBOX_GREY = 114;

/** Fit srcW x srcH into a size x size square without distorting it, centred, padded with grey. */
export function computeLetterbox(srcW: number, srcH: number, size: number = 320): Letterbox {
  if (!(srcW > 0) || !(srcH > 0)) throw new RangeError(`bad frame size ${srcW}x${srcH}`);
  const scale = Math.min(size / srcW, size / srcH);
  const newW = Math.max(1, Math.min(size, Math.round(srcW * scale)));
  const newH = Math.max(1, Math.min(size, Math.round(srcH * scale)));
  return { size, srcW, srcH, scale, scaleX: newW / srcW, scaleY: newH / srcH, newW, newH, padX: Math.floor((size - newW) / 2), padY: Math.floor((size - newH) / 2) };
}

export interface ParseOptions {
  numClasses: number;
  /** Candidates below this score are dropped before NMS. */
  confThreshold: number;
  /** Safety cap on candidates entering NMS (highest scores kept). */
  maxCandidates?: number;
}

/** Thrown when the model does not look like the YOLOv8 export this app expects. */
export class ModelShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelShapeError';
  }
}

export function checkOutputShape(dims: readonly number[], numClasses: number): number {
  const want = 4 + numClasses;
  if (dims.length !== 3 || dims[0] !== 1 || (dims[1] ?? 0) <= 4 || (dims[2] ?? 0) < 1) {
    throw new ModelShapeError(`Unexpected model output shape [${dims.join(', ')}]. Expected [1, ${want}, N] (a YOLOv8 detection export with ${numClasses} classes).`);
  }
  if (dims[1] !== want) {
    throw new ModelShapeError(
      `The model has ${(dims[1] ?? 0) - 4} classes but the app expects ${numClasses} (${HAZARD_CLASSES.join(', ')}). Re-export with that class list and order.`,
    );
  }
  return dims[2]!;
}

/** A decoded box before NMS. `box` is in MODEL-INPUT pixels, not clipped to anything (that is what Ultralytics runs NMS on). */
export interface Candidate {
  classId: number;
  confidence: number;
  box: Box;
}

/**
 * Decode a YOLOv8 output tensor of shape [1, 4 + nc, N] (channel-major: data[c * N + i]). Rows 0..3 are cx, cy, w, h in model-input
 * pixels; rows 4.. are class scores. Each anchor keeps only its best class (Ultralytics' default, `multi_label=False`); anchors whose
 * score is not >= confThreshold (NaN included) are dropped. No clipping, no NMS.
 */
export function decodeYolo(data: ArrayLike<number>, dims: readonly number[], opts: ParseOptions): Candidate[] {
  const n = checkOutputShape(dims, opts.numClasses);
  if (data.length < (4 + opts.numClasses) * n) throw new ModelShapeError(`Output has ${data.length} values, expected ${(4 + opts.numClasses) * n}.`);

  const out: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestScore = -Infinity;
    for (let c = 0; c < opts.numClasses; c++) {
      const score = data[(4 + c) * n + i]!;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!(bestScore >= opts.confThreshold) || best < 0) continue; // also rejects NaN

    const cx = data[i]!;
    const cy = data[n + i]!;
    const w = data[2 * n + i]!;
    const h = data[3 * n + i]!;
    if (!(w > 0) || !(h > 0)) continue; // NaN or degenerate
    out.push({ classId: best, confidence: bestScore, box: { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 } });
  }

  const cap = opts.maxCandidates ?? 300;
  if (out.length > cap) {
    out.sort((a, b) => b.confidence - a.confidence);
    out.length = cap;
  }
  return out;
}

/**
 * Map candidates from model-input pixels to NORMALISED source-frame coordinates (undo the letterbox), clamp to the frame and
 * drop anything that ends up with no area (e.g. lying entirely in the grey padding).
 */
export function toDetections(candidates: readonly Candidate[], lb: Letterbox): Detection[] {
  const out: Detection[] = [];
  for (const c of candidates) {
    const box = clampBox({
      x1: (c.box.x1 - lb.padX) / lb.scaleX / lb.srcW,
      y1: (c.box.y1 - lb.padY) / lb.scaleY / lb.srcH,
      x2: (c.box.x2 - lb.padX) / lb.scaleX / lb.srcW,
      y2: (c.box.y2 - lb.padY) / lb.scaleY / lb.srcH,
    });
    if (!(box.x2 > box.x1) || !(box.y2 > box.y1)) continue;
    out.push({ cls: HAZARD_CLASSES[c.classId]!, classId: c.classId, confidence: c.confidence, box });
  }
  return out;
}

/** decode + map, WITHOUT non-maximum suppression. Handy in tests; the pipeline uses postprocess(). */
export function parseYoloOutput(data: ArrayLike<number>, dims: readonly number[], lb: Letterbox, opts: ParseOptions): Detection[] {
  return toDetections(decodeYolo(data, dims, opts), lb);
}

export function iou(a: Box, b: Box): number {
  const iw = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const ih = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Class-aware non-maximum suppression: within each class, keep the highest-scoring box and drop others that overlap it by
 * MORE than `iouThreshold`. A pothole box never suppresses a crack box. Highest confidence first in the result.
 * Works on any box units (model pixels or normalised), so it can run before clipping like Ultralytics does.
 */
export function nms<T extends { classId: number; confidence: number; box: Box }>(candidates: readonly T[], iouThreshold = 0.45, maxDetections = 50): T[] {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const keptByClass = new Map<number, T[]>();
  const result: T[] = [];
  for (const d of sorted) {
    const kept = keptByClass.get(d.classId) ?? [];
    if (kept.some((k) => iou(k.box, d.box) > iouThreshold)) continue;
    kept.push(d);
    keptByClass.set(d.classId, kept);
    result.push(d);
    if (result.length >= maxDetections) break;
  }
  return result;
}

export interface PostprocessOptions extends ParseOptions {
  iouThreshold: number;
  maxDetections: number;
}

/**
 * The full decode, in the same order Ultralytics uses (so the confidence / IoU thresholds you tune with `yolo val` mean the
 * same thing here): threshold -> class-aware NMS on the unclipped model-space boxes -> undo the letterbox, clamp, drop empties.
 */
export function postprocess(data: ArrayLike<number>, dims: readonly number[], lb: Letterbox, opts: PostprocessOptions): Detection[] {
  return toDetections(nms(decodeYolo(data, dims, opts), opts.iouThreshold, opts.maxDetections), lb);
}

/** Letterboxed RGB, planar CHW, 0..1: the layout Ultralytics' ONNX export expects. `rgba` is a size*size*4 ImageData buffer. */
export function rgbaToChw(rgba: ArrayLike<number>, size: number, out: Float32Array): void {
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    out[i] = rgba[i * 4]! / 255;
    out[plane + i] = rgba[i * 4 + 1]! / 255;
    out[2 * plane + i] = rgba[i * 4 + 2]! / 255;
  }
}

/** Draws a frame into a size x size canvas with letterboxing and returns the model input. Reuses its buffers. */
export class Preprocessor {
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  readonly data: Float32Array;

  constructor(readonly size: number) {
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(size, size);
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.width = size;
      this.canvas.height = size;
    }
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.data = new Float32Array(3 * size * size);
  }

  prepare(frame: FrameSource): Letterbox {
    const srcW = frame instanceof HTMLVideoElement ? frame.videoWidth : frame.width;
    const srcH = frame instanceof HTMLVideoElement ? frame.videoHeight : frame.height;
    const lb = computeLetterbox(srcW, srcH, this.size);
    const { ctx, size } = this;
    ctx.fillStyle = `rgb(${LETTERBOX_GREY},${LETTERBOX_GREY},${LETTERBOX_GREY})`;
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low'; // bilinear, like Ultralytics' cv2.INTER_LINEAR; 'high' would only cost time
    ctx.drawImage(frame, lb.padX, lb.padY, lb.newW, lb.newH);
    rgbaToChw(ctx.getImageData(0, 0, size, size).data, size, this.data);
    return lb;
  }
}

// ---------------------------------------------------------------------------------------------------
// OnnxDetector: onnxruntime-web, WebGPU first, WASM fallback
// ---------------------------------------------------------------------------------------------------

/** The slice of onnxruntime-web this file uses, so tests can substitute a fake. */
export interface OrtTensorLike {
  readonly dims: readonly number[];
  readonly data: unknown;
  readonly location?: string;
  getData?(): Promise<unknown>;
  dispose?(): void;
}

export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release?(): Promise<void> | void;
}

export interface OrtLike {
  InferenceSession: {
    create(model: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel?: string }): Promise<OrtSessionLike>;
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown;
  env: { wasm: { numThreads?: number; simd?: boolean }; logLevel?: string };
}

export interface OnnxDetectorOptions {
  modelUrl: string;
  inputSize: number;
  /** Lowest score kept after decoding; the Confirmer applies the real per-class thresholds. */
  confThreshold?: number;
  iouThreshold?: number;
  maxDetections?: number;
  /** Candidates allowed into NMS (highest scores kept). 300 is plenty at the real thresholds; tests raise it. */
  maxCandidates?: number;
  /** Try the WebGPU execution provider first (default: when the browser has navigator.gpu). */
  tryWebGpu?: boolean;
  /** Test seams. */
  loadOrt?: () => Promise<OrtLike>;
  fetchImpl?: typeof fetch;
  preprocessor?: { prepare(frame: FrameSource): Letterbox; readonly data: Float32Array };
}

export class ModelLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelLoadError';
  }
}

export interface OnnxTimings {
  preMs: number;
  runMs: number;
  postMs: number;
}

export class OnnxDetector implements Detector {
  private ort: OrtLike | null = null;
  private session: OrtSessionLike | null = null;
  private pre: NonNullable<OnnxDetectorOptions['preprocessor']> | null = null;
  private inputName = 'images';
  private outputName = 'output0';
  private backend = 'none';
  private loadMs: number | null = null;
  private error: string | null = null;
  private modelBytes = 0;
  private lastTimings: OnnxTimings = { preMs: 0, runMs: 0, postMs: 0 };
  private readonly numClasses = HAZARD_CLASSES.length;
  private readonly post: PostprocessOptions;

  constructor(private readonly opts: OnnxDetectorOptions) {
    this.post = {
      numClasses: this.numClasses,
      confThreshold: opts.confThreshold ?? 0.25,
      iouThreshold: opts.iouThreshold ?? 0.45,
      maxDetections: opts.maxDetections ?? 50,
      maxCandidates: opts.maxCandidates ?? 300,
    };
  }

  /** Download the model, start a session on the best backend and prove it works. Throws with a message fit for the UI. */
  async init(): Promise<void> {
    const started = performance.now();
    try {
      const bytes = await this.fetchModel();
      const ort = await (this.opts.loadOrt ?? loadOrtWebGpu)();
      this.ort = ort;
      if (!(typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)) ort.env.wasm.numThreads = 1; // threads need SharedArrayBuffer
      ort.env.logLevel = 'error';

      const useGpu = this.opts.tryWebGpu ?? (typeof navigator !== 'undefined' && 'gpu' in navigator);
      const failures: string[] = [];
      for (const ep of useGpu ? ['webgpu', 'wasm'] : ['wasm']) {
        try {
          await this.start(ort, bytes, ep);
          this.backend = ep;
          break;
        } catch (err) {
          if (err instanceof ModelShapeError) throw err; // a wrong model is wrong on every backend
          failures.push(`${ep}: ${err instanceof Error ? err.message : String(err)}`);
          await this.session?.release?.();
          this.session = null;
        }
      }
      if (!this.session) throw new ModelLoadError(`The model could not be started (${failures.join('; ')}).`);
      this.pre ??= this.opts.preprocessor ?? new Preprocessor(this.opts.inputSize);
      this.loadMs = performance.now() - started;
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  info(): DetectorInfo {
    return {
      kind: 'onnx',
      backend: this.backend,
      ready: this.session !== null,
      model: this.session ? `${this.opts.modelUrl} (${(this.modelBytes / 1e6).toFixed(1)} MB)` : this.opts.modelUrl,
      loadMs: this.loadMs,
      error: this.error,
      timings: this.lastTimings,
    };
  }

  async detect(frame: FrameSource, _nowMs: number): Promise<DetectResult> {
    const { ort, session, pre } = this;
    if (!ort || !session || !pre) throw new Error('OnnxDetector.detect() called before init() finished');
    const t0 = performance.now();
    const lb = pre.prepare(frame);
    const t1 = performance.now();
    const input = new ort.Tensor('float32', pre.data, [1, 3, this.opts.inputSize, this.opts.inputSize]);
    const outputs = await session.run({ [this.inputName]: input });
    const t2 = performance.now();
    const tensor = outputs[this.outputName];
    if (!tensor) throw new Error(`Model returned no "${this.outputName}" output`);
    const data = (tensor.location === undefined || tensor.location === 'cpu' ? tensor.data : await tensor.getData?.()) as Float32Array;
    const detections = postprocess(data, tensor.dims, lb, this.post);
    tensor.dispose?.();
    const t3 = performance.now();
    this.lastTimings = { preMs: t1 - t0, runMs: t2 - t1, postMs: t3 - t2 };
    return { detections, inferenceMs: t3 - t0 };
  }

  dispose(): void {
    void this.session?.release?.();
    this.session = null;
  }

  // -----------------------------------------------------------------------------------------------

  private async fetchModel(): Promise<Uint8Array> {
    const url = this.opts.modelUrl;
    const response = await (this.opts.fetchImpl ?? fetch)(url).catch((err: unknown) => {
      throw new ModelLoadError(`Could not download the model from ${url}: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!response.ok) {
      throw new ModelLoadError(`The model file was not found at ${url} (HTTP ${response.status}). Put lubak.onnx in app/public/models/ (see the README there) and rebuild.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    // Vite's dev server answers unknown URLs with index.html and a 200, which would otherwise surface as a cryptic protobuf error.
    if (bytes.length < 256 || contentType.includes('text/html') || bytes[0] === 0x3c) {
      throw new ModelLoadError(`${url} did not return an ONNX model (got ${bytes.length} bytes of ${contentType || 'unknown type'}). The file is probably missing: see app/public/models/README.md.`);
    }
    this.modelBytes = bytes.length;
    return bytes;
  }

  /** Create a session on one backend, run it once (compiles WebGPU shaders) and check the output looks right. */
  private async start(ort: OrtLike, bytes: Uint8Array, executionProvider: string): Promise<void> {
    const session = await ort.InferenceSession.create(bytes, { executionProviders: [executionProvider], graphOptimizationLevel: 'all' });
    this.session = session;
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (!inputName || !outputName) throw new ModelLoadError('The model has no inputs or outputs.');
    this.inputName = inputName;
    this.outputName = outputName;

    const size = this.opts.inputSize;
    const warm = new ort.Tensor('float32', new Float32Array(3 * size * size).fill(LETTERBOX_GREY / 255), [1, 3, size, size]);
    const out = await session.run({ [inputName]: warm });
    const tensor = out[outputName];
    if (!tensor) throw new ModelLoadError(`The model returned no "${outputName}" output.`);
    checkOutputShape(tensor.dims, this.numClasses);
    tensor.dispose?.();
  }
}

/** The WebGPU build of onnxruntime-web also contains the CPU provider, so one entry point and one .wasm file give the fallback too. */
async function loadOrtWebGpu(): Promise<OrtLike> {
  return (await import('onnxruntime-web/webgpu')) as unknown as OrtLike;
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
 * Pick the detector named by the flag.
 *  - 'mock': random boxes, always works.
 *  - 'onnx': the real model, or an error you can read. Never falls back.
 *  - 'auto': the real model; if it cannot be loaded, the mock WITH A REASON, which the Drive screen shows as a red MOCK
 *    badge. A silent fallback would let a demo pass off random boxes as real inference.
 */
export async function createDetector(config: Pick<AppConfig, 'detector' | 'modelUrl' | 'inputSize'>): Promise<DetectorSelection> {
  const mock = async (requested: DetectorChoice, reason: string | null): Promise<DetectorSelection> => {
    const detector = new MockDetector();
    await detector.init();
    return { detector, requested, fellBackBecause: reason };
  };
  if (config.detector === 'mock') return mock('mock', null);

  const real = new OnnxDetector({ modelUrl: config.modelUrl, inputSize: config.inputSize });
  try {
    await real.init();
    return { detector: real, requested: config.detector, fellBackBecause: null };
  } catch (err) {
    if (config.detector === 'onnx') throw err;
    real.dispose();
    return mock('auto', err instanceof Error ? err.message : String(err));
  }
}
