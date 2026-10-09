/**
 * MotionSensor (DeviceMotion -> jolts) and GeoTracker (watchPosition -> fixes): the two browser-facing boxes of the chart, "Motion
 * (jolt detector)" and "GPS (watchPosition)". The signal processing under MotionSensor is covered by jolt.test.ts; here the browser
 * APIs are replaced by small fakes, with a virtual performance.now(), so the glue is checked too: permission flow, event handling,
 * and what the pipeline receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoTracker, MotionSensor, type GeoFix, type JoltEvent } from '../src/sensors.js';

const G = 9.81;
const HZ = 60;
const clock = { t: 0 };

type Accel = { x: number | null; y: number | null; z: number | null } | null;

class FakeDeviceMotionEvent extends Event {
  readonly accelerationIncludingGravity: Accel;
  constructor(type: string, init: { accelerationIncludingGravity?: Accel } = {}) {
    super(type);
    this.accelerationIncludingGravity = init.accelerationIncludingGravity ?? null;
  }
}

let win: EventTarget;

beforeEach(() => {
  clock.t = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  win = new EventTarget();
  vi.stubGlobal('window', win);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const deviceMotion = (accel: Accel): void => void win.dispatchEvent(new FakeDeviceMotionEvent('devicemotion', { accelerationIncludingGravity: accel }));

/** A phone lying flat, reporting gravity at 60 Hz for `ms`; with a 50 ms bump of +9 m/s^2 along gravity at `bumpAt` if given. */
function streamFlat(ms: number, bumpAt?: number): void {
  const end = clock.t + ms;
  for (; clock.t < end; clock.t += 1000 / HZ) {
    const bump = bumpAt !== undefined && clock.t >= bumpAt && clock.t < bumpAt + 50 ? 9 : 0;
    deviceMotion({ x: 0, y: 0, z: G + bump });
  }
}

