import type { Frame, FrameProvider, CameraState } from '../src/camera.js';
import type { Detection, DetectResult, Detector, DetectorInfo } from '../src/detector.js';
import type { GeoFix, GeoStatus, JoltEvent, LocationSource, MotionSource, MotionStatus } from '../src/sensors.js';

export class FakeCamera implements FrameProvider {
  state: CameraState = 'running';
  error = null;
  previewSource = null;
  frameSize = { width: 640, height: 360 };
  measuredFps = 8;
  private listeners = new Set<(f: Frame) => void>();
  private seq = 0;
  async start(): Promise<void> {}
  stop(): void {}
  setFps(): void {}
  onFrame(l: (f: Frame) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  emit(t: number): void {
    const frame: Frame = { canvas: {} as unknown as HTMLCanvasElement, width: 640, height: 360, t, seq: this.seq++ };
    for (const l of this.listeners) l(frame);
  }
}

/** Returns queued detections frame by frame; can be told to wait or fail. */
export class ScriptedDetector implements Detector {
  queue: Detection[][] = [];
  gate: Promise<void> | null = null;
  failNext = false;
  calls = 0;
  async init(): Promise<void> {}
  info(): DetectorInfo {
    return { kind: 'mock', backend: 'test', ready: true, model: null, loadMs: 0, error: null };
  }
  async detect(): Promise<DetectResult> {
    this.calls += 1;
    if (this.gate) await this.gate;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('boom');
    }
    return { detections: this.queue.shift() ?? [], inferenceMs: 3 };
  }
  dispose(): void {}
}

export class FakeMotion implements MotionSource {
  private listeners = new Set<(j: JoltEvent) => void>();
  start(): boolean {
    return true;
  }
  stop(): void {}
  onJolt(l: (j: JoltEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  jolt(e: JoltEvent): void {
    for (const l of this.listeners) l(e);
  }
  status(): MotionStatus {
    throw new Error('not used');
  }
}

export class FakeGeo implements LocationSource {
  fix: GeoFix | null = null;
  start(): boolean {
    return true;
  }
  stop(): void {}
  onFix(): () => void {
    return () => undefined;
  }
  status(): GeoStatus {
    throw new Error('not used');
  }
}

/** Let every pending promise and store write finish. */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
