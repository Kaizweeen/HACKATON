/**
 * TLS for the hub. Browsers only expose getUserMedia, service workers and motion sensors in a secure
 * context, so the hub must speak HTTPS even on a hotspot with no internet.
 *
 * Two ways to get a certificate, tried in this order:
 *   1. mkcert, when it is installed (`mkcert -CAROOT` holds the CA that phones must trust).
 *   2. the `selfsigned` package: we create a small local CA once, then sign a leaf for this computer's
 *      current names and IP addresses. Phones install the CA once; when the laptop's IP changes the leaf is
 *      reissued automatically and phones do NOT need to trust anything again. (A bare self-signed leaf would
 *      have forced a re-install on every IP change, and hotspot IPs do change.)
 *
 * Files in the cert directory (all git-ignored; the private keys never leave this machine):
 *   mode.txt  ca.key.pem  ca.cert.pem  key.pem  cert.pem  lubak-hub-ca.crt  <- the only file served to phones
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import { lanAddresses } from './lan.js';
import type { Logger } from './log.js';

const DAY_MS = 86_400_000;
const RENEW_WITHIN_MS = 30 * DAY_MS;
const MAX_NAMES = 24;

export const CA_FILE_NAME = 'lubak-hub-ca.crt';

export type TlsMode = 'mkcert' | 'selfsigned';

export interface TlsMaterial {
  mode: TlsMode;
  /** Leaf private key (PEM). Keep secret. */
  key: string;
  /** Leaf certificate (PEM). */
  cert: string;
  /** The PUBLIC certificate phones must install and trust (PEM). */
  caCertPem: string;
  caCertPath: string;
  caFingerprint256: string;
  /** DNS names and IPs the leaf is valid for. */
  names: string[];
  leafNotAfter: Date;
  /** The CA certificate is new or changed on this run: every phone needs to install it (again). */
  caIsNew: boolean;
  /** A new leaf was issued on this run. */
  leafIssued: boolean;
}

export interface EnsureTlsOptions {
  dir: string;
  names: string[];
  preferMkcert: boolean;
  log: Logger;
  now?: () => Date;
}

const read = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const parse = (pem: string | undefined): X509Certificate | undefined => {
  if (pem === undefined) return undefined;
  try {
    return new X509Certificate(pem);
  } catch {
    return undefined;
  }
};

const writePrivate = (file: string, data: string): void => fs.writeFileSync(file, data, { mode: 0o600 });

/** Names for the certificate: localhost, loopback, this computer's hostname and every LAN IPv4 address. */
export function collectCertNames(extra: readonly string[] = [], hostname: string = os.hostname()): string[] {
  const names = ['localhost', '127.0.0.1', '::1'];
  if (/^[A-Za-z0-9._-]{1,253}$/.test(hostname)) names.push(hostname);
  for (const a of lanAddresses()) names.push(a.address);
  for (const e of extra) if (net.isIP(e) !== 0 || /^[A-Za-z0-9._-]{1,253}$/.test(e)) names.push(e);
  return [...new Set(names)].slice(0, MAX_NAMES);
}

function covers(cert: X509Certificate, name: string): boolean {
  return net.isIP(name) !== 0 ? cert.checkIP(name) !== undefined : cert.checkHost(name) !== undefined;
}

/** DNS names and IPv4 addresses already present in a certificate's SAN, so reissuing never forgets an old network. */
function sanNames(cert: X509Certificate): string[] {
  const out: string[] = [];
  for (const part of (cert.subjectAltName ?? '').split(/,\s*/)) {
    if (part.startsWith('DNS:')) out.push(part.slice(4));
    else if (part.startsWith('IP Address:') && net.isIPv4(part.slice(11))) out.push(part.slice(11));
  }
  return out;
}

function altNames(names: readonly string[]): { type: 2 | 7; value?: string; ip?: string }[] {
  return names.map((n) => (net.isIP(n) !== 0 ? { type: 7 as const, ip: n } : { type: 2 as const, value: n }));
}

