/**
 * Optional gate: the app's decode / class-aware NMS / un-letterbox versus Ultralytics' own code on YOUR exported model.
 * Active only when model/work/parity/reference.json exists (create it with `python model/tools/parity_ref.py --onnx ...`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeLetterbox, postprocess } from '../src/detector.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../model/work/parity');
const referenceFile = path.join(dir, 'reference.json');
const available = fs.existsSync(referenceFile);

interface Reference {
  conf: number;
  iou: number;
  max_det: number;
  imgsz: number;
  cases: { name: string; w: number; h: number; dims: number[]; ref: number[][] }[];
}

describe.skipIf(!available)('decode parity with Ultralytics (model/work/parity)', () => {
  const reference: Reference = available ? JSON.parse(fs.readFileSync(referenceFile, 'utf8')) : { conf: 0, iou: 0, max_det: 0, imgsz: 320, cases: [] };

  it.each(reference.cases.map((c) => [c.name, c] as const))('%s: identical detections, classes, scores and boxes', (_name, c) => {
    const buf = fs.readFileSync(path.join(dir, `${c.name}.raw.f32`));
    const raw = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const lb = computeLetterbox(c.w, c.h, reference.imgsz);
    const mine = postprocess(raw, c.dims, lb, { numClasses: c.dims[1]! - 4, confThreshold: reference.conf, iouThreshold: reference.iou, maxDetections: reference.max_det, maxCandidates: 1_000_000 });

    // Ultralytics also returns boxes that clip to nothing (entirely in the grey padding); the app drops those by design.
    const ref = c.ref.filter((g) => g[2]! > g[0]! && g[3]! > g[1]!);
    expect(mine.length).toBe(ref.length);

    const used = new Set<number>();
    let worst = 0;
    for (const m of mine) {
      let k = -1;
      let best = Infinity;
      ref.forEach((g, i) => {
        if (used.has(i) || g[5] !== m.classId || Math.abs(g[4]! - m.confidence) >= 1e-5) return;
        const dist = Math.abs(m.box.x1 * c.w - g[0]!) + Math.abs(m.box.y1 * c.h - g[1]!) + Math.abs(m.box.x2 * c.w - g[2]!) + Math.abs(m.box.y2 * c.h - g[3]!);
        if (dist < best) {
          best = dist;
          k = i;
        }
      });
      expect(k, `no reference detection for class ${m.classId} score ${m.confidence}`).toBeGreaterThanOrEqual(0);
      used.add(k);
      worst = Math.max(worst, best / 4);
    }
    expect(worst).toBeLessThan(0.05); // pixels in the original image
  });
});
