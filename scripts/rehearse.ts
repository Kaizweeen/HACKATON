/**
 * `npm run rehearse`: the stage demo, end to end, in a real browser: two emulated phones, the real hub, the real model.
 *
 *   npm run build                                          # the hub serves app/dist
 *   python model/tools/make_camera_video.py                # optional: road photos as the phones' camera (else a test pattern)
 *   npm run rehearse [-- --seconds 90 --headed --video <file.y4m | none> --pin <code | none>]
 *
 * Needs Playwright's Chromium (`npx playwright install chromium`). Writes .rehearsal/report.md plus screenshots and exits non-zero
 * if a check fails. What it checks, in the order of the README's "At the venue" list:
 *   1. both phones open the hub over HTTPS with a TRUSTED certificate (the browser pins the hub's key, like a phone that installed
 *      the CA) and the service worker caches the app, the model and the map ("Offline ready: yes, cached")
 *   2. the detector is the real ONNX model, not the MOCK fallback
 *   3. a drive along the demo loop: the camera is a video file (fake camera), GPS moves at 25 km/h; confirmations are counted
 *   4. the hub is stopped mid-drive and started again: phones keep confirming, queue, reconnect and catch up
 *   5. afterwards both phones and the hub hold the same hazards, nothing waits to sync
 *   6. phone A goes offline (airplane mode) and reloads: the app, its hazards and the map tiles all come from the phone itself
 *
 * What it cannot check: a physical camera, real GPS, motion sensors (no jolts here), WebGPU on a phone GPU, iOS Safari, the hotspot,
 * the mount and sunlight. Those stay on the human checklist.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import { demoRoute, pointAlongPath, WS_CLOSE_PIN_REQUIRED, type Hazard } from '@lubak/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { values: opts } = parseArgs({
  options: {
    seconds: { type: 'string', default: '90' },
    port: { type: 'string', default: '8543' },
    video: { type: 'string' },
    out: { type: 'string', default: path.join(root, '.rehearsal') },
    headed: { type: 'boolean', default: false },
    pin: { type: 'string', default: 'rehearse-4821' },
  },
});
const DRIVE_S = Number(opts.seconds);
const PORT = Number(opts.port);
const OUT = path.resolve(opts.out!);
const SPEED_MPS = 7;
/** The hub binds 127.0.0.1 and its certificate covers it; "localhost" can resolve to ::1 first on CI runners. */
const HOST = '127.0.0.1';
const certDir = path.join(root, 'hub', '.certs');
const defaultVideo = path.join(root, 'model', 'work', 'camera', 'road.y4m');
const video = opts.video === 'none' ? null : opts.video ? path.resolve(opts.video) : fs.existsSync(defaultVideo) ? defaultVideo : null;
const hasModel = fs.existsSync(path.join(root, 'app', 'dist', 'models', 'lubak.onnx'));
const PIN = opts.pin === 'none' ? '' : opts.pin!; // the hub runs with an event PIN, as it should on a shared network

interface Check {
  name: string;
  ok: boolean | null; // null = not applicable / skipped
  detail: string;
}
const checks: Check[] = [];
const log: string[] = [];
const say = (line: string): void => {
  const stamped = `${new Date().toISOString().slice(11, 19)}  ${line}`;
  log.push(stamped);
  console.log(stamped);
};
const check = (name: string, ok: boolean | null, detail: string): void => {
  checks.push({ name, ok, detail });
  say(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------- hub

let hub: ChildProcess | null = null;

function startHub(fresh: boolean): ChildProcess {
  const tsxCli = require.resolve('tsx/cli');
  const args = [tsxCli, 'hub/src/index.ts', '--port', String(PORT), '--http-port', 'off', '--no-mkcert', '--host', HOST,
    '--data', path.join(OUT, 'hub-data'), '--quiet', ...(fresh ? ['--fresh'] : []), ...(PIN ? ['--pin', PIN] : [])];
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const out = fs.createWriteStream(path.join(OUT, 'hub.log'), { flags: 'a' });
  child.stdout!.pipe(out);
  child.stderr!.pipe(out);
  return child;
}

function stopHub(): Promise<void> {
  const child = hub;
  hub = null;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    try {
      process.kill(-child.pid!, 'SIGTERM'); // the whole group: tsx and the node process it runs
    } catch {
      resolve();
    }
  });
}

