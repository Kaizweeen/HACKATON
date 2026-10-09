import { describe, expect, it } from 'vitest';
import { HAZARD_CLASSES } from '@lubak/shared';
import {
  checkOutputShape,
  computeLetterbox,
  createDetector,
  iou,
  ModelLoadError,
  ModelShapeError,
  nms,
  OnnxDetector,
  parseYoloOutput,
  postprocess,
  rgbaToChw,
  type Detection,
  type FrameSource,
  type OrtLike,
  type OrtSessionLike,
  type OrtTensorLike,
} from '../src/detector.js';

const NC = HAZARD_CLASSES.length; // 3
const PARSE = { numClasses: NC, confThreshold: 0.25 } as const;

interface Anchor {
  i: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  scores: number[];
}

/** A channel-major [1, 4 + nc, n] tensor, like the YOLOv8 ONNX export. */
function makeOutput(n: number, anchors: Anchor[], nc = NC): { data: Float32Array; dims: number[] } {
  const data = new Float32Array((4 + nc) * n);
  for (const a of anchors) {
    data[a.i] = a.cx;
    data[n + a.i] = a.cy;
    data[2 * n + a.i] = a.w;
    data[3 * n + a.i] = a.h;
    a.scores.forEach((s, c) => (data[(4 + c) * n + a.i] = s));
  }
  return { data, dims: [1, 4 + nc, n] };
}

const D = (classId: number, confidence: number, x1: number, y1: number, x2: number, y2: number): Detection => ({
  cls: HAZARD_CLASSES[classId]!,
  classId,
  confidence,
  box: { x1, y1, x2, y2 },
});

describe('computeLetterbox', () => {
  it('fits landscape video: full width, grey bars top and bottom', () => {
    expect(computeLetterbox(640, 360, 320)).toMatchObject({ scale: 0.5, newW: 320, newH: 180, padX: 0, padY: 70, size: 320 });
    expect(computeLetterbox(1920, 1080, 320)).toMatchObject({ newW: 320, newH: 180, padX: 0, padY: 70 });
  });

  it('fits portrait video: full height, bars left and right', () => {
    expect(computeLetterbox(360, 640, 320)).toMatchObject({ scale: 0.5, newW: 180, newH: 320, padX: 70, padY: 0 });
  });

  it('maps back with the scale actually applied per axis, which differs from the uniform one only through rounding (odd sizes)', () => {
    const odd = computeLetterbox(641, 361, 320);
    expect(odd).toMatchObject({ newW: 320, newH: 180, padX: 0, padY: 70 });
    expect(odd.scaleX).toBeCloseTo(320 / 641, 12);
    expect(odd.scaleY).toBeCloseTo(180 / 361, 12);
    expect(odd.scaleY).toBeLessThan(odd.scale); // 180 / 361 < 320 / 641
    const even = computeLetterbox(640, 360, 320);
    expect([even.scaleX, even.scaleY]).toEqual([0.5, 0.5]);
  });

  it('square and tiny frames', () => {
    expect(computeLetterbox(320, 320, 320)).toMatchObject({ scale: 1, newW: 320, newH: 320, padX: 0, padY: 0 });
    expect(computeLetterbox(160, 160, 320)).toMatchObject({ scale: 2, newW: 320, newH: 320 }); // upscaled
  });

  it('keeps the picture inside the square for awkward sizes and never produces a zero-size image', () => {
    for (const [w, h] of [[641, 361], [1279, 719], [333, 1000], [2, 1000], [1000, 2]] as const) {
      const lb = computeLetterbox(w, h, 320);
      expect(lb.newW).toBeGreaterThanOrEqual(1);
      expect(lb.newH).toBeGreaterThanOrEqual(1);
      expect(lb.padX + lb.newW).toBeLessThanOrEqual(320);
      expect(lb.padY + lb.newH).toBeLessThanOrEqual(320);
      expect(Math.max(lb.newW, lb.newH)).toBeGreaterThan(0.99 * 320 - 1);
    }
  });

  it('rejects empty frames', () => {
    expect(() => computeLetterbox(0, 100)).toThrow(RangeError);
    expect(() => computeLetterbox(100, Number.NaN)).toThrow(RangeError);
  });
});

