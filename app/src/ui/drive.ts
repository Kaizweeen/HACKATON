/**
 * Drive screen: live camera preview with detection boxes, status, and the Start / Demo Mode controls.
 *
 * The camera's <video> is hidden (see camera.ts). This screen redraws it onto a visible canvas every animation frame
 * (smooth preview) and paints the latest detections on top (they update at the 5..10 fps sampling rate).
 */

import { Camera, type FrameProvider } from '../camera.js';
import { CLASS_STYLE } from '../classes.js';
import { Confirmer } from '../confirmer.js';
import { DemoSession } from '../demo.js';
import { createDetector, type Detection } from '../detector.js';
import { Pipeline, type FrameResult, type PipelineEvent } from '../pipeline.js';
import { GeoTracker, MotionSensor } from '../sensors.js';
import type { AppContext, Rig } from './context.js';
import { h, setText } from './dom.js';

interface DrawnResult extends FrameResult {
  at: number;
}

function sourceSize(src: CanvasImageSource): [number, number] {
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight];
  if (src instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas)) return [src.width, src.height];
  return [0, 0];
}

export class DriveScreen {
  readonly el: HTMLElement;

  private readonly canvas = h('canvas', { class: 'preview', 'aria-label': 'Camera preview with detection boxes' });
  private readonly draw2d: CanvasRenderingContext2D;
  private readonly detectorChip = h('span', { class: 'chip' }, 'Detector: not started');
  private readonly gpsChip = h('span', { class: 'chip' }, 'GPS: off');
  private readonly modeChip = h('span', { class: 'chip demo', hidden: true }, 'DEMO MODE: replaying a recorded drive');
  private readonly fpsChip = h('span', { class: 'chip' }, '–');
  private readonly toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  private readonly idleCard: HTMLElement;
  private readonly startButton = h('button', { class: 'btn primary', type: 'button', onClick: () => void this.toggle() }, 'Start');
  private readonly demoToggle = h('input', { type: 'checkbox', id: 'demo-toggle' });
  private readonly statusLine = h('div', { class: 'status-line', role: 'status' });
  private readonly warning = h('div', { class: 'warn-banner', hidden: true });

  private camera: Camera | null = null;
  private starting = false;
  private lastResult: DrawnResult | null = null;
  private flashUntil = 0;
  private flashColor = '#ffffff';
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private disposers: (() => void)[] = [];

  constructor(private readonly ctx: AppContext) {
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('canvas 2d context unavailable');
    this.draw2d = g;

    this.demoToggle.checked = ctx.config.demo;
    this.demoToggle.addEventListener('change', () => {
      this.refreshIdleCard();
      if (this.ctx.rig) void this.stop().then(() => this.start());
    });

    this.idleCard = h('div', { class: 'idle-card' });
    this.el = h(
      'section',
      { class: 'screen drive', id: 'screen-drive' },
      h(
        'div',
        { class: 'preview-wrap' },
        this.canvas,
        h('div', { class: 'hud hud-top' }, this.detectorChip, this.gpsChip),
        h('div', { class: 'hud hud-mode' }, this.modeChip),
        h('div', { class: 'hud hud-bottom' }, this.fpsChip),
        this.toast,
        this.idleCard,
      ),
      h(
        'div',
        { class: 'controls' },
        this.warning,
        this.statusLine,
        h(
          'div',
          { class: 'control-row' },
          this.startButton,
          h('label', { class: 'switch', for: 'demo-toggle' }, this.demoToggle, h('span', { class: 'switch-track' }), h('span', null, 'Demo mode')),
        ),
      ),
    );

    this.refreshIdleCard();
    this.renderStatus('Ready. Mount the phone, then tap Start.');
    this.raf = requestAnimationFrame(this.paint);
    this.ticker = setInterval(() => this.updateHud(), 250);
    this.disposers.push(ctx.pipelineEvents.on((e) => this.onPipelineEvent(e)));
  }

  /** Called when the tab becomes visible. */
  onShow(): void {
    this.fitCanvas();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    if (this.ticker) clearInterval(this.ticker);
    for (const d of this.disposers) d();
    void this.stop();
    this.camera?.dispose();
  }

