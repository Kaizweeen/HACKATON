import type { HazardClass } from '@lubak/shared';
import { classIdOf, type Detection } from '../src/detector.js';

/** A detection with a plausible box. */
export const det = (cls: HazardClass, confidence: number): Detection => ({
  cls,
  classId: classIdOf(cls),
  confidence,
  box: { x1: 0.4, y1: 0.5, x2: 0.6, y2: 0.7 },
});

/** 8 fps. */
export const FRAME_MS = 125;
