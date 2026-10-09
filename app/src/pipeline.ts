/**
 * pipeline.ts: camera frame -> detector -> confirmer -> (GPS fix) -> store.
 *
 * It depends only on small interfaces (FrameProvider, Detector, MotionSource, LocationSource), so the same code runs
 * with the real camera and model or with Demo Mode's scripted replacements.
 *
 * Frames are processed latest-wins: while the detector is busy, new frames are dropped (and counted), so a slow phone
 * degrades to a lower frame rate instead of building a backlog and answering about the road from two seconds ago.
 */

import { createHazard, offsetMeters, type Hazard } from '@lubak/shared';
import type { Frame, FrameProvider } from './camera.js';
import type { Confirmation, Confirmer } from './confirmer.js';
import type { Detection, Detector } from './detector.js';
import type { LocationSource, MotionSource } from './sensors.js';
import type { HazardStore } from './store.js';

export interface PipelineConfig {
  /** Do not record hazards while the GPS accuracy radius is worse than this (metres). */
  maxFixAccuracyM: number;
  /** ... or while the last fix is older than this relative to the frame (ms). */
  maxFixAgeMs: number;
  /**
   * The camera sees the road AHEAD of the phone. Shift the recorded position this far along the direction of travel.
   * 0 = record the phone's own position. TUNING KNOB for the camera owner; needs measuring on a real mount.
   */
  lookaheadM: number;
  /** Lookahead is only applied above this speed (m/s), when the heading is trustworthy. */
  minSpeedForLookaheadMps: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  maxFixAccuracyM: 50,
  maxFixAgeMs: 5000,
  lookaheadM: 0,
  minSpeedForLookaheadMps: 1.5,
};

export interface FrameResult {
  t: number;
  detections: Detection[];
  frameWidth: number;
  frameHeight: number;
  inferenceMs: number;
}

export type PipelineEvent =
  | { type: 'confirmed'; confirmation: Confirmation; hazard: Hazard; isNew: boolean }
  | { type: 'boosted'; confirmation: Confirmation; hazard: Hazard }
  | { type: 'no-fix'; confirmation: Confirmation; reason: string };

export interface PipelineStats {
  running: boolean;
  framesIn: number;
  framesProcessed: number;
  framesDropped: number;
  processedFps: number;
  inferenceMsLast: number;
  inferenceMsAvg: number;
  inferenceMsP95: number;
  detections: number;
  confirmed: number;
  boosted: number;
  noFix: number;
  errors: number;
  lastError: string | null;
}

