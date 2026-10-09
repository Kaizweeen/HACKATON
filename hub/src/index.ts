/**
 * Hub entry point: `npm run hub`.
 * Generates a TLS certificate on first run, serves the built PWA over HTTPS, runs the WebSocket relay
 * and prints the LAN URL plus what to do on the phones.
 */

import os from 'node:os';
import { collectCertNames, ensureTls, type TlsMaterial } from './certs.js';
import { HELP, loadConfig } from './config.js';
import { createHelperServer } from './helper.js';
import { createHub } from './hub.js';
import { lanAddresses } from './lan.js';
import { createLogger } from './log.js';
import { HazardStore } from './store.js';

function banner(lines: string[]): void {
  const width = Math.min(100, Math.max(...lines.map((l) => l.length)) + 2);
  console.log('\n' + '─'.repeat(width));
  for (const l of lines) console.log(' ' + l);
  console.log('─'.repeat(width) + '\n');
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config === 'help') {
    console.log(HELP);
    return;
  }
  const log = createLogger(config.logLevel);

  const store = new HazardStore({ dataDir: config.dataDir, log });
  if (config.fresh) {
    store.deleteSnapshot();
    log.info('--fresh: discarded the saved hazard snapshot');
  } else {
    const loaded = store.load();
    if (loaded > 0) log.info(`restored ${loaded} hazard(s) from ${config.dataDir}`);
  }

  let tls: TlsMaterial | undefined;
  if (config.tls) {
    tls = await ensureTls({ dir: config.certDir, names: collectCertNames(config.extraNames), preferMkcert: config.preferMkcert, log });
  }

  const hub = createHub({ config, tls, store, log });
  await hub.start();

  const scheme = tls ? 'https' : 'http';
  const addresses = lanAddresses();
  const hosts = addresses.map((a) => a.address);
  if (hosts.length === 0) hosts.push(os.hostname());

  let helper: ReturnType<typeof createHelperServer> | undefined;
  if (tls && config.helperPort !== null) {
    helper = createHelperServer({ caCertPem: tls.caCertPem, caFingerprint256: tls.caFingerprint256, mode: tls.mode, httpsPort: hub.port });
    await new Promise<void>((resolve, reject) => {
      helper!.once('error', reject);
      helper!.listen(config.helperPort!, config.host, resolve);
    }).catch((err: Error) => {
      log.warn(`certificate helper page disabled: ${err.message}`);
      helper = undefined;
    });
  }

  const lines: string[] = ['LUBAK ALERT HUB is running', ''];
  lines.push('Open this on every phone (same Wi-Fi / hotspot as this computer):');
  for (const a of addresses) lines.push(`  ${scheme}://${a.address}:${hub.port}   (${a.iface}${a.hint ? `, ${a.hint}` : ''})`);
  if (addresses.length === 0) lines.push('  (no LAN address found: connect to a Wi-Fi network or turn on a hotspot, then restart the hub)');
  lines.push(`  ${scheme}://localhost:${hub.port}   (this computer)`);
  lines.push('');
  if (tls) {
    lines.push(`HTTPS certificate: ${tls.mode === 'mkcert' ? 'mkcert' : 'local CA made with the selfsigned package'}, valid until ${tls.leafNotAfter.toISOString().slice(0, 10)}`);
    lines.push(`Covers: ${tls.names.join(', ')}`);
    lines.push('If this computer gets a new IP the certificate is reissued automatically on the next start; phones keep trusting the CA.');
    lines.push('');
    if (tls.caIsNew) lines.push('>>> NEW CA: every phone has to install the certificate below (again). <<<', '');
    lines.push('PHONES: trust the hub ONCE, or the camera / motion / offline mode will not work:');
    if (helper) {
      lines.push(`  1. Open  http://${hosts[0]}:${config.helperPort}  on the phone and tap "Download certificate".`);
    } else {
      lines.push(`  1. Copy ${tls.caCertPath} to the phone (AirDrop, USB, chat app).`);
    }
    lines.push('  2. Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate.');
    lines.push('     iPhone (Safari!): Allow the download, Settings > Profile Downloaded > Install, then');
    lines.push('     Settings > General > About > Certificate Trust Settings > switch the CA on.');
    lines.push(`  3. Open  ${scheme}://${hosts[0]}:${hub.port}  -> no warning -> "Install app" / "Add to Home Screen".`);
    lines.push(`  CA SHA-256: ${tls.caFingerprint256}`);
    lines.push(`  CA file on this computer: ${tls.caCertPath}`);
    lines.push('  More detail and troubleshooting: README.md > "Trusting the certificate".');
  } else {
    lines.push('TLS is OFF (--no-tls). Phones cannot use the camera or motion sensors over plain HTTP, except via localhost.');
  }
  lines.push('');
  lines.push(`Hazards in memory: ${store.size}   snapshot: ${config.dataDir}  (every ${config.snapshotMs / 1000}s)`);
  lines.push(`PWA directory: ${config.staticDir}`);
  lines.push('Stop with Ctrl+C. Test without a camera:  npm run fake-device');
  banner(lines);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: shutting down`);
    helper?.close();
    await hub.stop();
    store.snapshotSync();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
