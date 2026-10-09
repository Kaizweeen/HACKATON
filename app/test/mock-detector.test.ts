import { describe, expect, it } from 'vitest';
import { HAZARD_CLASSES } from '@lubak/shared';
import { Confirmer } from '../src/confirmer.js';
import { classIdOf, MockDetector } from '../src/detector.js';
import type { FrameSource } from '../src/detector.js';
import { FRAME_MS } from './helpers.js';

const noFrame = {} as FrameSource; // the mock never looks at pixels

async function run(seed: number, seconds: number) {
  const d = new MockDetector({ seed });
  await d.init();
  const frames = [];
  for (let t = 0; t < seconds * 1000; t += FRAME_MS) frames.push({ t, ...(await d.detect(noFrame, t)) });
  return frames;
}

describe('MockDetector', () => {
  it('is deterministic for a seed and different for another', async () => {
    const a = (await run(7, 20)).map((f) => f.detections);
    const b = (await run(7, 20)).map((f) => f.detections);
    const c = (await run(8, 20)).map((f) => f.detections);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('always returns valid detections: known class, matching id, confidence in range, sane normalised box', async () => {
    for (const f of await run(3, 60)) {
      for (const d of f.detections) {
        expect(HAZARD_CLASSES).toContain(d.cls);
        expect(d.classId).toBe(classIdOf(d.cls));
        expect(d.confidence).toBeGreaterThan(0);
        expect(d.confidence).toBeLessThanOrEqual(1);
        expect(d.box.x1).toBeGreaterThanOrEqual(0);
        expect(d.box.y1).toBeGreaterThanOrEqual(0);
        expect(d.box.x2).toBeLessThanOrEqual(1);
        expect(d.box.y2).toBeLessThanOrEqual(1);
        expect(d.box.x2).toBeGreaterThan(d.box.x1);
        expect(d.box.y2).toBeGreaterThan(d.box.y1);
      }
      expect(f.inferenceMs).toBeGreaterThanOrEqual(0); // measured, never simulated
    }
  });

  it('produces hazards that persist across frames, so the Confirmer fires (white noise would almost never get 3 in a row)', async () => {
    const confirmer = new Confirmer();
    let confirmed = 0;
    for (const f of await run(11, 60)) confirmed += confirmer.update(f.detections, f.t).length;
    expect(confirmed).toBeGreaterThanOrEqual(3);
    expect(confirmed).toBeLessThanOrEqual(30);
  });

  it('also produces low-confidence junk that the Confirmer must ignore', async () => {
    const frames = await run(5, 60);
    const junk = frames.flatMap((f) => f.detections).filter((d) => d.confidence < 0.3);
    expect(junk.length).toBeGreaterThan(5);
    const confirmer = new Confirmer();
    const onlyJunk = frames.map((f) => ({ t: f.t, detections: f.detections.filter((d) => d.confidence < 0.3) }));
    expect(onlyJunk.flatMap((f) => confirmer.update(f.detections, f.t))).toEqual([]);
  });

  it('reports itself honestly', async () => {
    const d = new MockDetector({ seed: 1 });
    expect(d.info()).toMatchObject({ kind: 'mock', backend: 'mock', ready: false });
    await d.init();
    expect(d.info().ready).toBe(true);
  });
});
