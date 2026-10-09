import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { LogLevel } from './log.js';

const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(HUB_ROOT, '..');

export interface HubConfig {
  /** Interface to bind. 0.0.0.0 so phones on the hotspot can reach it. */
  host: string;
  /** HTTPS + WebSocket port (the PWA lives here). */
  httpsPort: number;
  /** Plain-HTTP helper port that serves the certificate-install page. null disables it. */
  helperPort: number | null;
  /** Serve over HTTPS. Only switch off for tests or behind another TLS terminator. */
  tls: boolean;
  /** Use mkcert when it is installed (otherwise, or with false, the selfsigned package). */
  preferMkcert: boolean;
  /** Built PWA to serve. */
  staticDir: string;
  /** hazards.json snapshot lives here. */
  dataDir: string;
  /** TLS keys and the CA certificate live here. NEVER commit. */
  certDir: string;
  snapshotMs: number;
  sweepMs: number;
  heartbeatMs: number;
  /** Extra DNS names / IPs to put in the certificate. */
  extraNames: string[];
  /** Delete any existing snapshot at start. */
  fresh: boolean;
  /** Shared event PIN. When set, /ws and /api/hazards answer only to phones that send it; null = anyone on the network. */
  pin: string | null;
  logLevel: LogLevel;
}

export const HELP = `Lubak Alert hub

Usage: npm run hub -- [options]

Options (environment variable in brackets)
  --port <n>         HTTPS + WebSocket port, default 8443        [HUB_PORT]
  --http-port <n>    certificate-install helper port, default 8080; "off" disables  [HUB_HELPER_PORT]
  --host <addr>      bind address, default 0.0.0.0                [HUB_HOST]
  --no-tls           serve plain HTTP (tests / behind a proxy)    [HUB_TLS=0]
  --no-mkcert        never use mkcert, always use selfsigned      [HUB_MKCERT=0]
  --names <a,b>      extra DNS names / IPs for the certificate    [HUB_EXTRA_NAMES]
  --static <dir>     built PWA directory, default app/dist        [HUB_STATIC_DIR]
  --data <dir>       snapshot directory, default hub/data         [HUB_DATA_DIR]
  --certs <dir>      TLS directory, default hub/.certs            [HUB_CERT_DIR]
  --fresh            discard the saved hazard snapshot at start   [HUB_FRESH=1]
  --pin <code>       require this event PIN from phones (4-32 letters/digits); phones open
                     https://<hub>/?pin=<code> once. Default: none, anyone on the network syncs  [HUB_PIN]
  --quiet | --verbose                                              [HUB_LOG=quiet|info|debug]
  -h, --help
`;

function toPort(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${label}: "${raw}" is not a valid port`);
  return n;
}

const flag = (env: string | undefined): boolean => env === '1' || env === 'true';

/** 4 to 32 letters, digits, '-' or '_': typed on a phone, and safe in a URL without escaping. Empty = no PIN. */
function toPin(raw: string | undefined): string | null {
  const pin = (raw ?? '').trim();
  if (pin === '') return null;
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(pin)) throw new Error('--pin / HUB_PIN must be 4 to 32 letters, digits, "-" or "_"');
  return pin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): HubConfig | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      'http-port': { type: 'string' },
      host: { type: 'string' },
      'no-tls': { type: 'boolean' },
      'no-mkcert': { type: 'boolean' },
      names: { type: 'string' },
      static: { type: 'string' },
      data: { type: 'string' },
      certs: { type: 'string' },
      fresh: { type: 'boolean' },
      pin: { type: 'string' },
      quiet: { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  if (values.help) return 'help';

  const helperRaw = values['http-port'] ?? env['HUB_HELPER_PORT'];
  const helperOff = helperRaw === 'off' || helperRaw === '0';
  const logRaw = values.quiet ? 'quiet' : values.verbose ? 'debug' : (env['HUB_LOG'] ?? 'info');
  const logLevel: LogLevel = logRaw === 'quiet' || logRaw === 'debug' ? logRaw : 'info';

  return {
    host: values.host ?? env['HUB_HOST'] ?? '0.0.0.0',
    httpsPort: toPort(values.port ?? env['HUB_PORT'], 8443, 'port'),
    helperPort: helperOff ? null : toPort(helperRaw, 8080, 'http-port'),
    tls: !(values['no-tls'] || env['HUB_TLS'] === '0'),
    preferMkcert: !(values['no-mkcert'] || env['HUB_MKCERT'] === '0'),
    staticDir: path.resolve(values.static ?? env['HUB_STATIC_DIR'] ?? path.join(REPO_ROOT, 'app', 'dist')),
    dataDir: path.resolve(values.data ?? env['HUB_DATA_DIR'] ?? path.join(HUB_ROOT, 'data')),
    certDir: path.resolve(values.certs ?? env['HUB_CERT_DIR'] ?? path.join(HUB_ROOT, '.certs')),
    snapshotMs: 10_000,
    sweepMs: 30_000,
    heartbeatMs: 30_000,
    extraNames: (values.names ?? env['HUB_EXTRA_NAMES'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    fresh: Boolean(values.fresh) || flag(env['HUB_FRESH']),
    pin: toPin(values.pin ?? env['HUB_PIN']),
    logLevel,
  };
}
