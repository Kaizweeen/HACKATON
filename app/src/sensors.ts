/**
 * sensors.ts: accelerometer jolts (DeviceMotion) and GPS (Geolocation).
 *
 *   MotionSensor  DeviceMotion with the iOS permission flow, feeding a rolling JoltDetector.
 *   GeoTracker    watchPosition with high accuracy.
 *   JoltDetector  pure signal processing (no DOM), unit-tested.
 *
 * Both browser classes implement small interfaces (MotionSource / LocationSource) so Demo Mode can swap in scripted ones.
 *
 * iOS: DeviceMotionEvent.requestPermission() must be called from a user gesture (a tap handler). Call
 * MotionSensor.requestPermission() first thing in the Start button's click handler.
 */

// ---------------------------------------------------------------------------------------------------
// Jolt detection
// ---------------------------------------------------------------------------------------------------

export interface MotionSample {
  /** Monotonic ms (performance.now()). */
  t: number;
  /** accelerationIncludingGravity, m/s^2, in the device frame. */
  ax: number;
  ay: number;
  az: number;
}

export interface JoltEvent {
  t: number;
  /** Peak vertical (along gravity) dynamic acceleration, m/s^2. */
  magnitude: number;
}

export interface JoltDetectorConfig {
  /** |vertical dynamic acceleration| at or above this counts as a jolt. PLACEHOLDER: tune on real rides. */
  thresholdMs2: number;
  /** Ignore further jolts for this long after one (a single impact rings for a few hundred ms). */
  refractoryMs: number;
  /** Time constant of the low-pass filter that tracks gravity. */
  gravityTimeConstantMs: number;
  /** Ignore the signal for this long after the first sample while the gravity estimate settles. */
  warmupMs: number;
  /** Window for the rolling peak shown in the Debug screen. */
  windowMs: number;
}

export const DEFAULT_JOLT_CONFIG: JoltDetectorConfig = {
  thresholdMs2: 4,
  refractoryMs: 400,
  gravityTimeConstantMs: 800,
  warmupMs: 500,
  windowMs: 1000,
};

/**
 * Orientation-agnostic vertical-jolt detector. A phone on a handlebar or dashboard can sit at any angle, so instead
 * of trusting an axis it (1) tracks gravity with a slow low-pass filter, (2) subtracts it to get the dynamic acceleration,
 * and (3) projects that onto the gravity direction. A pothole hit shows up as a spike in that vertical component.
 * Rolling peak = max |vertical| over the last `windowMs`.
 */
export class JoltDetector {
  readonly config: JoltDetectorConfig;
  private gravity: [number, number, number] | null = null;
  private firstT = 0;
  private lastT = 0;
  private lastJoltT = -Infinity;
  private window: { t: number; v: number }[] = [];
  private _vertical = 0;

  constructor(config: Partial<JoltDetectorConfig> = {}) {
    this.config = { ...DEFAULT_JOLT_CONFIG, ...config };
  }

  /** Latest signed vertical dynamic acceleration, m/s^2. */
  get vertical(): number {
    return this._vertical;
  }

  /** Largest |vertical| in the rolling window. */
  get peak(): number {
    let p = 0;
    for (const w of this.window) p = Math.max(p, Math.abs(w.v));
    return p;
  }

  get gravityVector(): readonly [number, number, number] | null {
    return this.gravity;
  }