  // -----------------------------------------------------------------------------------------------
  // start / stop
  // -----------------------------------------------------------------------------------------------

  private async toggle(): Promise<void> {
    if (this.ctx.rig || this.starting) await this.stop();
    else await this.start();
  }

  private async start(): Promise<void> {
    if (this.starting || this.ctx.rig) return;
    this.starting = true;
    this.startButton.disabled = true;
    this.warning.hidden = true;
    const demo = this.demoToggle.checked;
    try {
      const rig = demo ? await this.buildDemoRig() : await this.buildLiveRig();
      this.ctx.rig = rig;
      this.startButton.textContent = 'Stop';
      this.startButton.classList.add('stop');
      this.idleCard.hidden = true;
      this.modeChip.hidden = !demo;
      this.ctx.log.add(demo ? 'Demo mode started' : 'Drive started');
      this.renderStatus(demo ? 'Replaying a recorded drive through the real pipeline.' : 'Looking for potholes, cracks and flooded roads…');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.log.add(`Could not start: ${message}`, 'error');
      this.renderStatus(message, true);
      if (!demo) this.warning.hidden = true;
      this.idleCard.hidden = false;
    } finally {
      this.starting = false;
      this.startButton.disabled = false;
    }
  }

  private async stop(): Promise<void> {
    const rig = this.ctx.rig;
    this.ctx.rig = null;
    rig?.stop();
    this.lastResult = null;
    this.startButton.textContent = 'Start';
    this.startButton.classList.remove('stop');
    this.idleCard.hidden = false;
    this.modeChip.hidden = true;
    this.warning.hidden = true;
    if (rig) this.ctx.log.add('Stopped');
    this.renderStatus('Stopped. Tap Start to drive again.');
    this.refreshIdleCard();
  }

  private async buildLiveRig(): Promise<Rig> {
    // iOS only shows the motion permission prompt if this runs inside the tap handler, before any other await.
    const motion = new MotionSensor();
    const permission = await motion.requestPermission();
    if (permission === 'denied') this.ctx.log.add('Motion access denied: detections will not be corroborated by jolts', 'warn');

    this.renderStatus('Loading the detector…');
    if (!this.ctx.detectorSelection) this.ctx.detectorSelection = await createDetector(this.ctx.config);
    const selection = this.ctx.detectorSelection;
    this.showDetectorWarning();

    const geo = new GeoTracker();
    geo.start();
    motion.start();

    this.renderStatus('Starting the camera…');
    this.camera ??= new Camera({ fps: this.ctx.config.sampleFps });
    this.camera.setFps(this.ctx.config.sampleFps);
    try {
      await this.camera.start();
    } catch (err) {
      geo.stop();
      motion.stop();
      throw err;
    }
    return this.assemble('live', this.camera, selection.detector, motion, geo, null);
  }

  private async buildDemoRig(): Promise<Rig> {
    const demo = new DemoSession();
    this.warning.hidden = true;
    const rig = this.assemble('demo', demo.camera, demo.detector, demo.motion, demo.geo, demo);
    await demo.start();
    return rig;
  }

  private assemble(mode: Rig['mode'], camera: FrameProvider, detector: Rig['detector'], motion: Rig['motion'], geo: Rig['geo'], demo: DemoSession | null): Rig {
    const confirmer = new Confirmer();
    const pipeline = new Pipeline({ camera, detector, confirmer, motion, geo, store: this.ctx.store, deviceId: this.ctx.deviceId });
    const unsubscribe = [
      pipeline.onResult((r) => (this.lastResult = { ...r, at: performance.now() })),
      pipeline.onEvent((e) => this.ctx.pipelineEvents.emit(e)),
      geo.onFix((f) => this.ctx.position.emit(f)),
    ];
    pipeline.start();
    return {
      mode,
      camera,
      detector,
      motion,
      geo,
      confirmer,
      pipeline,
      demo,
      stop: () => {
        pipeline.stop();
        for (const u of unsubscribe) u();
        if (demo) demo.stop();
        else {
          camera.stop();
          motion.stop();
          geo.stop();
        }
      },
    };
  }