function detectMkcert(): boolean {
  try {
    execFileSync('mkcert', ['-version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function ensureTls(opts: EnsureTlsOptions): Promise<TlsMaterial> {
  const { dir, log } = opts;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const wantMkcert = opts.preferMkcert && detectMkcert();
  const previousCa = read(path.join(dir, CA_FILE_NAME));
  const previousMode = read(path.join(dir, 'mode.txt'))?.trim();

  if (wantMkcert) {
    try {
      return await ensureWithMkcert(opts, previousCa, previousMode);
    } catch (err) {
      log.warn(`mkcert failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); falling back to the selfsigned package`);
    }
  } else if (opts.preferMkcert) {
    log.info('mkcert not found, using the selfsigned package (install mkcert for a smoother laptop browser experience)');
  }
  return ensureWithSelfsigned(opts, previousCa, previousMode);
}

/** Reuse the existing leaf when it still covers every wanted name, is not about to expire and was made by the same mode. */
function reusableLeaf(dir: string, names: readonly string[], mode: TlsMode, previousMode: string | undefined, now: Date) {
  if (previousMode !== mode) return undefined;
  const cert = read(path.join(dir, 'cert.pem'));
  const key = read(path.join(dir, 'key.pem'));
  const x509 = parse(cert);
  if (cert === undefined || key === undefined || x509 === undefined) return undefined;
  if (new Date(x509.validTo).getTime() - now.getTime() < RENEW_WITHIN_MS) return undefined;
  if (!names.every((n) => covers(x509, n))) return undefined;
  return { cert, key, x509 };
}

async function ensureWithSelfsigned(opts: EnsureTlsOptions, previousCa: string | undefined, previousMode: string | undefined): Promise<TlsMaterial> {
  const { dir, log } = opts;
  const now = (opts.now ?? (() => new Date()))();
  const caKeyFile = path.join(dir, 'ca.key.pem');
  const caCertFile = path.join(dir, 'ca.cert.pem');

  // --- CA: made once, valid for 10 years, reused for every leaf
  let caKey = read(caKeyFile);
  let caCert = read(caCertFile);
  const existingCa = parse(caCert);
  const caUsable =
    previousMode === 'selfsigned' &&
    caKey !== undefined &&
    existingCa !== undefined &&
    new Date(existingCa.validTo).getTime() - now.getTime() > RENEW_WITHIN_MS;
  let caCreated = false;
  if (!caUsable) {
    const ca = await generate(
      [
        { name: 'commonName', value: 'Lubak Alert Hub Local CA' },
        { name: 'organizationName', value: 'Lubak Alert (local development CA)' },
      ],
      {
        keyType: 'rsa',
        keySize: 2048,
        algorithm: 'sha256', // selfsigned defaults to sha1, which browsers reject
        notBeforeDate: new Date(now.getTime() - 2 * DAY_MS),
        notAfterDate: new Date(now.getTime() + 3650 * DAY_MS),
        extensions: [
          { name: 'basicConstraints', cA: true, critical: true },
          { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
        ],
      },
    );
    caKey = ca.private;
    caCert = ca.cert;
    writePrivate(caKeyFile, caKey);
    fs.writeFileSync(caCertFile, caCert);
    caCreated = true;
    log.info('created a new local CA for the hub (phones need to install it once)');
  }
  if (caKey === undefined || caCert === undefined) throw new Error('CA unavailable');

  // --- leaf: reissued whenever this computer shows up on a name / IP the old one did not cover
  const reuse = caCreated ? undefined : reusableLeaf(dir, opts.names, 'selfsigned', previousMode, now);
  let leafCert: string;
  let leafKey: string;
  let leafX509: X509Certificate;
  let names: string[];
  let leafIssued = false;
  if (reuse) {
    ({ cert: leafCert, key: leafKey, x509: leafX509 } = reuse);
    names = [...new Set([...opts.names, ...sanNames(leafX509)])];
  } else {
    const previousLeaf = caCreated ? undefined : parse(read(path.join(dir, 'cert.pem')));
    names = [...new Set([...opts.names, ...(previousLeaf ? sanNames(previousLeaf) : [])])].slice(0, MAX_NAMES);
    const leaf = await generate([{ name: 'commonName', value: 'Lubak Alert Hub' }], {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: new Date(now.getTime() - 2 * DAY_MS),
      notAfterDate: new Date(now.getTime() + 365 * DAY_MS),
      ca: { key: caKey, cert: caCert },
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: altNames(names) },
      ],
    });
    leafCert = leaf.cert;
    leafKey = leaf.private;
    writePrivate(path.join(dir, 'key.pem'), leafKey);
    fs.writeFileSync(path.join(dir, 'cert.pem'), leafCert);
    fs.writeFileSync(path.join(dir, 'mode.txt'), 'selfsigned\n');
    leafX509 = new X509Certificate(leafCert);
    leafIssued = true;
    log.info(`issued a TLS certificate for ${names.join(', ')}`);
  }

  fs.writeFileSync(path.join(dir, CA_FILE_NAME), caCert);
  const caX509 = new X509Certificate(caCert);
  return {
    mode: 'selfsigned',
    key: leafKey,
    cert: leafCert,
    caCertPem: caCert,
    caCertPath: path.join(dir, CA_FILE_NAME),
    caFingerprint256: caX509.fingerprint256,
    names,
    leafNotAfter: new Date(leafX509.validTo),
    caIsNew: previousCa !== caCert,
    leafIssued,
  };
}

async function ensureWithMkcert(opts: EnsureTlsOptions, previousCa: string | undefined, previousMode: string | undefined): Promise<TlsMaterial> {
  const { dir, log } = opts;
  const now = (opts.now ?? (() => new Date()))();
  const sh = (args: string[]): string => execFileSync('mkcert', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const reuse = reusableLeaf(dir, opts.names, 'mkcert', previousMode, now);
  let cert: string;
  let key: string;
  let x509: X509Certificate;
  let names = opts.names;
  let leafIssued = false;
  if (reuse) {
    ({ cert, key, x509 } = reuse);
    names = [...new Set([...opts.names, ...sanNames(x509)])];
  } else {
    const previousLeaf = previousMode === 'mkcert' ? parse(read(path.join(dir, 'cert.pem'))) : undefined;
    names = [...new Set([...opts.names, ...(previousLeaf ? sanNames(previousLeaf) : [])])].slice(0, MAX_NAMES);
    sh(['-cert-file', path.join(dir, 'cert.pem'), '-key-file', path.join(dir, 'key.pem'), ...names]);
    fs.chmodSync(path.join(dir, 'key.pem'), 0o600);
    fs.writeFileSync(path.join(dir, 'mode.txt'), 'mkcert\n');
    cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
    x509 = new X509Certificate(cert);
    leafIssued = true;
    log.info(`mkcert issued a TLS certificate for ${names.join(', ')}`);
  }

  const caRoot = sh(['-CAROOT']).trim();
  const caCertPem = fs.readFileSync(path.join(caRoot, 'rootCA.pem'), 'utf8');
  fs.writeFileSync(path.join(dir, CA_FILE_NAME), caCertPem);
  return {
    mode: 'mkcert',
    key,
    cert,
    caCertPem,
    caCertPath: path.join(dir, CA_FILE_NAME),
    caFingerprint256: new X509Certificate(caCertPem).fingerprint256,
    names,
    leafNotAfter: new Date(x509.validTo),
    caIsNew: previousCa !== caCertPem,
    leafIssued,
  };
}