describe('parseYoloOutput: coordinates', () => {
  it('maps a model-space box back to normalised source coordinates (landscape frame with padding)', () => {
    // 640x360 frame -> scale 0.5, padY 70. A 40x40 box centred at (160, 160) in model pixels:
    //   x: (140..180)/0.5 = 280..360 of 640  -> 0.4375..0.5625
    //   y: (140-70 .. 180-70)/0.5 = 140..220 of 360 -> 0.3889..0.6111
    const lb = computeLetterbox(640, 360, 320);
    const { data, dims } = makeOutput(10, [{ i: 3, cx: 160, cy: 160, w: 40, h: 40, scores: [0.9, 0.1, 0.2] }]);
    const [d] = parseYoloOutput(data, dims, lb, PARSE);
    expect(d!.box.x1).toBeCloseTo(0.4375, 5);
    expect(d!.box.x2).toBeCloseTo(0.5625, 5);
    expect(d!.box.y1).toBeCloseTo(140 / 360, 5);
    expect(d!.box.y2).toBeCloseTo(220 / 360, 5);
  });

  it('portrait frames pad left and right instead', () => {
    // 360x640 -> scale 0.5, padX 70. Same model box -> x: (140-70..180-70)/0.5 = 140..220 of 360, y: 280..360 of 640
    const lb = computeLetterbox(360, 640, 320);
    const { data, dims } = makeOutput(5, [{ i: 0, cx: 160, cy: 160, w: 40, h: 40, scores: [0.9, 0, 0] }]);
    const [d] = parseYoloOutput(data, dims, lb, PARSE);
    expect(d!.box.x1).toBeCloseTo(140 / 360, 5);
    expect(d!.box.x2).toBeCloseTo(220 / 360, 5);
    expect(d!.box.y1).toBeCloseTo(280 / 640, 5);
    expect(d!.box.y2).toBeCloseTo(360 / 640, 5);
  });

  it('is the exact inverse of the letterbox: a box drawn at known source coordinates round-trips', () => {
    for (const [w, h] of [[640, 360], [360, 640], [1280, 720], [320, 320]] as const) {
      const lb = computeLetterbox(w, h, 320);
      const want = { x1: 0.2, y1: 0.3, x2: 0.45, y2: 0.7 };
      // forward: source-normalised -> model pixels
      const fx = (v: number): number => v * w * lb.scaleX + lb.padX;
      const fy = (v: number): number => v * h * lb.scaleY + lb.padY;
      const { data, dims } = makeOutput(4, [
        { i: 1, cx: (fx(want.x1) + fx(want.x2)) / 2, cy: (fy(want.y1) + fy(want.y2)) / 2, w: fx(want.x2) - fx(want.x1), h: fy(want.y2) - fy(want.y1), scores: [0, 0.8, 0] },
      ]);
      const [d] = parseYoloOutput(data, dims, lb, PARSE);
      expect(d!.box.x1, `${w}x${h}`).toBeCloseTo(want.x1, 5);
      expect(d!.box.y1, `${w}x${h}`).toBeCloseTo(want.y1, 5);
      expect(d!.box.x2, `${w}x${h}`).toBeCloseTo(want.x2, 5);
      expect(d!.box.y2, `${w}x${h}`).toBeCloseTo(want.y2, 5);
    }
  });

  it('clamps boxes that spill outside the frame and drops ones entirely in the padding', () => {
    const lb = computeLetterbox(640, 360, 320); // padY = 70
    const { data, dims } = makeOutput(6, [
      { i: 0, cx: 10, cy: 160, w: 80, h: 40, scores: [0.9, 0, 0] }, // spills past the left edge
      { i: 1, cx: 160, cy: 20, w: 40, h: 20, scores: [0.9, 0, 0] }, // inside the top grey bar
    ]);
    const out = parseYoloOutput(data, dims, lb, PARSE);
    expect(out).toHaveLength(1);
    expect(out[0]!.box.x1).toBe(0);
    expect(out[0]!.box.x2).toBeCloseTo((10 + 40) / 0.5 / 640, 5);
  });
});

