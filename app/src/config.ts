/**
 * Runtime configuration. Precedence: URL query (?detector=mock&fps=6&hub=wss://...&model=...&demo=1&camera=front)
 * > saved settings (Debug screen) > build-time env (VITE_*) > defaults.
 * Everything here is non-secret and safe to commit.
 */

import { newDeviceId, DEMO_CENTER, WS_PATH } from '@lubak/shared';

export type DetectorChoice = 'auto' | 'mock' | 'onnx';

/**
 * Which camera looks at the road. 'rear' is the phone's back camera: with the phone mounted screen-toward-rider it is
 * the one that faces forward, so it is the default. 'front' (the selfie camera) is only for testing, e.g. a phone
 * mounted the other way round, or a laptop webcam.
 */
export type CameraFacing = 'rear' | 'front';

export const SAMPLE_FPS_MIN = 5;
export const SAMPLE_FPS_MAX = 10;
export const MODEL_INPUT_SIZE = 320;

export interface TileConfig {
  urlTemplate: string;
  minZoom: number;
  /** Deepest zoom that has real tiles; Leaflet scales them up beyond this. */
  maxNativeZoom: number;
  maxZoom: number;
  attribution: string;
}

export interface AppConfig {
  detector: DetectorChoice;
  modelUrl: string;
  inputSize: number;
  camera: CameraFacing;
  sampleFps: number;
  hubUrl: string;
  /** Start the Drive screen in Demo Mode. */
  demo: boolean;
  tiles: TileConfig;
  mapCenter: { lat: number; lon: number; zoom: number };
}

interface Persisted {
  detector?: DetectorChoice;
  sampleFps?: number;
  hubUrl?: string;
}

const SETTINGS_KEY = 'lubak.settings';
const DEVICE_KEY = 'lubak.deviceId';

/** localStorage can throw (private mode, blocked site data). Never let that break the app. */
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore: settings simply do not persist */
  }
}

function readPersisted(): Persisted {
  try {
    const raw = readStorage(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : {};
  } catch {
    return {};
  }
}

export function saveSettings(patch: Persisted): void {
  writeStorage(SETTINGS_KEY, JSON.stringify({ ...readPersisted(), ...patch }));
}

export function clampFps(value: number): number {
  if (!Number.isFinite(value)) return 8;
  return Math.min(SAMPLE_FPS_MAX, Math.max(SAMPLE_FPS_MIN, Math.round(value)));
}

const isDetectorChoice = (v: unknown): v is DetectorChoice => v === 'auto' || v === 'mock' || v === 'onnx';

/** Same origin as the page: the hub serves the app and /ws together (Vite proxies /ws in dev). */
export function defaultHubUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${WS_PATH}`;
}

export function normalizeHubUrl(raw: string, fallback: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    if (u.protocol === 'https:') u.protocol = 'wss:';
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return fallback;
    if (u.pathname === '/') u.pathname = WS_PATH;
    return u.toString();
  } catch {
    return fallback;
  }
}

export function loadConfig(search: string = location.search, loc: Pick<Location, 'protocol' | 'host'> = location): AppConfig {
  const q = new URLSearchParams(search);
  const saved = readPersisted();
  const base = import.meta.env.BASE_URL;

  const fromQuery = q.get('detector');
  const detector: DetectorChoice = isDetectorChoice(fromQuery)
    ? fromQuery
    : isDetectorChoice(saved.detector)
      ? saved.detector
      : isDetectorChoice(import.meta.env.VITE_DETECTOR)
        ? import.meta.env.VITE_DETECTOR
        : 'auto';

  const fpsRaw = q.get('fps') ?? saved.sampleFps;
  const hubFallback = defaultHubUrl(loc);

  return {
    detector,
    modelUrl: q.get('model') ?? `${base}models/lubak.onnx`,
    inputSize: MODEL_INPUT_SIZE,
    camera: q.get('camera') === 'front' ? 'front' : 'rear',
    sampleFps: clampFps(fpsRaw === undefined || fpsRaw === null ? 8 : Number(fpsRaw)),
    hubUrl: normalizeHubUrl(q.get('hub') ?? saved.hubUrl ?? hubFallback, hubFallback),
    demo: q.get('demo') === '1',
    tiles: {
      urlTemplate: `${base}tiles/{z}/{x}/{y}.png`,
      minZoom: 10,
      maxNativeZoom: 17,
      maxZoom: 19,
      attribution: import.meta.env.VITE_TILE_ATTRIBUTION ?? '© OpenStreetMap contributors (offline tiles)',
    },
    mapCenter: { lat: DEMO_CENTER.lat, lon: DEMO_CENTER.lon, zoom: 14 },
  };
}

/** Random per-install id; the only identifier that ever leaves the phone, and it says nothing about the owner. */
export function getOrCreateDeviceId(): string {
  const existing = readStorage(DEVICE_KEY);
  if (existing && /^[0-9a-f]{16}$/.test(existing)) return existing;
  const id = newDeviceId();
  writeStorage(DEVICE_KEY, id);
  return id;
}