describe('MotionSensor: DeviceMotion events -> jolts', () => {
  it('a browser without motion sensors: start() says no, and the status says why', () => {
    vi.stubGlobal('DeviceMotionEvent', undefined);
    const sensor = new MotionSensor();
    expect(sensor.start()).toBe(false);
    expect(sensor.status()).toMatchObject({ supported: false, permission: 'unsupported', active: false });
    expect(sensor.status().note).toMatch(/no motion sensors/);
  });

  it('Android and desktop browsers need no permission prompt', async () => {
    vi.stubGlobal('DeviceMotionEvent', FakeDeviceMotionEvent);
    expect(MotionSensor.needsPermission()).toBe(false);
    const sensor = new MotionSensor();
    expect(await sensor.requestPermission()).toBe('not-required');
    expect(sensor.start()).toBe(true);
  });

  describe('iPhone: the permission prompt', () => {
    const ios = (answer: 'granted' | 'denied' | Error): ReturnType<typeof vi.fn> => {
      const requestPermission = vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      vi.stubGlobal('DeviceMotionEvent', Object.assign(class extends FakeDeviceMotionEvent {}, { requestPermission }));
      return requestPermission;
    };

    it('granted: motion starts', async () => {
      const ask = ios('granted');
      expect(MotionSensor.needsPermission()).toBe(true);
      const sensor = new MotionSensor();
      expect(await sensor.requestPermission()).toBe('granted');
      expect(ask).toHaveBeenCalledTimes(1);
      expect(sensor.start()).toBe(true);
    });

    it('denied, or a prompt that throws: nothing is listened to, and the status points at the iPhone setting', async () => {
      for (const answer of ['denied', new Error('not from a user gesture')] as const) {
        ios(answer);
        const sensor = new MotionSensor();
        expect(await sensor.requestPermission()).toBe('denied');
        expect(sensor.start()).toBe(false);
        expect(sensor.status().note).toMatch(/Settings > Safari > Motion/);
      }
    });
  });

  describe('with motion available', () => {
    let sensor: MotionSensor;
    let jolts: JoltEvent[];

    beforeEach(() => {
      vi.stubGlobal('DeviceMotionEvent', FakeDeviceMotionEvent);
      sensor = new MotionSensor();
      jolts = [];
      sensor.onJolt((j) => jolts.push(j));
      expect(sensor.start()).toBe(true);
    });

    it('steady gravity is silent; a bump along gravity becomes one jolt with its size and its time', () => {
      streamFlat(1500);
      expect(jolts).toEqual([]);

      const at = clock.t + 100;
      streamFlat(500, at);
      expect(jolts).toHaveLength(1);
      expect(jolts[0]!.t).toBeGreaterThanOrEqual(at);
      expect(jolts[0]!.t).toBeLessThan(at + 100);
      expect(jolts[0]!.magnitude).toBeGreaterThan(sensor.status().thresholdMs2);

      expect(sensor.status()).toMatchObject({ supported: true, active: true, joltCount: 1, lastJolt: jolts[0] });
      expect(sensor.status().sampleRateHz).toBeGreaterThanOrEqual(HZ - 2);
    });

    it('a listener that unsubscribed hears nothing more', () => {
      const late: JoltEvent[] = [];
      const off = sensor.onJolt((j) => late.push(j));
      streamFlat(1500);
      off();
      streamFlat(300, clock.t + 50);
      expect(jolts).toHaveLength(1);
      expect(late).toEqual([]);
    });

    it('stop() detaches from the window: later motion is not even sampled', () => {
      streamFlat(1500);
      sensor.stop();
      expect(sensor.status().active).toBe(false);
      streamFlat(300, clock.t + 50);
      expect(jolts).toEqual([]);
      expect(sensor.status().joltCount).toBe(0);
    });

    it('events carrying no acceleration (a laptop fires them) are ignored, and after 2 s the status explains', () => {
      deviceMotion({ x: null, y: null, z: null });
      deviceMotion(null);
      clock.t = 2500;
      const status = sensor.status();
      expect(status.lastSampleAgeMs).toBeNull();
      expect(status.note).toMatch(/No motion data/);
      expect(jolts).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------

interface WatchHandlers {
  ok: PositionCallback;
  fail: PositionErrorCallback;
  options: PositionOptions;
}

/** A fake navigator.geolocation. `handlers` is filled in when the tracker calls watchPosition. */
function fakeGeolocation(): { geolocation: { watchPosition: ReturnType<typeof vi.fn>; clearWatch: ReturnType<typeof vi.fn> }; handlers: Partial<WatchHandlers> } {
  const handlers: Partial<WatchHandlers> = {};
  const geolocation = {
    watchPosition: vi.fn((ok: PositionCallback, fail: PositionErrorCallback, options: PositionOptions) => {
      Object.assign(handlers, { ok, fail, options });
      return 42;
    }),
    clearWatch: vi.fn(),
  };
  vi.stubGlobal('navigator', { geolocation });
  return { geolocation, handlers };
}

const position = (coords: Partial<Record<'latitude' | 'longitude' | 'accuracy' | 'speed' | 'heading', number | null>> = {}): GeolocationPosition =>
  ({ coords: { latitude: 14.585, longitude: 121.176, accuracy: 6, speed: 7, heading: 90, altitude: null, altitudeAccuracy: null, ...coords }, timestamp: 0 }) as unknown as GeolocationPosition;

const positionError = (code: 1 | 2 | 3): GeolocationPositionError => ({ code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }) as GeolocationPositionError;

describe('GeoTracker: watchPosition -> fixes', () => {
  it('a browser without a location API: start() says no, and the status says why', () => {
    vi.stubGlobal('navigator', {});
    const tracker = new GeoTracker();
    expect(tracker.start()).toBe(false);
    expect(tracker.status()).toMatchObject({ supported: false, active: false, error: expect.stringMatching(/no location API/) });
  });

  it('watches (not one-shot) with high accuracy, and a second start() does not open a second watch', () => {
    const { geolocation, handlers } = fakeGeolocation();
    const tracker = new GeoTracker();
    expect(tracker.start()).toBe(true);
    expect(tracker.start()).toBe(true);
    expect(geolocation.watchPosition).toHaveBeenCalledTimes(1);
    expect(handlers.options).toMatchObject({ enableHighAccuracy: true });
    expect(tracker.status().active).toBe(true);
  });

  it('a position becomes a fix with the browser\'s numbers and a monotonic timestamp; listeners hear it; its age grows', () => {
    const { handlers } = fakeGeolocation();
    const tracker = new GeoTracker();
    const heard: GeoFix[] = [];
    tracker.onFix((f) => heard.push(f));
    tracker.start();
    expect(tracker.fix).toBeNull();

    clock.t = 1234;
    handlers.ok!(position({ latitude: 14.58512, longitude: 121.17634, accuracy: 4.5, speed: 6.9, heading: 181 }));
    const expected: GeoFix = { lat: 14.58512, lon: 121.17634, accuracy: 4.5, speed: 6.9, heading: 181, t: 1234 };
    expect(tracker.fix).toEqual(expected);
    expect(heard).toEqual([expected]);

    clock.t = 3234;
    expect(tracker.status()).toMatchObject({ fix: expected, fixAgeMs: 2000, error: null });
  });

  it('a heading the browser cannot give (null, or NaN while standing still) becomes null; an unknown speed stays null', () => {
    const { handlers } = fakeGeolocation();
    const tracker = new GeoTracker();
    tracker.start();
    handlers.ok!(position({ heading: Number.NaN, speed: null }));
    expect(tracker.fix).toMatchObject({ heading: null, speed: null });
    handlers.ok!(position({ heading: null }));
    expect(tracker.fix!.heading).toBeNull();
  });

  it('errors are explained in words, and the next good fix clears them', () => {
    const { handlers } = fakeGeolocation();
    const tracker = new GeoTracker();
    tracker.start();

    handlers.fail!(positionError(1));
    expect(tracker.status().error).toMatch(/permission was denied/);
    handlers.fail!(positionError(2));
    expect(tracker.status().error).toMatch(/No GPS position yet/);
    handlers.fail!(positionError(3));
    expect(tracker.status().error).toMatch(/Timed out/);

    handlers.ok!(position());
    expect(tracker.status().error).toBeNull();
  });

  it('stop() ends the watch, and the tracker can start again', () => {
    const { geolocation } = fakeGeolocation();
    const tracker = new GeoTracker();
    tracker.start();
    tracker.stop();
    expect(geolocation.clearWatch).toHaveBeenCalledWith(42);
    expect(tracker.status().active).toBe(false);
    expect(tracker.start()).toBe(true);
    expect(geolocation.watchPosition).toHaveBeenCalledTimes(2);
  });

  it('a listener that unsubscribed hears nothing more', () => {
    const { handlers } = fakeGeolocation();
    const tracker = new GeoTracker();
    const heard: GeoFix[] = [];
    const off = tracker.onFix((f) => heard.push(f));
    tracker.start();
    handlers.ok!(position());
    off();
    handlers.ok!(position());
    expect(heard).toHaveLength(1);
  });
});
