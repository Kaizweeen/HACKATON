/**
 * camera.ts: rear camera -> hidden <video> -> offscreen canvas, sampled at a configurable 5..10 fps.
 *
 * Interface other modules rely on:
 *   const cam = new Camera({ fps: 8 });
 *   await cam.start();                       // asks for permission, may throw CameraError
 *   const off = cam.onFrame((frame) => ...); // frame.canvas holds the sampled picture
 *   cam.video                                // the (hidden) <video>, used by the Drive screen to draw a smooth preview
 *   cam.stop();
 *
 * The detector only ever sees `frame.canvas`; nothing here leaves the device.
 * `FrameProvider` is the small interface the pipeline depends on, so Demo Mode can substitute a synthetic camera.
 */

import { SAMPLE_FPS_MAX, SAMPLE_FPS_MIN, clampFps } from './config.js';

export type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

export interface Frame {
  canvas: CanvasLike;
  width: number;
  height: number;
  /** Monotonic ms (performance.now()) when the frame was grabbed. Shared clock with sensor events. */
  t: number;
  seq: number;
}

export type CameraState = 'idle' | 'starting' | 'running' | 'error';

export interface FrameProvider {
  readonly state: CameraState;
  readonly error: string | null;
  /** Source for the live preview, when there is one. */
  readonly previewSource: CanvasImageSource | null;
  readonly frameSize: { width: number; height: number } | null;
  start(): Promise<void>;
  stop(): void;
  setFps(fps: number): void;
  onFrame(listener: (frame: Frame) => void): () => void;
  /** Frames actually delivered per second (measured). */
  readonly measuredFps: number;
}

/** A failure with a message that is safe to show to a driver / teammate. */
export class CameraError extends Error {
  constructor(
    message: string,
    readonly code: 'insecure-context' | 'unsupported' | 'denied' | 'not-found' | 'in-use' | 'failed',
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export function describeCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('Camera permission was denied. Allow the camera for this site in the browser settings, then tap Start again.', 'denied');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('No usable camera was found on this device.', 'not-found');
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError('The camera is busy or was taken by another app. Close other apps that use it, then try again.', 'in-use');
    default:
      return new CameraError(`The camera could not be started${err instanceof Error ? `: ${err.message}` : ''}.`, 'failed');
  }
}

export interface CameraOptions {
  fps?: number;
  /** Longest side of the sampled canvas. The detector letterboxes down to 320 anyway, so 640 is plenty. */
  sampleMaxSide?: number;
}