  push(s: MotionSample): JoltEvent | null {
    const c = this.config;
    if (!Number.isFinite(s.ax + s.ay + s.az)) return null;

    if (this.gravity === null) {
      this.gravity = [s.ax, s.ay, s.az];
      this.firstT = this.lastT = s.t;
      return null;
    }
    const dt = s.t - this.lastT;
    if (dt <= 0) return null; // duplicate or out-of-order timestamp
    this.lastT = s.t;

    const alpha = Math.exp(-dt / c.gravityTimeConstantMs);
    const g = this.gravity;
    g[0] = alpha * g[0] + (1 - alpha) * s.ax;
    g[1] = alpha * g[1] + (1 - alpha) * s.ay;
    g[2] = alpha * g[2] + (1 - alpha) * s.az;

    const norm = Math.hypot(g[0], g[1], g[2]);
    if (norm < 1) return null; // free fall or a broken sensor: no usable gravity direction
    const vertical = ((s.ax - g[0]) * g[0] + (s.ay - g[1]) * g[1] + (s.az - g[2]) * g[2]) / norm;
    this._vertical = vertical;

    this.window.push({ t: s.t, v: vertical });
    while (this.window.length > 0 && s.t - this.window[0]!.t > c.windowMs) this.window.shift();

    if (s.t - this.firstT < c.warmupMs) return null;
    if (Math.abs(vertical) >= c.thresholdMs2 && s.t - this.lastJoltT >= c.refractoryMs) {
      this.lastJoltT = s.t;
      return { t: s.t, magnitude: Math.abs(vertical) };
    }
    return null;
  }

  reset(): void {
    this.gravity = null;
    this.window = [];
    this._vertical = 0;
    this.lastJoltT = -Infinity;
  }
}

// ---------------------------------------------------------------------------------------------------
// Interfaces the pipeline depends on
// ---------------------------------------------------------------------------------------------------

export type MotionPermission = 'granted' | 'denied' | 'unsupported' | 'not-required' | 'unknown';

export interface MotionStatus {
  supported: boolean;
  permission: MotionPermission;
  active: boolean;
  sampleRateHz: number;
  /** ms since the last sample, null if none yet. */
  lastSampleAgeMs: number | null;
  vertical: number;
  peak: number;
  thresholdMs2: number;
  joltCount: number;
  lastJolt: JoltEvent | null;
  /** Human-readable problem, e.g. "no motion data" on a laptop. */
  note: string | null;
}

export interface MotionSource {
  start(): boolean;
  stop(): void;
  onJolt(listener: (jolt: JoltEvent) => void): () => void;
  status(): MotionStatus;
}

export interface GeoFix {
  lat: number;
  lon: number;
  /** Horizontal accuracy radius, metres. */
  accuracy: number;
  /** m/s, null when unknown. */
  speed: number | null;
  /** Degrees clockwise from north, null when unknown or stationary. */
  heading: number | null;
  /** Monotonic ms (performance.now()) when received. */
  t: number;
}

export interface GeoStatus {
  supported: boolean;
  active: boolean;
  fix: GeoFix | null;
  /** ms since the last fix, null if none. */
  fixAgeMs: number | null;
  error: string | null;
}

export interface LocationSource {
  readonly fix: GeoFix | null;
  start(): boolean;
  stop(): void;
  onFix(listener: (fix: GeoFix) => void): () => void;
  status(): GeoStatus;
}

// ---------------------------------------------------------------------------------------------------
// DeviceMotion
// ---------------------------------------------------------------------------------------------------

interface DeviceMotionEventIOS {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

export class MotionSensor implements MotionSource {
  private readonly detector: JoltDetector;
  private listeners = new Set<(jolt: JoltEvent) => void>();
  private active = false;
  private permission: MotionPermission = 'unknown';
  private sampleTimes: number[] = [];
  private lastSampleT: number | null = null;
  private startedAt = 0;
  private joltCount = 0;
  private lastJolt: JoltEvent | null = null;

  constructor(config: Partial<JoltDetectorConfig> = {}) {
    this.detector = new JoltDetector(config);
  }

  private readonly handle = (e: DeviceMotionEvent): void => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    const t = performance.now();
    this.lastSampleT = t;
    this.sampleTimes.push(t);
    while (this.sampleTimes.length > 0 && t - this.sampleTimes[0]! > 1000) this.sampleTimes.shift();
    const jolt = this.detector.push({ t, ax: a.x, ay: a.y, az: a.z });
    if (jolt) {
      this.joltCount += 1;
      this.lastJolt = jolt;
      for (const l of this.listeners) l(jolt);
    }
  };

