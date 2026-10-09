import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CA_FILE_NAME, collectCertNames, ensureTls } from '../src/certs.js';
import { lanAddresses } from '../src/lan.js';
import { silentLogger } from '../src/log.js';
import { tempDir } from './harness.js';

const base = { preferMkcert: false, log: silentLogger } as const;
const x509 = (pem: string): X509Certificate => new X509Certificate(pem);

describe('ensureTls (selfsigned mode: local CA + leaf)', () => {
  it('issues a CA and a leaf that verifies against it, valid for the requested names', async () => {
    const dir = tempDir();
    const m = await ensureTls({ ...base, dir, names: ['localhost', '127.0.0.1', '192.168.43.2', 'laptop'] });

    expect(m.mode).toBe('selfsigned');
    expect(m.caIsNew).toBe(true);
    expect(m.leafIssued).toBe(true);

    const ca = x509(m.caCertPem);
    const leaf = x509(m.cert);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    for (const n of ['localhost', 'laptop']) expect(leaf.checkHost(n)).toBeDefined();
    for (const ip of ['127.0.0.1', '192.168.43.2']) expect(leaf.checkIP(ip)).toBeDefined();
    expect(leaf.checkIP('192.168.43.3')).toBeUndefined();
    expect(leaf.keyUsage).toContain('1.3.6.1.5.5.7.3.1'); // serverAuth

    const days = (c: X509Certificate): number => (new Date(c.validTo).getTime() - Date.now()) / 86_400_000;
    expect(days(leaf)).toBeGreaterThan(300);
    expect(days(leaf)).toBeLessThan(400); // iOS / Safari reject long-lived server certificates
    expect(days(ca)).toBeGreaterThan(3000);
  });

  it('writes the public CA for phones and keeps private keys unreadable by others', async () => {
    const dir = tempDir();
    const m = await ensureTls({ ...base, dir, names: ['localhost'] });
    expect(fs.readFileSync(path.join(dir, CA_FILE_NAME), 'utf8')).toBe(m.caCertPem);
    expect(m.caCertPem).not.toContain('PRIVATE KEY');
    expect(m.caFingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    if (process.platform !== 'win32') {
      for (const f of ['key.pem', 'ca.key.pem']) expect(fs.statSync(path.join(dir, f)).mode & 0o077).toBe(0);
    }
  });

  it('reuses everything on the next start', async () => {
    const dir = tempDir();
    const first = await ensureTls({ ...base, dir, names: ['localhost', '192.168.1.5'] });
    const second = await ensureTls({ ...base, dir, names: ['localhost', '192.168.1.5'] });
    expect(second.leafIssued).toBe(false);
    expect(second.caIsNew).toBe(false);
    expect(second.cert).toBe(first.cert);
    expect(second.caCertPem).toBe(first.caCertPem);
  });

  it('reissues only the leaf when a new IP appears: the CA, and so every phone, is untouched; old names are kept', async () => {
    const dir = tempDir();
    const first = await ensureTls({ ...base, dir, names: ['localhost', '192.168.1.5'] });
    const second = await ensureTls({ ...base, dir, names: ['localhost', '10.42.0.1'] });
    expect(second.leafIssued).toBe(true);
    expect(second.caIsNew).toBe(false);
    expect(second.caCertPem).toBe(first.caCertPem);
    expect(second.cert).not.toBe(first.cert);
    const leaf = x509(second.cert);
    expect(leaf.verify(x509(first.caCertPem).publicKey)).toBe(true);
    expect(leaf.checkIP('10.42.0.1')).toBeDefined();
    expect(leaf.checkIP('192.168.1.5')).toBeDefined(); // hopping back to the old network needs no new certificate
  });

  it('renews a leaf that is about to expire, still under the same CA', async () => {
    const dir = tempDir();
    const first = await ensureTls({ ...base, dir, names: ['localhost'] });
    const later = new Date(Date.now() + 340 * 86_400_000);
    const second = await ensureTls({ ...base, dir, names: ['localhost'], now: () => later });
    expect(second.leafIssued).toBe(true);
    expect(second.caCertPem).toBe(first.caCertPem);
  });

  it('recovers from a damaged leaf by issuing a new one', async () => {
    const dir = tempDir();
    await ensureTls({ ...base, dir, names: ['localhost'] });
    fs.writeFileSync(path.join(dir, 'cert.pem'), 'garbage');
    const again = await ensureTls({ ...base, dir, names: ['localhost'] });
    expect(again.leafIssued).toBe(true);
    expect(x509(again.cert).checkHost('localhost')).toBeDefined();
  });
});

describe('collectCertNames', () => {
  it('always includes loopback, plus a sane hostname and extras, without duplicates', () => {
    const names = collectCertNames(['lubak.local', '10.0.0.7', 'localhost'], 'my-laptop');
    expect(names).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1', 'my-laptop', 'lubak.local', '10.0.0.7']));
    expect(new Set(names).size).toBe(names.length);
  });

  it('drops hostnames that would make an invalid certificate', () => {
    const names = collectCertNames(['bad name!', 'x'.repeat(300)], 'weird host name');
    expect(names).not.toContain('weird host name');
    expect(names).not.toContain('bad name!');
    expect(names.some((n) => n.length > 253)).toBe(false);
  });
});

describe('lanAddresses', () => {
  it('lists private IPv4 first, flags hotspot gateways, ignores loopback / link-local / IPv6', () => {
    const fake = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
      wlan0: [
        { address: '192.168.137.1', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      eth1: [{ address: '169.254.7.7', family: 'IPv4', internal: false }],
      ppp0: [{ address: '8.8.4.4', family: 'IPv4', internal: false }],
    } as unknown as Parameters<typeof lanAddresses>[0];
    const out = lanAddresses(fake);
    expect(out.map((a) => a.address)).toEqual(['192.168.137.1', '172.17.0.1', '8.8.4.4']);
    expect(out[0]?.hint).toMatch(/hotspot/i);
  });
});