export class Camera implements FrameProvider {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private canvas: CanvasLike | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private listeners = new Set<(frame: Frame) => void>();
  private fps: number;
  private readonly sampleMaxSide: number;
  private seq = 0;
  private lastVideoTime = -1;
  private deliveredTimes: number[] = [];
  private _state: CameraState = 'idle';
  private _error: string | null = null;
  private _size: { width: number; height: number } | null = null;
  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible' || this._state === 'idle') return;
    void this.requestWakeLock();
    // Mobile browsers end the stream when the page is backgrounded; try once to get it back.
    if (this.stream && this.stream.getVideoTracks().every((t) => t.readyState === 'ended')) void this.restart();
  };

  constructor(options: CameraOptions = {}) {
    this.fps = clampFps(options.fps ?? 8);
    this.sampleMaxSide = options.sampleMaxSide ?? 640;

    // Hidden but attached: iOS Safari will not decode frames for a video that is detached or display:none.
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('aria-hidden', 'true');
    this.video.muted = true;
    this.video.autoplay = true;
    Object.assign(this.video.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '2px',
      height: '2px',
      opacity: '0',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.video);
  }

  get state(): CameraState {
    return this._state;
  }
  get error(): string | null {
    return this._error;
  }
  get previewSource(): CanvasImageSource | null {
    return this._state === 'running' ? this.video : null;
  }
  get frameSize(): { width: number; height: number } | null {
    return this._size;
  }
  get measuredFps(): number {
    const now = performance.now();
    this.deliveredTimes = this.deliveredTimes.filter((t) => now - t <= 2000);
    return this.deliveredTimes.length / 2;
  }
  get targetFps(): number {
    return this.fps;
  }

  setFps(fps: number): void {
    this.fps = clampFps(fps);
    if (this.timer !== null) this.schedule();
  }

  onFrame(listener: (frame: Frame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this._state === 'running' || this._state === 'starting') return;
    this._state = 'starting';
    this._error = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new CameraError(
          window.isSecureContext
            ? 'This browser has no camera API.'
            : 'The camera only works on https:// pages. Open the hub address that starts with https:// (after trusting its certificate).',
          window.isSecureContext ? 'unsupported' : 'insecure-context',
        );
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' }, // rear camera on phones, any camera on a laptop
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      for (const track of this.stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (this._state === 'running') this.fail(new CameraError('The camera stream stopped (another app took it, or it was unplugged).', 'in-use'));
        });
      }
      await this.waitForDimensions();
      this.allocateCanvas(this.video.videoWidth, this.video.videoHeight);
      this._state = 'running';
      this.schedule();
      document.addEventListener('visibilitychange', this.onVisibility);
      void this.requestWakeLock();
    } catch (err) {
      this.releaseStream();
      const e = describeCameraError(err);
      this.fail(e);
      throw e;
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.releaseStream();
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
    this._state = 'idle';
    this._size = null;
    this.deliveredTimes = [];
  }

  /** Stop and remove the hidden <video> element from the page. */
  dispose(): void {
    this.stop();
    this.video.remove();
  }

  /** Label of the active camera, for the Debug screen. */
  get label(): string {
    return this.stream?.getVideoTracks()[0]?.label ?? '';
  }

  private async restart(): Promise<void> {
    this.stop();
    try {
      await this.start();
    } catch {
      /* state is already 'error' with a message */
    }
  }

  private fail(error: CameraError): void {
    this._state = 'error';
    this._error = error.message;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  private async waitForDimensions(): Promise<void> {
    const deadline = performance.now() + 5000;
    while (this.video.videoWidth === 0 && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.video.videoWidth === 0) throw new CameraError('The camera opened but delivered no picture.', 'failed');
  }

  private allocateCanvas(videoW: number, videoH: number): void {
    const scale = Math.min(1, this.sampleMaxSide / Math.max(videoW, videoH));
    const width = Math.max(2, Math.round(videoW * scale));
    const height = Math.max(2, Math.round(videoH * scale));
    this._size = { width, height };
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(width, height);
      this.canvas = c;
      this.ctx = c.getContext('2d', { alpha: false, willReadFrequently: false });
    } else {
      const c = document.createElement('canvas'); // never attached to the DOM
      c.width = width;
      c.height = height;
      this.canvas = c;
      this.ctx = c.getContext('2d', { alpha: false });
    }
  }

  private schedule(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => this.sample(), 1000 / this.fps);
  }

  private sample(): void {
    const { canvas, ctx, video } = this;
    if (!canvas || !ctx || video.readyState < 2 || this._state !== 'running') return;
    if (video.currentTime === this.lastVideoTime) return; // no new picture since the last tick
    this.lastVideoTime = video.currentTime;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const t = performance.now();
    this.deliveredTimes.push(t);
    const frame: Frame = { canvas, width: canvas.width, height: canvas.height, t, seq: this.seq++ };
    for (const listener of this.listeners) listener(frame);
  }

  private async requestWakeLock(): Promise<void> {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        this.wakeLock = await navigator.wakeLock.request('screen'); // a sleeping screen would stop the camera
      }
    } catch {
      /* not supported or denied: harmless */
    }
  }
}

export { SAMPLE_FPS_MAX, SAMPLE_FPS_MIN };