  // -----------------------------------------------------------------------------------------------
  // status + HUD
  // -----------------------------------------------------------------------------------------------

  private renderStatus(text: string, isError = false): void {
    setText(this.statusLine, text);
    this.statusLine.classList.toggle('error', isError);
  }

  private showDetectorWarning(): void {
    const sel = this.ctx.detectorSelection;
    if (!sel) return;
    const kind = sel.detector.info().kind;
    if (kind === 'mock') {
      this.warning.hidden = false;
      setText(
        this.warning,
        sel.fellBackBecause
          ? `MOCK DETECTOR: the boxes are random, not real inference. The real model was not used (${sel.fellBackBecause}).`
          : 'MOCK DETECTOR: the boxes are random, not real inference.',
      );
    }
  }

  private updateHud(): void {
    const rig = this.ctx.rig;
    const info = rig?.detector.info() ?? this.ctx.detectorSelection?.detector.info();
    if (info) {
      const label = info.kind === 'mock' ? 'MOCK' : info.kind === 'replay' ? 'DEMO' : `ONNX ${info.backend}`;
      setText(this.detectorChip, `Detector: ${label}`);
      this.detectorChip.className = `chip ${info.kind === 'mock' ? 'bad' : info.kind === 'replay' ? 'warn' : 'ok'}`;
    }

    if (rig) {
      const s = rig.pipeline.stats;
      this.fpsChip.hidden = false;
      setText(this.fpsChip, `${s.processedFps.toFixed(1)} fps · ${s.inferenceMsAvg.toFixed(0)} ms`);
      const gs = rig.geo.status();
      if (gs.fix) {
        setText(this.gpsChip, `GPS ±${Math.round(gs.fix.accuracy)} m`);
        this.gpsChip.className = `chip ${gs.fix.accuracy <= 20 ? 'ok' : gs.fix.accuracy <= 50 ? 'warn' : 'bad'}`;
      } else {
        setText(this.gpsChip, gs.error ? 'GPS: problem' : 'GPS: waiting…');
        this.gpsChip.className = 'chip warn';
      }
      if (rig.camera.state === 'error' && rig.camera.error) this.renderStatus(rig.camera.error, true);
    } else {
      this.fpsChip.hidden = true;
      setText(this.gpsChip, 'GPS: off');
      this.gpsChip.className = 'chip';
    }
  }