function hubGet<T>(urlPath: string): Promise<T> {
  const ca = fs.readFileSync(path.join(certDir, 'lubak-hub-ca.crt'));
  return new Promise((resolve, reject) => {
    const withPin = PIN ? `${urlPath}${urlPath.includes('?') ? '&' : '?'}pin=${PIN}` : urlPath;
    const req = https.get({ host: HOST, port: PORT, path: withPin, ca, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function waitForHub(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await hubGet('/healthz');
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`the hub did not answer on https://${HOST}:${PORT} within ${timeoutMs / 1000} s (see ${path.join(OUT, 'hub.log')})`);
}

/** Connect like a phone that never got the PIN; resolve with the close code the hub sends. */
function strangerCloseCode(): Promise<number> {
  const ca = fs.readFileSync(path.join(certDir, 'lubak-hub-ca.crt'));
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://${HOST}:${PORT}/ws`, { ca });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(-1);
    }, 5000);
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on('error', () => undefined);
  });
}

/** base64 SHA-256 of the hub certificate's public key, for Chromium's --ignore-certificate-errors-spki-list. */
function hubSpki(): string {
  const cert = new crypto.X509Certificate(fs.readFileSync(path.join(certDir, 'cert.pem')));
  return crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

// ------------------------------------------------------------------------------------------------- phones

type Page = import('playwright').Page;
type BrowserContext = import('playwright').BrowserContext;

async function tab(page: Page, name: 'Drive' | 'Map' | 'Debug'): Promise<void> {
  await page.locator('nav').getByText(name, { exact: true }).click();
  await page.waitForTimeout(name === 'Debug' ? 1300 : 600); // the Debug screen refreshes once a second
}

async function debugRows(page: Page): Promise<Record<string, string>> {
  await tab(page, 'Debug');
  return page.evaluate(() => {
    const rows: Record<string, string> = {};
    for (const dt of Array.from(document.querySelectorAll('dl.kv dt'))) {
      const key = dt.textContent ?? '';
      if (!(key in rows)) rows[key] = dt.nextElementSibling?.textContent ?? '';
    }
    return rows;
  });
}

async function waitForRow(page: Page, label: string, pattern: RegExp, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = (await debugRows(page))[label] ?? '';
    if (pattern.test(last)) return last;
    await page.waitForTimeout(1000);
  }
  return last;
}

const num = (text: string | undefined): number => Number(/-?\d+(\.\d+)?/.exec(text ?? '')?.[0] ?? NaN);