  /** iPhones ask the user once; everything else needs no prompt. */
  static needsPermission(): boolean {
    return typeof (globalThis.DeviceMotionEvent as unknown as DeviceMotionEventIOS | undefined)?.requestPermission === 'function';
  }

  /** MUST be called from a user gesture on iOS (inside the click handler, before other awaits). */
  async requestPermission(): Promise<MotionPermission> {
    if (typeof DeviceMotionEvent === 'undefined') return (this.permission = 'unsupported');
    const ios = DeviceMotionEvent as unknown as DeviceMotionEventIOS;
    if (typeof ios.requestPermission !== 'function') return (this.permission = 'not-required');
    try {
      this.permission = (await ios.requestPermission()) === 'granted' ? 'granted' : 'denied';
    } catch {
      this.permission = 'denied';
    }
    return this.permission;
  }

  start(): boolean {
    if (typeof DeviceMotionEvent === 'undefined') {
      this.permission = 'unsupported';
      return false;
    }
    if (this.permission === 'denied') return false;
    if (this.active) return true;
    this.detector.reset();
    this.sampleTimes = [];
    this.lastSampleT = null;
    this.startedAt = performance.now();
    window.addEventListener('devicemotion', this.handle);
    this.active = true;
    return true;
  }

  stop(): void {
    window.removeEventListener('devicemotion', this.handle);
    this.active = false;
    this.sampleTimes = [];
  }

  onJolt(listener: (jolt: JoltEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): MotionStatus {
    const now = performance.now();
    const supported = typeof DeviceMotionEvent !== 'undefined';
    let note: string | null = null;
    if (!supported) note = 'This browser has no motion sensors.';
    else if (this.permission === 'denied') note = 'Motion access was denied. On iPhone: Settings > Safari > Motion & Orientation Access.';
    else if (this.active && this.lastSampleT === null && now - this.startedAt > 2000) {
      note = 'No motion data (normal on a laptop). Detections are confirmed by the camera alone.';
    }
    return {
      supported,
      permission: this.permission,
      active: this.active,
      sampleRateHz: this.sampleTimes.length,
      lastSampleAgeMs: this.lastSampleT === null ? null : now - this.lastSampleT,
      vertical: this.detector.vertical,
      peak: this.detector.peak,
      thresholdMs2: this.detector.config.thresholdMs2,
      joltCount: this.joltCount,
      lastJolt: this.lastJolt,
      note,
    };
  }
}

// ---------------------------------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------------------------------

export class GeoTracker implements LocationSource {
  private watchId: number | null = null;
  private listeners = new Set<(fix: GeoFix) => void>();
  private _fix: GeoFix | null = null;
  private error: string | null = null;

  get fix(): GeoFix | null {
    return this._fix;
  }

  start(): boolean {
    if (!('geolocation' in navigator)) {
      this.error = 'This browser has no location API.';
      return false;
    }
    if (this.watchId !== null) return true;
    this.error = null;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        const fix: GeoFix = {
          lat: c.latitude,
          lon: c.longitude,
          accuracy: c.accuracy,
          speed: c.speed,
          heading: c.heading !== null && Number.isFinite(c.heading) ? c.heading : null,
          t: performance.now(),
        };
        this._fix = fix;
        this.error = null;
        for (const l of this.listeners) l(fix);
      },
      (err) => {
        this.error =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was denied. Allow location for this site, then tap Start again.'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'No GPS position yet (is location turned on? indoors?).'
              : 'Timed out waiting for a GPS fix.';
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 },
    );
    return true;
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  onFix(listener: (fix: GeoFix) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): GeoStatus {
    return {
      supported: 'geolocation' in navigator,
      active: this.watchId !== null,
      fix: this._fix,
      fixAgeMs: this._fix === null ? null : performance.now() - this._fix.t,
      error: this.error,
    };
  }
}