  private onPipelineEvent(e: PipelineEvent): void {
    const label = CLASS_STYLE[e.confirmation.cls].label;
    const pct = Math.round(e.confirmation.confidence * 100);
    let text: string;
    if (e.type === 'confirmed') {
      text = `${label} ${pct}%${e.confirmation.boosted ? ' · jolt confirmed' : ''}`;
      this.flashUntil = performance.now() + 700;
      this.flashColor = CLASS_STYLE[e.confirmation.cls].color;
      navigator.vibrate?.(60);
    } else if (e.type === 'boosted') {
      text = `${label} corroborated by a jolt → ${pct}%`;
    } else {
      text = `${label} seen but not recorded: ${e.reason}`;
    }
    this.ctx.log.add(text, e.type === 'no-fix' ? 'warn' : 'info');
    setText(this.toast, text);
    this.toast.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 2500);
  }

  /** What would stop the live camera from working, before the user finds out the hard way. */
  private refreshIdleCard(): void {
    const demo = this.demoToggle.checked;
    const checks: [string, boolean, string][] = [
      ['Secure page (https)', window.isSecureContext, 'Camera, sensors and offline mode need an https:// address. Open the hub URL and trust its certificate.'],
      ['Camera API', Boolean(navigator.mediaDevices?.getUserMedia), 'This browser cannot access a camera.'],
      ['Location', 'geolocation' in navigator, 'This browser has no location API.'],
      ['Motion sensors', typeof DeviceMotionEvent !== 'undefined', 'No motion sensors; jolts will not corroborate detections.'],
      ['Offline mode (service worker)', 'serviceWorker' in navigator, 'Needs a trusted https:// page.'],
    ];
    const content: (Node | string)[] = [
      h('h2', null, demo ? 'Demo mode is on' : 'Ready to drive'),
      h(
        'p',
        null,
        demo
          ? 'Tap Start to replay a recorded drive along a test route near Antipolo. No camera, model or GPS needed; it runs through the same confirmation, storage, sync and map code.'
          : 'Mount the phone with the rear camera facing the road, then tap Start. Detection runs on this phone; camera frames never leave it.',
      ),
    ];
    if (!demo) {
      content.push(
        h(
          'ul',
          { class: 'checks' },
          ...checks.map(([label, ok, hint]) => h('li', { class: ok ? 'ok' : 'bad' }, `${ok ? '✓' : '✗'} ${label}`, ok ? null : h('div', { class: 'hint' }, hint))),
        ),
      );
    }
    content.push(h('p', { class: 'muted' }, 'Set the phone in its mount before you ride. Do not operate it while moving.'));
    this.idleCard.replaceChildren(...content);
  }

  // -----------------------------------------------------------------------------------------------
  // drawing
  // -----------------------------------------------------------------------------------------------

  private fitCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const hgt = Math.round(this.canvas.clientHeight * dpr);
    if (w > 0 && hgt > 0 && (this.canvas.width !== w || this.canvas.height !== hgt)) {
      this.canvas.width = w;
      this.canvas.height = hgt;
    }
  }

  private readonly paint = (): void => {
    this.raf = requestAnimationFrame(this.paint);
    if (this.el.closest('[hidden]')) return;
    this.fitCanvas();
    const g = this.draw2d;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#05070a';
    g.fillRect(0, 0, W, H);

    const rig = this.ctx.rig;
    const src = rig?.camera.previewSource;
    if (!rig || !src) return;
    const [sw, sh] = sourceSize(src);
    if (!sw || !sh) return;

    const scale = Math.min(W / sw, H / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    g.drawImage(src, dx, dy, dw, dh);

    const result = this.lastResult;
    if (result && performance.now() - result.at < 500) {
      const thresholds = rig.confirmer.config.thresholds;
      for (const d of result.detections) this.drawBox(g, d, dx, dy, dw, dh, d.confidence >= thresholds[d.cls]);
    }

    const left = this.flashUntil - performance.now();
    if (left > 0) {
      g.strokeStyle = this.flashColor;
      g.globalAlpha = Math.min(1, left / 400);
      g.lineWidth = Math.max(6, W * 0.012);
      g.strokeRect(dx, dy, dw, dh);
      g.globalAlpha = 1;
    }
  };

  private drawBox(g: CanvasRenderingContext2D, d: Detection, dx: number, dy: number, dw: number, dh: number, qualifies: boolean): void {
    const style = CLASS_STYLE[d.cls];
    const x = dx + d.box.x1 * dw;
    const y = dy + d.box.y1 * dh;
    const w = (d.box.x2 - d.box.x1) * dw;
    const hgt = (d.box.y2 - d.box.y1) * dh;
    g.save();
    g.lineWidth = qualifies ? 3 : 1.5;
    g.strokeStyle = style.color;
    g.globalAlpha = qualifies ? 1 : 0.55; // dim = seen, but below the confirmation threshold
    if (!qualifies) g.setLineDash([6, 5]);
    g.strokeRect(x, y, w, hgt);
    if (qualifies) {
      const text = `${style.label} ${Math.round(d.confidence * 100)}%`;
      g.font = `600 ${Math.max(12, Math.round(dh * 0.032))}px system-ui, sans-serif`;
      const tw = g.measureText(text).width + 10;
      const th = Math.max(18, Math.round(dh * 0.045));
      g.fillStyle = style.color;
      g.fillRect(x, Math.max(dy, y - th), tw, th);
      g.fillStyle = style.ink;
      g.textBaseline = 'middle';
      g.fillText(text, x + 5, Math.max(dy, y - th) + th / 2);
    }
    g.restore();
  }
}