// ------------------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(root, 'app', 'dist', 'index.html'))) throw new Error('app/dist is missing: run `npm run build` first');

  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Playwright is not installed: `npm install`, then `npx playwright install chromium`');
  }

  say(`starting the hub on https://${HOST}:${PORT} (fresh store, data in ${path.relative(root, OUT)}/hub-data)`);
  hub = startHub(true);
  await waitForHub();
  const spki = hubSpki();

  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--ignore-certificate-errors-spki-list=${spki}`];
  if (video) args.push(`--use-file-for-fake-video-capture=${video}`);
  say(`camera: ${video ? path.relative(root, video) : "Chromium's built-in test pattern (no road video: run model/tools/make_camera_video.py)"}`);
  const browser = await playwright.chromium.launch({ headless: !opts.headed, args });
  const route = demoRoute();
  const start = route[0]!;
  const phone = async (name: string): Promise<{ name: string; context: BrowserContext; page: Page; errors: string[] }> => {
    const context = await browser.newContext({
      ...playwright.devices['Pixel 7'],
      permissions: ['camera', 'geolocation'],
      geolocation: { latitude: start.lat, longitude: start.lon, accuracy: 5 },
      timezoneId: 'Asia/Manila',
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { name, context, page, errors };
  };
  const A = await phone('A');
  const B = await phone('B');
  const query = new URLSearchParams({ ...(hasModel ? { detector: 'onnx' } : {}), ...(PIN ? { pin: PIN } : {}) }).toString();
  const url = `https://${HOST}:${PORT}/${query ? `?${query}` : ''}`;
  // Without a road video nothing real can be detected; phone B then drives in Demo Mode (scripted detections through the real
  // confirmer, store and sync) so there are hazards to sync, while phone A still runs the real model on the camera.
  const demoB = !video;
  if (demoB) say('phone B runs Demo Mode (no road video), phone A the real camera pipeline');
  // One phone drives FOLLOW_S behind the other along the same street, so it reaches the leader's hazards after they were
  // reported: it must be warned about them ("Pothole ahead"). With a road video B follows A; without one, B (Demo Mode) leads.
  const FOLLOW_S = 15;
  const follower = demoB ? A : B;

  // 1. trusted HTTPS + service worker
  for (const p of [A, B]) {
    const t0 = Date.now();
    await p.page.goto(p === B && demoB ? `https://${HOST}:${PORT}/?demo=1${PIN ? `&pin=${PIN}` : ''}` : url);
    const ready = await waitForRow(p.page, 'Offline ready', /yes, cached|service worker active/, 120_000);
    const secure = await p.page.evaluate(() => window.isSecureContext && location.protocol === 'https:');
    check(`phone ${p.name}: HTTPS without a certificate warning, offline cache ready`, secure && /yes|active/.test(ready),
      `secure context ${secure}, "Offline ready: ${ready}" after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  if (PIN) {
    const code = await strangerCloseCode();
    check('a phone without the event PIN is refused', code === WS_CLOSE_PIN_REQUIRED, `WebSocket without ?pin= closed with code ${code} (expected ${WS_CLOSE_PIN_REQUIRED})`);
    const shown = await A.page.evaluate(() => location.search);
    check('the PIN is remembered and taken out of the address bar', !shown.includes('pin='), `address bar query after load: "${shown}"`);
  }

  // 2. start driving; the detector must be the real model
  for (const p of [A, B]) {
    await tab(p.page, 'Drive');
    await p.page.getByRole('button', { name: 'Start', exact: true }).click();
  }
  const detector = await waitForRow(A.page, 'In use', /onnx|mock/, 90_000);
  const isolation = await A.page.evaluate(() => ({ isolated: crossOriginIsolated, threads: navigator.hardwareConcurrency }));
  say(`cross-origin isolated: ${isolation.isolated} (WASM can use threads), ${isolation.threads} logical CPUs`);
  await tab(A.page, 'Drive');
  if (hasModel) check('real detector (not MOCK)', /^onnx \/ (webgpu|wasm)/.test(detector), `In use: ${detector}`);
  else check('real detector (not MOCK)', false, `app/dist/models/lubak.onnx is missing, so the app uses ${detector}`);

  // 3-4. the drive, with a hub outage in the middle
  const outageFrom = Math.round(DRIVE_S / 3);
  const outageTo = outageFrom + 15;
  let hubBeforeOutage = 0;
  let outageStartedAt = 0;
  let outageEndedAt = 0;
  say(`driving for ${DRIVE_S} s at ${SPEED_MPS * 3.6} km/h; the hub goes down from ${outageFrom} s to ${outageTo} s`);
  const driveStart = Date.now();
  for (let s = 0; s <= DRIVE_S; s++) {
    for (const [p, lag] of [[A, follower === A ? FOLLOW_S : 0], [B, follower === B ? FOLLOW_S : 0]] as const) {
      const at = pointAlongPath(route, SPEED_MPS * Math.max(0, s - lag), true);
      await p.context.setGeolocation({ latitude: at.lat, longitude: at.lon, accuracy: 5 });
    }
    if (s === 8) await A.page.screenshot({ path: path.join(OUT, '1-phone-A-driving.png') });
    if (s === outageFrom) {
      hubBeforeOutage = (await hubGet<Hazard[]>('/api/hazards')).length;
      outageStartedAt = Date.now();
      await stopHub();
      say(`hub stopped (it held ${hubBeforeOutage} hazards)`);
    }
    if (s === outageFrom + 10) {
      const rows = await debugRows(B.page);
      check('during the outage the phone knows the hub is gone', !/^connected$/.test(rows['State'] ?? ''), `phone B sync state: ${rows['State']}, waiting to sync: ${rows['Waiting to sync']}`);
      await tab(B.page, 'Drive');
    }
    if (s === outageTo) {
      hub = startHub(false);
      await waitForHub();
      outageEndedAt = Date.now();
      say('hub started again (same certificate, saved snapshot)');
    }
    const next = driveStart + (s + 1) * 1000;
    await sleep(Math.max(0, next - Date.now()));
  }
  // the pipeline's counters belong to the running drive: read them before Stop clears them
  const liveA = await debugRows(A.page);
  const liveB = await debugRows(B.page);
  for (const [p, rows] of [[A, liveA], [B, liveB]] as const) {
    say(`phone ${p.name}: ${rows['In use']} · inference ${rows['Inference time']} · ${rows['Frames']} · detections ${rows['Detections seen']} · confirmed ${rows['Confirmed']} · not recorded ${rows['Seen but not recorded']}`);
    await tab(p.page, 'Drive');
    await p.page.getByRole('button', { name: 'Stop', exact: true }).click();
  }
  await sleep(8000); // let the last confirmations reach the hub and come back

  // 5. everyone agrees
  const hubHazards = await hubGet<Hazard[]>('/api/hazards');
  const rowsA = await debugRows(A.page);
  const rowsB = await debugRows(B.page);
  for (const [p, rows] of [[A, rowsA], [B, rowsB]] as const) {
    say(`phone ${p.name} after the drive: ${rows['Hazards on this phone']} hazards on the phone · waiting to sync ${rows['Waiting to sync']} · sync ${rows['State']}`);
  }
  const confirmedA = num(liveA['Confirmed']);
  const confirmedB = num(liveB['Confirmed']);
  if (video) check('the drive produced confirmations from the camera', confirmedA > 0 && confirmedB > 0, `phone A confirmed ${confirmedA}, phone B ${confirmedB}`);
  else check('the drive produced confirmations from the camera', null, 'no road video, so nothing to detect');
  const onA = num(rowsA['Hazards on this phone']);
  const onB = num(rowsB['Hazards on this phone']);
  check('both phones and the hub hold the same hazards', onA === hubHazards.length && onB === hubHazards.length && hubHazards.length > 0,
    `hub ${hubHazards.length}, phone A ${onA}, phone B ${onB}`);
  check('nothing left waiting to sync, both reconnected', rowsA['Waiting to sync'] === '0' && rowsB['Waiting to sync'] === '0' && rowsA['State'] === 'connected' && rowsB['State'] === 'connected',
    `waiting A ${rowsA['Waiting to sync']}, B ${rowsB['Waiting to sync']}; state A ${rowsA['State']}, B ${rowsB['State']}`);
  const shared = hubHazards.filter((h) => h.deviceIds.length >= 2).length;
  say(`hazards confirmed by both phones: ${shared} of ${hubHazards.length} (they drive ${FOLLOW_S} s apart and film the same video at the same time, so few coincide)`);
  const followerRows = follower === A ? liveA : liveB;
  const warned = num(followerRows['Hazard warnings']);
  const leaderFound = follower === A ? num(liveB['Confirmed']) : confirmedA;
  check(`phone ${follower.name}, ${FOLLOW_S} s behind, was warned about hazards ahead`, leaderFound > 0 ? warned > 0 : null,
    leaderFound > 0 ? `Hazard warnings: ${followerRows['Hazard warnings']}` : 'the leading phone confirmed nothing, so there was nothing to warn about');
  const duringOutage = hubHazards.filter((h) => h.firstSeen >= outageStartedAt && h.firstSeen <= outageEndedAt).length;
  check('hazards confirmed while the hub was down reached it afterwards', duringOutage > 0 ? true : null,
    duringOutage > 0
      ? `${duringOutage} hazard(s) first seen during the ${((outageEndedAt - outageStartedAt) / 1000).toFixed(0)} s outage are on the hub (it held ${hubBeforeOutage} before, ${hubHazards.length} after)`
      : 'nothing was confirmed during the outage, so there was nothing to catch up');
  await tab(A.page, 'Map');
  await A.page.screenshot({ path: path.join(OUT, '2-phone-A-map.png') });
  await tab(B.page, 'Map');
  await B.page.screenshot({ path: path.join(OUT, '3-phone-B-map.png') });

  // 6. airplane mode
  const tileFailures: string[] = [];
  let tilesFromCache = 0;
  A.page.on('requestfailed', (r) => r.url().includes('/tiles/') && tileFailures.push(r.url()));
  A.page.on('response', (r) => r.url().includes('/tiles/') && r.fromServiceWorker() && (tilesFromCache += 1));
  await A.context.setOffline(true);
  await A.page.reload();
  await A.page.waitForTimeout(2500);
  await tab(A.page, 'Map');
  await A.page.waitForTimeout(2500);
  await A.page.screenshot({ path: path.join(OUT, '4-phone-A-offline-map.png') });
  const offlineRows = await debugRows(A.page);
  check('offline reload: app, hazards and map tiles come from the phone', num(offlineRows['Hazards on this phone']) === onA && tilesFromCache > 0 && tileFailures.length === 0,
    `${offlineRows['Hazards on this phone']} hazards, ${tilesFromCache} tiles from the service worker, ${tileFailures.length} failed, network: ${offlineRows['Network link']}`);

  for (const p of [A, B]) check(`phone ${p.name}: no uncaught page errors`, p.errors.length === 0, p.errors.slice(0, 3).join(' | ') || 'none');
  await browser.close();
}

function writeReport(error?: unknown): number {
  const failed = checks.filter((c) => c.ok === false).length + (error ? 1 : 0);
  const lines = [
    '# Rehearsal report',
    '',
    `${new Date().toISOString()} · ${failed ? `**${failed} problem(s)**` : '**all checks passed**'} · drive ${DRIVE_S} s · camera: ${video ? path.relative(root, video) : 'test pattern'} · model: ${hasModel ? 'app/dist/models/lubak.onnx' : 'missing'}`,
    '',
    'Two emulated phones (Chromium, Pixel 7 profile) against the real hub. Not covered: physical camera, real GPS, motion sensors,',
    'WebGPU on a phone GPU, iOS Safari, the hotspot, the mount. Those stay on the human checklist in the README.',
    '',
    '| | check | detail |',
    '| --- | --- | --- |',
    ...checks.map((c) => `| ${c.ok === null ? 'skip' : c.ok ? 'pass' : '**FAIL**'} | ${c.name} | ${c.detail.replace(/\|/g, '\\|')} |`),
    ...(error ? ['', `**Aborted:** ${String(error instanceof Error ? error.message : error)}`] : []),
    '',
    '![phone A driving](1-phone-A-driving.png) ![phone A map](2-phone-A-map.png) ![phone B map](3-phone-B-map.png) ![phone A offline](4-phone-A-offline-map.png)',
    '',
    '## Log',
    '',
    '```text',
    ...log,
    '```',
    '',
  ];
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'));
  console.log(`\nreport: ${path.join(OUT, 'report.md')}`);
  return failed;
}

main()
  .then(async () => {
    await stopHub();
    process.exit(writeReport() ? 1 : 0);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await stopHub();
    writeReport(error);
    process.exit(1);
  });