describe('parseYoloOutput: scores', () => {
  const lb = computeLetterbox(320, 320, 320);
  const box = { cx: 100, cy: 100, w: 50, h: 50 };

  it('picks the best class of each anchor and reports its class id and name', () => {
    const { data, dims } = makeOutput(8, [
      { i: 0, ...box, scores: [0.1, 0.8, 0.3] },
      { i: 1, ...box, cx: 200, scores: [0.3, 0.2, 0.7] },
    ]);
    const out = parseYoloOutput(data, dims, lb, PARSE);
    expect(out.map((d) => [d.classId, d.cls, d.confidence.toFixed(1)])).toEqual([
      [1, 'crack', '0.8'],
      [2, 'flooded_road', '0.7'],
    ]);
  });

  it('drops weak anchors and NaN, which must never slip through a >= comparison by accident', () => {
    const { data, dims } = makeOutput(6, [
      { i: 0, ...box, scores: [0.24, 0, 0] },
      { i: 1, ...box, scores: [0.25, 0, 0] }, // exactly at the threshold is kept
      { i: 2, ...box, scores: [Number.NaN, Number.NaN, Number.NaN] },
      { i: 3, ...box, cx: Number.NaN, scores: [0.9, 0, 0] }, // a NaN box is degenerate
    ]);
    const out = parseYoloOutput(data, dims, lb, PARSE);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBeCloseTo(0.25, 6);
  });

  it('caps the candidates entering NMS, keeping the highest scores', () => {
    const anchors: Anchor[] = Array.from({ length: 20 }, (_, i) => ({ i, cx: 20 + i * 10, cy: 100, w: 8, h: 8, scores: [0.3 + i * 0.02, 0, 0] }));
    const { data, dims } = makeOutput(20, anchors);
    const out = parseYoloOutput(data, dims, lb, { ...PARSE, maxCandidates: 5 });
    expect(out).toHaveLength(5);
    expect(Math.min(...out.map((d) => d.confidence))).toBeGreaterThan(0.3 + 14 * 0.02 - 1e-6);
  });

  it('works on a full-size 320 px output: 2100 anchors', () => {
    const lb320 = computeLetterbox(640, 360, 320);
    const { data, dims } = makeOutput(2100, [{ i: 2099, cx: 160, cy: 160, w: 30, h: 30, scores: [0, 0, 0.77] }]);
    expect(dims).toEqual([1, 7, 2100]);
    const out = parseYoloOutput(data, dims, lb320, PARSE);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cls: 'flooded_road', classId: 2 });
  });
});

describe('model shape checks', () => {
  const lb = computeLetterbox(320, 320, 320);

  it('accepts [1, 4 + classes, N] and returns N', () => {
    expect(checkOutputShape([1, 7, 2100], 3)).toBe(2100);
  });

  it('refuses a model with the wrong number of classes and says which', () => {
    expect(() => checkOutputShape([1, 84, 8400], 3)).toThrow(ModelShapeError);
    expect(() => checkOutputShape([1, 84, 8400], 3)).toThrow(/80 classes.*expects 3.*pothole, crack, flooded_road/);
    expect(() => checkOutputShape([1, 6, 2100], 3)).toThrow(/2 classes/);
  });

  it('refuses outputs that are not a detection head at all', () => {
    for (const dims of [[1, 7], [2, 7, 2100], [1, 4, 100], [1, 7, 0], [7, 2100, 1, 1]]) expect(() => checkOutputShape(dims, 3), JSON.stringify(dims)).toThrow(ModelShapeError);
  });

  it('refuses data shorter than the shape claims', () => {
    expect(() => parseYoloOutput(new Float32Array(10), [1, 7, 2100], lb, PARSE)).toThrow(/expected/);
  });
});