export interface PipelineDeps {
  camera: FrameProvider;
  detector: Detector;
  confirmer: Confirmer;
  motion: MotionSource;
  geo: LocationSource;
  store: HazardStore;
  deviceId: string;
  config?: Partial<PipelineConfig>;
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

export class Pipeline {
  private readonly deps: PipelineDeps;
  private readonly config: PipelineConfig;
  private running = false;
  private busy = false;
  private unsubscribers: (() => void)[] = [];
  private resultListeners = new Set<(r: FrameResult) => void>();
  private eventListeners = new Set<(e: PipelineEvent) => void>();
  /** Hazards created at confirmation, so a later jolt boost updates the same record at the same position. */
  private recent = new Map<number, Hazard>();
  private inferenceTimes: number[] = [];
  private processedAt: number[] = [];
  private s = { framesIn: 0, framesProcessed: 0, framesDropped: 0, inferenceMsLast: 0, detections: 0, confirmed: 0, boosted: 0, noFix: 0, errors: 0, lastError: null as string | null };

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...deps.config };
  }

  get stats(): PipelineStats {
    const sorted = [...this.inferenceTimes].sort((a, b) => a - b);
    const now = performance.now();
    this.processedAt = this.processedAt.filter((t) => now - t <= 2000);
    return {
      running: this.running,
      framesIn: this.s.framesIn,
      framesProcessed: this.s.framesProcessed,
      framesDropped: this.s.framesDropped,
      processedFps: this.processedAt.length / 2,
      inferenceMsLast: this.s.inferenceMsLast,
      inferenceMsAvg: sorted.length === 0 ? 0 : sorted.reduce((a, b) => a + b, 0) / sorted.length,
      inferenceMsP95: percentile(sorted, 0.95),
      detections: this.s.detections,
      confirmed: this.s.confirmed,
      boosted: this.s.boosted,
      noFix: this.s.noFix,
      errors: this.s.errors,
      lastError: this.s.lastError,
    };
  }

  onResult(listener: (r: FrameResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  onEvent(listener: (e: PipelineEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.confirmer.reset();
    this.unsubscribers.push(
      this.deps.camera.onFrame((frame) => void this.handleFrame(frame)),
      this.deps.motion.onJolt((jolt) => {
        for (const c of this.deps.confirmer.onJolt({ t: jolt.t, magnitude: jolt.magnitude })) void this.record(c);
      }),
    );
  }

  stop(): void {
    this.running = false;
    for (const u of this.unsubscribers.splice(0)) u();
  }

  // -----------------------------------------------------------------------------------------------

  private async handleFrame(frame: Frame): Promise<void> {
    this.s.framesIn += 1;
    if (!this.running || this.busy) {
      this.s.framesDropped += 1;
      return;
    }
    this.busy = true;
    try {
      const result = await this.deps.detector.detect(frame.canvas, frame.t);
      if (!this.running) return;

      this.s.framesProcessed += 1;
      this.s.inferenceMsLast = result.inferenceMs;
      this.s.detections += result.detections.length;
      this.inferenceTimes.push(result.inferenceMs);
      if (this.inferenceTimes.length > 60) this.inferenceTimes.shift();
      this.processedAt.push(performance.now());

      const frameResult: FrameResult = {
        t: frame.t,
        detections: result.detections,
        frameWidth: frame.width,
        frameHeight: frame.height,
        inferenceMs: result.inferenceMs,
      };
      for (const l of this.resultListeners) l(frameResult);

      for (const confirmation of this.deps.confirmer.update(result.detections, frame.t)) await this.record(confirmation);
    } catch (err) {
      this.s.errors += 1;
      this.s.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  /** Turn a confirmation (or a later boost of one) into a stored hazard. */
  private async record(c: Confirmation): Promise<void> {
    const { deviceId, store, geo } = this.deps;
    try {
      if (c.kind === 'boost') {
        const base = this.recent.get(c.seq);
        if (!base) return;
        const boosted = createHazard({ cls: base.cls, lat: base.lat, lon: base.lon, confidence: c.confidence, deviceId, now: Date.now() });
        await store.putLocal(boosted);
        this.s.boosted += 1;
        this.emit({ type: 'boosted', confirmation: c, hazard: boosted });
        return;
      }

      const fix = geo.fix;
      if (!fix) return this.noFix(c, 'no GPS fix yet');
      if (fix.accuracy > this.config.maxFixAccuracyM) return this.noFix(c, `GPS accuracy ${Math.round(fix.accuracy)} m is worse than ${this.config.maxFixAccuracyM} m`);
      if (Math.abs(c.t - fix.t) > this.config.maxFixAgeMs) return this.noFix(c, 'GPS fix is stale');

      let { lat, lon } = fix;
      if (this.config.lookaheadM > 0 && fix.heading !== null && (fix.speed ?? 0) >= this.config.minSpeedForLookaheadMps) {
        const rad = (fix.heading * Math.PI) / 180;
        ({ lat, lon } = offsetMeters(fix, this.config.lookaheadM * Math.cos(rad), this.config.lookaheadM * Math.sin(rad)));
      }

      const hazard = createHazard({ cls: c.cls, lat, lon, confidence: c.confidence, deviceId, now: Date.now() });
      const result = await store.putLocal(hazard);
      this.recent.set(c.seq, hazard);
      if (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value as number);
      this.s.confirmed += 1;
      this.emit({ type: 'confirmed', confirmation: c, hazard, isNew: result.changed });
    } catch (err) {
      this.s.errors += 1;
      this.s.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private noFix(confirmation: Confirmation, reason: string): void {
    this.s.noFix += 1;
    this.emit({ type: 'no-fix', confirmation, reason });
  }

  private emit(event: PipelineEvent): void {
    for (const l of this.eventListeners) l(event);
  }
}
