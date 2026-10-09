/**
 * Composition root: opens the store, starts sync, builds the three screens, registers the service worker.
 * Nothing here depends on the network being up: the app shell, model and tiles come from the service worker's cache.
 */

import './style.css';
import { registerSW } from 'virtual:pwa-register';
import * as shared from '@lubak/shared';
import * as detector from './detector.js';
import { getOrCreateDeviceId, loadConfig, saveSettings } from './config.js';
import { HazardStore } from './store.js';
import { SyncClient } from './sync.js';
import { LogBuffer, type AppContext, type ServiceWorkerState } from './ui/context.js';
import { Emitter } from './ui/dom.js';
import { Shell } from './ui/shell.js';
import type { GeoFix } from './sensors.js';
import type { PipelineEvent } from './pipeline.js';

declare global {
  interface Window {
    /** Debug handle for the browser console and end-to-end tests. */
    __lubak?: { ctx: AppContext; shell: Shell; store: HazardStore; sync: SyncClient; shared: typeof shared; detector: typeof detector };
  }
}

function registerServiceWorker(ctx: AppContext): void {
  const { sw, log } = ctx;
  if (!sw.supported) {
    log.add('This browser has no service worker support: the app will not be available offline', 'warn');
    return;
  }
  if (import.meta.env.DEV) {
    log.add('Dev server: service worker disabled (build + run the hub to test offline mode)');
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    sw.controlled = true;
  });

  let reloadWhenIdle = false;
  registerSW({
    immediate: true,
    onRegisteredSW: (_url, registration) => {
      sw.registered = Boolean(registration);
      log.add('Service worker registered');
    },
    onOfflineReady: () => {
      sw.offlineReady = true;
      log.add('Everything is cached: the app now works with no connection');
    },
    // A new build was installed. Never reload while someone is driving: wait until the pipeline stops.
    onNeedReload: () => {
      sw.updateReady = true;
      if (ctx.rig) {
        log.add('A new version is ready; it will load as soon as you stop');
        reloadWhenIdle = true;
      } else {
        location.reload();
      }
    },
    onRegisterError: (error: unknown) => {
      sw.error = error instanceof Error ? error.message : String(error);
      log.add(
        `Service worker could not register: ${sw.error}. On a phone this usually means the hub certificate is not trusted yet (see the README).`,
        'error',
      );
    },
  });
  setInterval(() => {
    if (reloadWhenIdle && !ctx.rig) location.reload();
  }, 5000);
}

/**
 * A hub with an event PIN prints its address as https://<hub>/?pin=...: keep the PIN for the next launches (the Home Screen
 * icon opens the app without it) and take it out of the address bar, so it does not end up in screenshots or shared links.
 */
function rememberPinFromLink(pin: string | null): void {
  const url = new URL(location.href);
  if (!url.searchParams.has(shared.HUB_PIN_PARAM)) return;
  if (pin) saveSettings({ hubPin: pin });
  url.searchParams.delete(shared.HUB_PIN_PARAM);
  history.replaceState(history.state, '', url.toString());
}

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app is missing from index.html');

  const config = loadConfig();
  rememberPinFromLink(config.hubPin);
  const deviceId = getOrCreateDeviceId();
  const log = new LogBuffer();

  const store = await HazardStore.open();
  if (store.backendKind === 'memory') log.add('IndexedDB is unavailable: hazards are kept in memory and lost on reload', 'warn');
  await store.sweep();
  setInterval(() => void store.sweep(), 60_000);

  const sync = new SyncClient({ url: config.hubUrl, pin: config.hubPin, deviceId, store, log: (m) => log.add(`sync: ${m}`) });

  const sw: ServiceWorkerState = {
    supported: 'serviceWorker' in navigator,
    registered: false,
    controlled: 'serviceWorker' in navigator && Boolean(navigator.serviceWorker.controller),
    offlineReady: false,
    updateReady: false,
    error: null,
  };

  const ctx: AppContext = {
    config,
    deviceId,
    store,
    sync,
    log,
    sw,
    detectorSelection: null,
    rig: null,
    position: new Emitter<GeoFix>(),
    pipelineEvents: new Emitter<PipelineEvent>(),
  };

  window.addEventListener('error', (e) => log.add(`Error: ${e.message}`, 'error'));
  window.addEventListener('unhandledrejection', (e) => log.add(`Unhandled: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`, 'error'));

  const shell = new Shell(root, ctx);
  sync.start();
  registerServiceWorker(ctx);
  window.__lubak = { ctx, shell, store, sync, shared, detector };
  log.add(`Lubak Alert started (device ${deviceId.slice(0, 8)}, hub ${config.hubUrl})`);
}

main().catch((err: unknown) => {
  console.error(err);
  const root = document.getElementById('app');
  if (root) root.textContent = `Lubak Alert could not start: ${err instanceof Error ? err.message : String(err)}`;
});
