import type { HazardAlerter } from '../alerts.js';
import type { FrameProvider } from '../camera.js';
import type { AppConfig } from '../config.js';
import type { Confirmer } from '../confirmer.js';
import type { Detector, DetectorSelection } from '../detector.js';
import type { DemoSession } from '../demo.js';
import type { Pipeline, PipelineEvent } from '../pipeline.js';
import type { GeoFix, LocationSource, MotionSource } from '../sensors.js';
import type { HazardStore } from '../store.js';
import type { SyncClient } from '../sync.js';
import { Emitter } from './dom.js';

/** Everything that exists while the Drive screen is running. The Debug screen reads it. */
export interface Rig {
  mode: 'live' | 'demo';
  camera: FrameProvider;
  detector: Detector;
  motion: MotionSource;
  geo: LocationSource;
  confirmer: Confirmer;
  pipeline: Pipeline;
  /** Hazard-ahead warnings for this drive. */
  alerts: HazardAlerter;
  demo: DemoSession | null;
  stop(): void;
}

export interface ServiceWorkerState {
  supported: boolean;
  registered: boolean;
  /** The page is being served by a service worker (so a reload works offline). */
  controlled: boolean;
  offlineReady: boolean;
  updateReady: boolean;
  error: string | null;
}

export interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export class LogBuffer {
  readonly lines: LogLine[] = [];
  readonly changed = new Emitter<LogLine>();
  add(text: string, level: LogLine['level'] = 'info'): void {
    const line = { at: Date.now(), level, text };
    this.lines.push(line);
    if (this.lines.length > 80) this.lines.shift();
    if (level === 'error') console.error(text);
    this.changed.emit(line);
  }
}

export interface AppContext {
  config: AppConfig;
  deviceId: string;
  store: HazardStore;
  sync: SyncClient;
  log: LogBuffer;
  sw: ServiceWorkerState;
  /** The live detector choice, once something has been started. */
  detectorSelection: DetectorSelection | null;
  rig: Rig | null;
  /** Latest GPS fix from whatever is running (real or demo); the Map shows it. */
  position: Emitter<GeoFix>;
  /** Everything notable the pipeline did. */
  pipelineEvents: Emitter<PipelineEvent>;
}
