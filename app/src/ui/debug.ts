/** Debug screen: everything a teammate needs to see while tuning the pipeline, in one place. */

import { HAZARD_CLASSES } from '@lubak/shared';
import { saveSettings, clampFps, SAMPLE_FPS_MAX, SAMPLE_FPS_MIN, normalizeHubUrl, normalizePin, type DetectorChoice } from '../config.js';
import { describeClockSkew } from './clock.js';
import type { AppContext } from './context.js';
import { h, setText } from './dom.js';

type Tone = 'ok' | 'warn' | 'bad' | undefined;
interface Row {
  label: string;
  value: () => string;
  tone?: () => Tone;
}
interface Section {
  title: string;
  rows: Row[];
}

const num = (x: number | null | undefined, digits = 1, unit = ''): string => (x === null || x === undefined || !Number.isFinite(x) ? '–' : `${x.toFixed(digits)}${unit}`);
const age = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '–' : ms < 1000 ? `${Math.round(ms)} ms ago` : `${(ms / 1000).toFixed(1)} s ago`);
const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

export class DebugScreen {
  readonly el: HTMLElement;
  private readonly cells: { value: HTMLElement; row: Row }[] = [];
  private readonly logList = h('ol', { class: 'log' });
  private visible = false;
  private hazardCount = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ctx: AppContext) {
    const sections = this.sections();
    this.el = h(
      'section',
      { class: 'screen debug', id: 'screen-debug' },
      h(
        'div',
        { class: 'debug-scroll' },
        h('h2', null, 'Debug'),
        ...sections.map((s) => this.renderSection(s)),
        this.renderActions(),
        h('h3', null, 'Recent events'),
        this.logList,
      ),
    );
    ctx.log.changed.on(() => this.renderLog());
    this.renderLog();
    this.ticker = setInterval(() => {
      if (!this.visible) return;
      this.update();
    }, 250);
    setInterval(() => {
      if (this.visible) void ctx.store.getAll().then((all) => (this.hazardCount = all.length));
    }, 1000);
  }

  onShow(): void {
    this.visible = true;
    this.update();
  }
  onHide(): void {
    this.visible = false;
  }
  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  // -----------------------------------------------------------------------------------------------

  private sections(): Section[] {
    const ctx = this.ctx;
    const rig = (): AppContext['rig'] => ctx.rig;
    const stats = () => rig()?.pipeline.stats;
    const motion = () => rig()?.motion.status();
    const geo = () => rig()?.geo.status();
    const sync = () => ctx.sync.status;
    const info = () => rig()?.detector.info() ?? ctx.detectorSelection?.detector.info();

    return [
      {
        title: 'Pipeline',
        rows: [
          { label: 'Mode', value: () => (rig() ? (rig()!.mode === 'demo' ? 'DEMO (replayed drive)' : 'live camera') : 'stopped'), tone: () => (rig()?.mode === 'demo' ? 'warn' : undefined) },
          { label: 'Camera', value: () => (ctx.config.camera === 'front' ? 'front (selfie) camera: testing only' : 'rear camera (faces the road when mounted)'), tone: () => (ctx.config.camera === 'front' ? 'warn' : undefined) },
          { label: 'Capture rate', value: () => `${num(rig()?.camera.measuredFps, 1)} fps (target ${ctx.config.sampleFps})` },
          { label: 'Inference rate', value: () => `${num(stats()?.processedFps, 1)} fps` },
          { label: 'Inference time', value: () => `${num(stats()?.inferenceMsLast, 1)} ms last · ${num(stats()?.inferenceMsAvg, 1)} avg · ${num(stats()?.inferenceMsP95, 1)} p95` },
          { label: 'Frames', value: () => `${stats()?.framesIn ?? 0} in · ${stats()?.framesProcessed ?? 0} processed · ${stats()?.framesDropped ?? 0} dropped (detector busy)` },
          { label: 'Detections seen', value: () => String(stats()?.detections ?? 0) },
          { label: 'Confirmed', value: () => `${stats()?.confirmed ?? 0} (${stats()?.boosted ?? 0} boosted by a jolt)` },
          { label: 'Seen but not recorded', value: () => `${stats()?.noFix ?? 0} (no usable GPS fix)`, tone: () => ((stats()?.noFix ?? 0) > 0 ? 'warn' : undefined) },
          { label: 'Hazard warnings', value: () => { const a = rig()?.alerts.stats; return a ? `${a.warnings}${a.last ? ` · last: ${a.last.hazard.cls} at ${Math.round(a.last.distanceM)} m` : ''}` : '–'; } },
          {
            label: 'Confirmer streaks',
            value: () => {
              const r = rig();
              if (!r) return '–';
              const d = r.confirmer.debug(performance.now());
              const need = r.confirmer.config.consecutiveFrames;
              return HAZARD_CLASSES.map((c) => `${c} ${d.streaks[c]}/${need}${d.cooldownRemainingMs[c] > 0 ? ` (cooldown ${(d.cooldownRemainingMs[c] / 1000).toFixed(1)} s)` : ''}`).join(' · ');
            },
          },
          { label: 'Errors', value: () => (stats()?.errors ? `${stats()!.errors}: ${stats()!.lastError}` : 'none'), tone: () => ((stats()?.errors ?? 0) > 0 ? 'bad' : undefined) },
        ],
      },
      {
        title: 'Detector',
        rows: [
          { label: 'Flag', value: () => `${ctx.config.detector}${ctx.detectorSelection?.fellBackBecause ? ` → fell back (${ctx.detectorSelection.fellBackBecause})` : ''}` },
          { label: 'In use', value: () => (info() ? `${info()!.kind} / ${info()!.backend}` : 'not started'), tone: () => (info()?.kind === 'mock' ? 'bad' : info()?.kind === 'replay' ? 'warn' : undefined) },
          { label: 'Model', value: () => `${info()?.model ?? '–'}${info()?.loadMs ? ` (loaded in ${Math.round(info()!.loadMs!)} ms)` : ''}` },
          { label: 'Last frame split', value: () => (info()?.timings ? `preprocess ${num(info()!.timings!.preMs, 1)} ms · model ${num(info()!.timings!.runMs, 1)} ms · decode + NMS ${num(info()!.timings!.postMs, 1)} ms` : '–') },
          { label: 'Detector error', value: () => info()?.error ?? 'none', tone: () => (info()?.error ? 'bad' : undefined) },
        ],
      },
      {
        title: 'Motion (jolts)',
        rows: [
          { label: 'Permission', value: () => motion()?.permission ?? '–' },
          { label: 'Sample rate', value: () => `${motion()?.sampleRateHz ?? 0} Hz` },
          { label: 'Vertical accel', value: () => `${num(motion()?.vertical, 2)} m/s² now · ${num(motion()?.peak, 2)} peak (1 s) · threshold ${num(motion()?.thresholdMs2, 1)}` },
          { label: 'Jolts', value: () => `${motion()?.joltCount ?? 0}${motion()?.lastJolt ? ` · last ${num(motion()!.lastJolt!.magnitude, 1)} m/s²` : ''}` },
          { label: 'Note', value: () => motion()?.note ?? '–', tone: () => (motion()?.note?.startsWith('DEMO') ? 'warn' : motion()?.note ? 'warn' : undefined) },
        ],
      },
      {
        title: 'GPS',
        rows: [
          { label: 'Accuracy', value: () => (geo()?.fix ? `±${Math.round(geo()!.fix!.accuracy)} m` : '–'), tone: () => { const f = geo()?.fix; return f ? (f.accuracy <= 20 ? 'ok' : f.accuracy <= 50 ? 'warn' : 'bad') : undefined; } },
          { label: 'Position', value: () => (geo()?.fix ? `${geo()!.fix!.lat.toFixed(5)}, ${geo()!.fix!.lon.toFixed(5)}` : '–') },
          { label: 'Speed / heading', value: () => `${geo()?.fix?.speed != null ? num(geo()!.fix!.speed! * 3.6, 0, ' km/h') : '–'} · ${num(geo()?.fix?.heading, 0, '°')}` },
          { label: 'Fix age', value: () => (geo()?.fix ? age(performance.now() - geo()!.fix!.t) : '–') },
          { label: 'Problem', value: () => geo()?.error ?? 'none', tone: () => (geo()?.error ? 'bad' : undefined) },
        ],
      },
      {
        title: 'Sync',
        rows: [
          { label: 'State', value: () => sync().state, tone: () => (sync().state === 'connected' ? 'ok' : sync().state === 'connecting' ? 'warn' : 'bad') },
          { label: 'Hub URL', value: () => sync().url },
          { label: 'Retry', value: () => (sync().retryInMs !== null ? `attempt ${sync().attempt}, in ${(sync().retryInMs! / 1000).toFixed(1)} s` : '–') },
          { label: 'Round trip', value: () => num(sync().rttMs, 0, ' ms') },
          { label: 'Clock vs hub', value: () => describeClockSkew(sync().clockSkewMs).text, tone: () => describeClockSkew(sync().clockSkewMs).tone },
          { label: 'Waiting to sync', value: () => String(sync().pending), tone: () => (sync().pending > 0 ? 'warn' : undefined) },
          { label: 'Hazards sent / received', value: () => `${sync().sent} / ${sync().received}` },
          { label: 'Last message', value: () => (sync().lastMessageAt ? age(Date.now() - sync().lastMessageAt!) : '–') },
          { label: 'Problem', value: () => sync().error ?? 'none', tone: () => (sync().error ? 'warn' : undefined) },
        ],
      },
      {
        title: 'App',
        rows: [
          { label: 'Hazards on this phone', value: () => String(this.hazardCount) },
          { label: 'Secure context', value: () => yesNo(window.isSecureContext), tone: () => (window.isSecureContext ? 'ok' : 'bad') },
          { label: 'Network link', value: () => (navigator.onLine ? 'online (may be a hotspot without internet)' : 'offline') },
          { label: 'Offline ready', value: () => (ctx.sw.error ? `service worker error: ${ctx.sw.error}` : !ctx.sw.supported ? 'no service worker support' : ctx.sw.offlineReady ? 'yes, cached' : ctx.sw.controlled ? 'service worker active' : ctx.sw.registered ? 'registered, caching…' : 'not registered'), tone: () => (ctx.sw.offlineReady || ctx.sw.controlled ? 'ok' : ctx.sw.error ? 'bad' : 'warn') },
          { label: 'Installed (standalone)', value: () => yesNo(window.matchMedia('(display-mode: standalone)').matches) },
          { label: 'Storage', value: () => ctx.store.backendKind, tone: () => (ctx.store.backendKind === 'memory' ? 'bad' : undefined) },
          { label: 'Device id', value: () => ctx.deviceId },
          { label: 'Build', value: () => `${import.meta.env.MODE}${typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? ' · cross-origin isolated' : ''}` },
        ],
      },
    ];
  }

  private renderSection(section: Section): HTMLElement {
    const dl = h('dl', { class: 'kv' });
    for (const row of section.rows) {
      const value = h('dd', null, '–');
      dl.append(h('dt', null, row.label), value);
      this.cells.push({ value, row });
    }
    return h('div', { class: 'debug-section' }, h('h3', null, section.title), dl);
  }

  private update(): void {
    for (const { value, row } of this.cells) {
      setText(value, row.value());
      const tone = row.tone?.();
      value.className = tone ?? '';
    }
  }

  private renderLog(): void {
    const items = this.ctx.log.lines.slice(-30).reverse();
    this.logList.replaceChildren(
      ...items.map((l) => h('li', { class: l.level }, h('time', null, new Date(l.at).toTimeString().slice(0, 8)), ' ', l.text)),
    );
  }

  private renderActions(): HTMLElement {
    const ctx = this.ctx;

    const detectorSelect = h('select', { id: 'detector-select', 'aria-label': 'Detector' },
      ...(['auto', 'mock', 'onnx'] as DetectorChoice[]).map((v) => h('option', { value: v, selected: v === ctx.config.detector }, v === 'auto' ? 'auto (real model, mock if missing)' : v === 'mock' ? 'mock (random boxes)' : 'onnx (real model only)')),
    );
    detectorSelect.addEventListener('change', () => {
      saveSettings({ detector: detectorSelect.value as DetectorChoice });
      ctx.log.add('Detector flag saved. Reloading to apply…');
      setTimeout(() => location.reload(), 300);
    });

    const fpsSelect = h('select', { id: 'fps-select', 'aria-label': 'Capture rate' },
      ...Array.from({ length: SAMPLE_FPS_MAX - SAMPLE_FPS_MIN + 1 }, (_, i) => SAMPLE_FPS_MIN + i).map((v) => h('option', { value: String(v), selected: v === ctx.config.sampleFps }, `${v} fps`)),
    );
    fpsSelect.addEventListener('change', () => {
      const fps = clampFps(Number(fpsSelect.value));
      ctx.config.sampleFps = fps;
      saveSettings({ sampleFps: fps });
      if (ctx.rig?.mode === 'live' && 'setFps' in ctx.rig.camera) ctx.rig.camera.setFps(fps);
      ctx.log.add(`Capture rate set to ${fps} fps`);
    });

    const hubInput = h('input', { type: 'url', id: 'hub-url', value: ctx.config.hubUrl, spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Hub WebSocket URL' });
    const saveHub = h('button', { class: 'btn small', type: 'button', onClick: () => {
      const url = normalizeHubUrl(hubInput.value, ctx.config.hubUrl);
      ctx.config.hubUrl = url;
      hubInput.value = url;
      saveSettings({ hubUrl: url });
      ctx.sync.setUrl(url);
      ctx.log.add(`Hub URL set to ${url}`);
    } }, 'Save');

    const pinInput = h('input', { type: 'text', id: 'hub-pin', value: ctx.config.hubPin ?? '', placeholder: 'none', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Hub event PIN' });
    const savePin = h('button', { class: 'btn small', type: 'button', onClick: () => {
      const raw = pinInput.value.trim();
      const pin = normalizePin(raw);
      if (raw !== '' && pin === null) {
        ctx.log.add('A hub PIN is 4 to 32 letters, digits, "-" or "_"; not saved.', 'warn');
        return;
      }
      ctx.config.hubPin = pin;
      saveSettings({ hubPin: pin ?? '' });
      ctx.sync.setPin(pin);
      ctx.log.add(pin ? 'Hub PIN saved; reconnecting.' : 'Hub PIN cleared; reconnecting.');
    } }, 'Save');

    const button = (label: string, onClick: () => void, cls = 'btn small'): HTMLButtonElement => h('button', { class: cls, type: 'button', onClick }, label);

    return h(
      'div',
      { class: 'debug-section actions' },
      h('h3', null, 'Controls'),
      h('label', { class: 'field' }, h('span', null, 'Detector flag'), detectorSelect),
      h('label', { class: 'field' }, h('span', null, 'Capture rate'), fpsSelect),
      h('label', { class: 'field' }, h('span', null, 'Hub URL'), h('span', { class: 'field-row' }, hubInput, saveHub)),
      h('label', { class: 'field' }, h('span', null, 'Hub PIN (only if the hub asks for one)'), h('span', { class: 'field-row' }, pinInput, savePin)),
      h(
        'div',
        { class: 'button-row' },
        button('Reconnect now', () => ctx.sync.reconnectNow()),
        button('Copy diagnostics', () => void this.copyDiagnostics()),
        button('Clear hazards on this phone', () => {
          if (confirm('Delete every hazard stored on THIS phone? The hub keeps its copy and will send them back on the next sync.')) void ctx.store.clear().then(() => ctx.log.add('Local hazards cleared'));
        }, 'btn small danger'),
        button('Reset app cache & reload', () => void this.resetCaches(), 'btn small danger'),
      ),
    );
  }

  private async copyDiagnostics(): Promise<void> {
    const ctx = this.ctx;
    const diag = {
      time: new Date().toISOString(),
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      config: { ...ctx.config, hubPin: ctx.config.hubPin ? '(set)' : null }, // never paste the PIN into a chat
      detector: ctx.rig?.detector.info() ?? ctx.detectorSelection?.detector.info() ?? null,
      pipeline: ctx.rig?.pipeline.stats ?? null,
      motion: ctx.rig?.motion.status() ?? null,
      sync: ctx.sync.status,
      serviceWorker: ctx.sw,
      hazards: this.hazardCount,
      log: ctx.log.lines.slice(-30),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      ctx.log.add('Diagnostics copied to the clipboard');
    } catch {
      console.log(diag);
      ctx.log.add('Could not use the clipboard; diagnostics are in the browser console', 'warn');
    }
  }

  /** Stale service workers are the classic PWA development trap: this clears them. */
  private async resetCaches(): Promise<void> {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
      for (const key of await caches.keys()) await caches.delete(key);
    } finally {
      location.reload();
    }
  }
}
