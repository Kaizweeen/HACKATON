import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CA_FILE_NAME } from '../src/certs.js';
import { certInstallPage, createHelperServer } from '../src/helper.js';

const CA_PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
const FP = 'AB:CD:EF';

let server: http.Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(): Promise<number> {
  server = createHelperServer({ caCertPem: CA_PEM, caFingerprint256: FP, mode: 'selfsigned', httpsPort: 8443 });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function request(port: number, pathname: string, host?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathname, headers: host ? { Host: host } : {} }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

describe('certificate helper (plain HTTP)', () => {
  it('serves the install instructions with a link that keeps the host the phone used', async () => {
    const port = await start();
    const page = await request(port, '/', '192.168.43.2:8080');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('href="https://192.168.43.2:8443/"');
    expect(page.body).toContain(FP);
    expect(page.body).toMatch(/Android/);
    expect(page.body).toMatch(/Certificate Trust Settings/);
  });

  it('serves the PUBLIC CA with the MIME type that makes Android and iOS offer to install it', async () => {
    const port = await start();
    for (const p of [`/${CA_FILE_NAME}`, '/lubak-hub-ca.pem']) {
      const res = await request(port, p);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/x-x509-ca-cert');
      expect(res.headers['content-disposition']).toContain(CA_FILE_NAME);
      expect(res.body).toBe(CA_PEM);
    }
  });

  it('redirects every other path to the HTTPS app and never serves key material', async () => {
    const port = await start();
    const res = await request(port, '/key.pem', '10.0.0.5:8080');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://10.0.0.5:8443/key.pem');
    expect(res.body).not.toContain('PRIVATE KEY');
  });

  it('does not reflect a hostile Host header into the page or the redirect', async () => {
    const port = await start();
    const page = await request(port, '/', 'evil.example/"><script>alert(1)</script>');
    expect(page.body).not.toContain('<script>alert');
    expect(page.body).toContain('href="https://localhost:8443/"');
    const redirect = await request(port, '/x', 'a b');
    expect(redirect.headers.location).toBe('https://localhost:8443/x');
  });

  it('page template escapes what it interpolates', () => {
    const html = certInstallPage('https://x/"><b>', { caFingerprint256: '<i>', mode: 'mkcert' });
    expect(html).not.toContain('"><b>');
    expect(html).toContain('&lt;i&gt;');
    expect(html).toContain('mkcert development CA');
  });
});