describe('iou and nms', () => {
  const sq = (x: number, y: number, s = 0.2) => ({ x1: x, y1: y, x2: x + s, y2: y + s });

  it('iou: identical = 1, disjoint = 0, half-overlap = 1/3, contained = area ratio', () => {
    expect(iou(sq(0.1, 0.1), sq(0.1, 0.1))).toBeCloseTo(1, 10);
    expect(iou(sq(0, 0), sq(0.5, 0.5))).toBe(0);
    expect(iou(sq(0, 0, 0.2), sq(0.1, 0, 0.2))).toBeCloseTo(1 / 3, 10);
    expect(iou(sq(0, 0, 0.4), sq(0.1, 0.1, 0.2))).toBeCloseTo(0.04 / 0.16, 10);
    expect(iou({ x1: 0, y1: 0, x2: 0, y2: 0 }, { x1: 0, y1: 0, x2: 0, y2: 0 })).toBe(0);
  });

  it('keeps the highest-scoring box of an overlapping same-class group', () => {
    const out = nms([D(0, 0.6, 0.1, 0.1, 0.3, 0.3), D(0, 0.9, 0.11, 0.1, 0.31, 0.3), D(0, 0.7, 0.12, 0.12, 0.32, 0.32)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(0.9);
  });

  it('is CLASS-AWARE: a pothole box never suppresses a crack box, even on the same spot', () => {
    const out = nms([D(0, 0.9, 0.1, 0.1, 0.3, 0.3), D(1, 0.8, 0.1, 0.1, 0.3, 0.3), D(2, 0.7, 0.1, 0.1, 0.3, 0.3)]);
    expect(out.map((d) => d.classId)).toEqual([0, 1, 2]);
  });

  it('keeps separate objects of the same class and returns highest confidence first', () => {
    const out = nms([D(0, 0.5, 0.6, 0.6, 0.8, 0.8), D(0, 0.9, 0.1, 0.1, 0.3, 0.3), D(0, 0.7, 0.4, 0.1, 0.6, 0.3)]);
    expect(out.map((d) => d.confidence)).toEqual([0.9, 0.7, 0.5]);
  });

  it('a box overlapping by exactly the IoU threshold is kept (suppression needs MORE than the threshold)', () => {
    const a = D(0, 0.9, 0, 0, 0.2, 0.2);
    const b = D(0, 0.8, 0.1, 0, 0.3, 0.2); // IoU = 1/3
    expect(nms([a, b], 1 / 3 + 1e-9)).toHaveLength(2);
    expect(nms([a, b], 1 / 3 - 1e-9)).toHaveLength(1);
  });

  it('caps the number of detections and does not mutate its input', () => {
    const many = Array.from({ length: 30 }, (_, i) => D(0, 0.99 - i * 0.01, i * 0.03, 0, i * 0.03 + 0.02, 0.02));
    const copy = JSON.parse(JSON.stringify(many));
    expect(nms(many, 0.45, 10)).toHaveLength(10);
    expect(many).toEqual(copy);
    expect(nms([])).toEqual([]);
  });

  it('postprocess = parse + nms: duplicate anchors for one pothole collapse to one detection', () => {
    const lb = computeLetterbox(320, 320, 320);
    const { data, dims } = makeOutput(10, [
      { i: 0, cx: 100, cy: 100, w: 50, h: 50, scores: [0.9, 0, 0] },
      { i: 1, cx: 102, cy: 101, w: 52, h: 50, scores: [0.7, 0, 0] },
      { i: 2, cx: 250, cy: 250, w: 40, h: 40, scores: [0.6, 0, 0] },
    ]);
    const out = postprocess(data, dims, lb, { ...PARSE, iouThreshold: 0.45, maxDetections: 50 });
    expect(out.map((d) => d.confidence.toFixed(1))).toEqual(['0.9', '0.6']);
  });
});

describe('rgbaToChw', () => {
  it('converts interleaved RGBA bytes to planar RGB floats in 0..1, ignoring alpha', () => {
    // 2x2: red, green / blue, white
    const rgba = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0];
    const out = new Float32Array(12);
    rgbaToChw(rgba, 2, out);
    expect([...out.slice(0, 4)]).toEqual([1, 0, 0, 1]); // R plane
    expect([...out.slice(4, 8)]).toEqual([0, 1, 0, 1]); // G plane
    expect([...out.slice(8, 12)]).toEqual([0, 0, 1, 1]); // B plane
  });
});

// ---------------------------------------------------------------------------------------------------
// OnnxDetector control flow with a fake onnxruntime
// ---------------------------------------------------------------------------------------------------

const MODEL = new Uint8Array(4096).fill(7).map((_, i) => (i === 0 ? 0x08 : 7)); // not HTML, long enough

function okResponse(bytes: Uint8Array = MODEL, type = 'application/octet-stream'): Response {
  return new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': type } });
}

interface FakeOrtOptions {
  failCreate?: string[]; // execution providers whose session creation throws
  failRun?: string[]; // execution providers whose first run throws
  dims?: number[];
  inputName?: string;
  outputName?: string;
}

function fakeOrt(options: FakeOrtOptions = {}) {
  const log = { created: [] as string[], runs: [] as { ep: string; dims: readonly number[] }[], released: 0, tensors: [] as { dims: readonly number[] }[] };
  const dims = options.dims ?? [1, 7, 2100];
  const n = dims[2] ?? 2100;
  const outData = makeOutput(n, [{ i: 5, cx: 160, cy: 160, w: 40, h: 40, scores: [0.9, 0.1, 0.05] }]).data;

  const ort: OrtLike = {
    env: { wasm: {} },
    Tensor: class {
      constructor(readonly type: 'float32', readonly data: Float32Array, readonly dims: readonly number[]) {
        log.tensors.push({ dims });
      }
    },
    InferenceSession: {
      async create(_model, opts) {
        const ep = opts.executionProviders[0]!;
        log.created.push(ep);
        if (options.failCreate?.includes(ep)) throw new Error(`${ep} is not available`);
        let first = true;
        const session: OrtSessionLike = {
          inputNames: [options.inputName ?? 'images'],
          outputNames: [options.outputName ?? 'output0'],
          async run(feeds) {
            const input = feeds[options.inputName ?? 'images'] as { dims: readonly number[] };
            log.runs.push({ ep, dims: input.dims });
            if (first && options.failRun?.includes(ep)) {
              first = false;
              throw new Error(`${ep} shader compilation failed`);
            }
            first = false;
            const t: OrtTensorLike = { dims, data: outData, location: 'cpu', dispose() {} };
            return { [options.outputName ?? 'output0']: t };
          },
          async release() {
            log.released += 1;
          },
        };
        return session;
      },
    },
  };
  return { ort, log };
}

const fakePre = { data: new Float32Array(3 * 320 * 320), prepare: () => computeLetterbox(640, 360, 320) };
const frame = { width: 640, height: 360 } as unknown as FrameSource;

function detector(ort: OrtLike, over: Partial<ConstructorParameters<typeof OnnxDetector>[0]> = {}) {
  return new OnnxDetector({
    modelUrl: '/models/lubak.onnx',
    inputSize: 320,
    loadOrt: async () => ort,
    fetchImpl: async () => okResponse(),
    preprocessor: fakePre,
    tryWebGpu: true,
    ...over,
  });
}

describe('OnnxDetector', () => {
  it('starts on WebGPU when available, proves it works with a warm-up run, and reports the backend', async () => {
    const { ort, log } = fakeOrt();
    const d = detector(ort);
    await d.init();
    expect(log.created).toEqual(['webgpu']);
    expect(log.runs).toEqual([{ ep: 'webgpu', dims: [1, 3, 320, 320] }]); // the warm-up
    expect(d.info()).toMatchObject({ kind: 'onnx', backend: 'webgpu', ready: true, error: null });
    expect(d.info().model).toContain('/models/lubak.onnx');
    expect(ort.env.wasm.numThreads).toBe(1); // no SharedArrayBuffer without cross-origin isolation
  });

  it('falls back to WASM automatically when the WebGPU session cannot be created', async () => {
    const { ort, log } = fakeOrt({ failCreate: ['webgpu'] });
    const d = detector(ort);
    await d.init();
    expect(log.created).toEqual(['webgpu', 'wasm']);
    expect(d.info()).toMatchObject({ backend: 'wasm', ready: true });
  });

  it('also falls back when WebGPU creates a session but the first run fails (shader / unsupported op)', async () => {
    const { ort, log } = fakeOrt({ failRun: ['webgpu'] });
    const d = detector(ort);
    await d.init();
    expect(log.created).toEqual(['webgpu', 'wasm']);
    expect(log.released).toBe(1); // the half-working WebGPU session was released
    expect(d.info().backend).toBe('wasm');
  });

  it('goes straight to WASM when the browser has no WebGPU', async () => {
    const { ort, log } = fakeOrt();
    await detector(ort, { tryWebGpu: false }).init();
    expect(log.created).toEqual(['wasm']);
  });

  it('reports every backend failure when none works, and stays not ready', async () => {
    const { ort } = fakeOrt({ failCreate: ['webgpu', 'wasm'] });
    const d = detector(ort);
    await expect(d.init()).rejects.toThrow(/webgpu is not available.*wasm is not available/);
    expect(d.info()).toMatchObject({ ready: false });
    expect(d.info().error).toMatch(/could not be started/);
  });

  it('a model with the wrong classes is rejected immediately: a different backend would not fix it', async () => {
    const { ort, log } = fakeOrt({ dims: [1, 84, 8400] });
    const d = detector(ort);
    await expect(d.init()).rejects.toThrow(ModelShapeError);
    expect(log.created).toEqual(['webgpu']);
    expect(d.info().error).toMatch(/80 classes/);
  });

  it('uses the model\'s own input and output names', async () => {
    const { ort, log } = fakeOrt({ inputName: 'input_0', outputName: 'preds' });
    const d = detector(ort);
    await d.init();
    const result = await d.detect(frame, 0);
    expect(result.detections).toHaveLength(1);
    expect(log.runs.every((r) => r.dims.join() === '1,3,320,320')).toBe(true);
  });

  it('detect() returns decoded, mapped detections and measured timings', async () => {
    const { ort } = fakeOrt();
    const d = detector(ort);
    await d.init();
    const result = await d.detect(frame, 0);
    expect(result.detections).toHaveLength(1);
    const [det] = result.detections;
    expect(det).toMatchObject({ cls: 'pothole', classId: 0 });
    expect(det!.confidence).toBeCloseTo(0.9, 5);
    expect(det!.box.x1).toBeCloseTo(0.4375, 5); // same maths as the parse test: 640x360 frame
    expect(result.inferenceMs).toBeGreaterThanOrEqual(0);
    const t = d.info().timings!;
    expect(t.preMs + t.runMs + t.postMs).toBeLessThanOrEqual(result.inferenceMs + 1e-6);
  });

  it('detect() before init() fails with a clear message instead of a TypeError', async () => {
    const { ort } = fakeOrt();
    await expect(detector(ort).detect(frame, 0)).rejects.toThrow(/before init/);
  });

  describe('when the model file is missing or wrong', () => {
    const run = (fetchImpl: typeof fetch) => detector(fakeOrt().ort, { fetchImpl }).init();

    it('404: names the path and points at the README', async () => {
      await expect(run(async () => new Response('nope', { status: 404 }))).rejects.toThrow(/not found at \/models\/lubak\.onnx \(HTTP 404\).*app\/public\/models/);
    });

    it('a 200 that is really index.html (what the Vite dev server answers for unknown paths) is recognised', async () => {
      const html = new TextEncoder().encode('<!doctype html><html>'.padEnd(2000, ' '));
      await expect(run(async () => okResponse(html, 'text/html'))).rejects.toThrow(/did not return an ONNX model/);
      await expect(run(async () => okResponse(html, 'application/octet-stream'))).rejects.toThrow(/did not return an ONNX model/); // sniffed by the first byte
    });

    it('a file that is far too small to be a model', async () => {
      await expect(run(async () => okResponse(new Uint8Array(10).fill(8)))).rejects.toThrow(/did not return an ONNX model/);
    });

    it('a network failure', async () => {
      await expect(
        run(async () => {
          throw new TypeError('Failed to fetch');
        }),
      ).rejects.toThrow(/Could not download the model.*Failed to fetch/);
    });
  });
});

describe('createDetector', () => {
  const base = { modelUrl: '/models/lubak.onnx', inputSize: 320 };

  it('mock: random boxes, no model needed', async () => {
    const sel = await createDetector({ ...base, detector: 'mock' });
    expect(sel.detector.info().kind).toBe('mock');
    expect(sel.fellBackBecause).toBeNull();
  });

  it('auto without a model: falls back to the mock and says exactly why (never silently)', async () => {
    const sel = await createDetector({ ...base, detector: 'auto' });
    expect(sel.detector.info().kind).toBe('mock');
    expect(sel.requested).toBe('auto');
    expect(sel.fellBackBecause).toMatch(/Could not download the model|not found/);
  });

  it('onnx without a model: refuses to fall back, so a broken real detector is never hidden behind random boxes', async () => {
    await expect(createDetector({ ...base, detector: 'onnx' })).rejects.toBeInstanceOf(ModelLoadError);
  });
});
