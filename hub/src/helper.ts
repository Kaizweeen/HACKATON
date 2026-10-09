/**
 * Plain-HTTP "install the certificate" helper.
 *
 * A phone cannot open the HTTPS app cleanly until it trusts the hub's CA, and it cannot download the CA
 * over HTTPS without clicking through a warning. So this tiny extra port serves a mobile-friendly
 * instruction page and the PUBLIC CA certificate (never any private key), then redirects everything
 * else to the HTTPS app.
 */

import http from 'node:http';
import { CA_FILE_NAME, type TlsMode } from './certs.js';

export interface HelperOptions {
  caCertPem: string;
  caFingerprint256: string;
  mode: TlsMode;
  httpsPort: number;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** Hostname the phone used to reach us (so the https link points at the same IP), or a safe fallback. */
function requestHostname(hostHeader: string | undefined): string {
  const m = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::\d+)?$/.exec(hostHeader ?? '');
  return m?.[1] ?? 'localhost';
}

export function certInstallPage(appUrl: string, opts: Pick<HelperOptions, 'caFingerprint256' | 'mode'>): string {
  const caName = opts.mode === 'mkcert' ? 'the mkcert development CA' : 'Lubak Alert Hub Local CA';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lubak Alert: trust this hub</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:1.25rem;max-width:36rem;margin-inline:auto;color:#1a1a1a;background:#fff}
  h1{font-size:1.4rem;margin:0 0 .25rem} h2{font-size:1.05rem;margin:1.5rem 0 .25rem}
  a.btn{display:block;text-align:center;padding:.9rem 1rem;margin:1rem 0;border-radius:.6rem;background:#b3261e;color:#fff;text-decoration:none;font-weight:600}
  a.btn.alt{background:#1a1a1a} code{background:#f0f0f0;padding:.1rem .3rem;border-radius:.25rem;word-break:break-all}
  ol{padding-left:1.2rem} li{margin:.25rem 0} .note{color:#555;font-size:.9rem}
  @media (prefers-color-scheme:dark){body{background:#121212;color:#eee}code{background:#2a2a2a}.note{color:#aaa}}
</style></head><body>
<h1>Lubak Alert hub</h1>
<p>Phones must trust this hub once, otherwise the camera, motion sensors and the offline mode will not work.</p>
<a class="btn" href="/${CA_FILE_NAME}">1. Download certificate</a>

<h2>Android (Chrome)</h2>
<ol><li>Tap the button above; the file <code>${CA_FILE_NAME}</code> downloads.</li>
<li>Settings &rarr; Security (or Security &amp; privacy) &rarr; More security settings &rarr; Encryption &amp; credentials &rarr; <b>Install a certificate</b> &rarr; <b>CA certificate</b> &rarr; Install anyway &rarr; choose the file.</li>
<li>Menu names differ by phone brand; search Settings for &ldquo;certificate&rdquo;.</li></ol>

<h2>iPhone / iPad (use Safari)</h2>
<ol><li>Tap the button above and choose <b>Allow</b> to download the profile.</li>
<li>Settings &rarr; <b>Profile Downloaded</b> (or General &rarr; VPN &amp; Device Management) &rarr; Install.</li>
<li>Settings &rarr; General &rarr; About &rarr; <b>Certificate Trust Settings</b> &rarr; switch on full trust for <i>${escapeHtml(caName)}</i>.</li></ol>

<a class="btn alt" href="${escapeHtml(appUrl)}">2. Open the app</a>
<p class="note">Check you installed the right certificate. SHA-256 fingerprint:<br><code>${escapeHtml(opts.caFingerprint256)}</code></p>
<p class="note">Clicking through the browser warning instead may let the camera work, but browsers refuse to register the service worker on an untrusted certificate, so the app will not work offline.</p>
<p class="note">Remove the certificate from your phone after the event: whoever has this computer's CA key could impersonate sites to a phone that trusts it.</p>
</body></html>`;
}

export function createHelperServer(opts: HelperOptions): http.Server {
  return http.createServer((req, res) => {
    const hostname = requestHostname(req.headers.host);
    const appUrl = `https://${hostname}:${opts.httpsPort}/`;
    const pathname = new URL(req.url ?? '/', 'http://helper.local').pathname;

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(certInstallPage(appUrl, opts));
    } else if (pathname === `/${CA_FILE_NAME}` || pathname === '/lubak-hub-ca.pem') {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': `attachment; filename="${CA_FILE_NAME}"`,
        'Cache-Control': 'no-store',
      });
      res.end(opts.caCertPem);
    } else {
      res.writeHead(302, { Location: `https://${hostname}:${opts.httpsPort}${pathname}` });
      res.end();
    }
  });
}
