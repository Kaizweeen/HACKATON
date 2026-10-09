import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const here = path.dirname(fileURLToPath(import.meta.url));

// The dev server talks to the hub (npm run hub) for /ws, so a second terminal is all phones need.
const hubPort = process.env['HUB_PORT'] ?? '8443';
const hubScheme = process.env['HUB_TLS'] === '0' ? 'http' : 'https';
const hubTarget = `${hubScheme}://localhost:${hubPort}`;

/**
 * Reuse the hub's TLS leaf for the dev server: phones that already trust the hub's CA then trust
 * https://<lan-ip>:5173 too, which is what camera / motion / service-worker testing on a real phone needs.
 * No certificate yet (hub never started)? Fall back to plain HTTP: localhost is still a secure context.
 */
function devHttps(): { key: Buffer; cert: Buffer } | undefined {
  if (process.env['LUBAK_DEV_HTTPS'] === '0') return undefined;
  try {
    const dir = path.resolve(here, '../hub/.certs');
    return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
  } catch {
    return undefined;
  }
}

const proxied = { target: hubTarget, secure: false, changeOrigin: false } as const;

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    https: devHttps(),
    proxy: {
      '/ws': { ...proxied, ws: true },
      '/api': proxied,
      '/healthz': proxied,
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // main.ts registers explicitly so the Debug screen can report service worker state
      manifest: {
        name: 'Lubak Alert',
        short_name: 'Lubak',
        description: 'Offline-first pothole, crack and flood alerts. Detection runs on your phone.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0e1116',
        theme_color: '#0e1116',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache everything the app needs with no network at all: shell, scripts, the ONNX model, the onnxruntime
        // WASM runtime and every map tile that exists in public/tiles at build time.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,jpg,webp,ico,webmanifest,json,onnx,wasm}'],
        globIgnores: ['**/README.md'],
        maximumFileSizeToCacheInBytes: 96 * 1024 * 1024,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/ws/, /^\/api\//, /^\/healthz/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: { enabled: false }, // never run the service worker under the dev server: stale caches ruin live reload
    }),
  ],
});
