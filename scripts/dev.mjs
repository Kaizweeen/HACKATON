#!/usr/bin/env node
// `npm run dev`: the hub (restarts on changes) + the Vite dev server (live reload), side by side.
//
//   hub  https://localhost:8443   serves /ws and the last `npm run build` of the app
//   app  https://localhost:5173   live-reloading app; its /ws is proxied to the hub
//
// The dev server reuses the hub's TLS certificate, so phones that already trust the hub's CA can open
// https://<lan-ip>:5173 and test camera / motion code with live reload. The service worker is disabled in dev.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const certFile = path.join(root, 'hub', '.certs', 'cert.pem');

const children = [];
let stopping = false;

function run(label, color, args, cwd) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${color}m[${label}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`${tag}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${tag}exited (${signal ?? code}); stopping everything`);
    stop(code ?? 1);
  });
  children.push(child);
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('hub', '36', [tsxCli, 'watch', '--clear-screen=false', path.join('hub', 'src', 'index.ts')], root);

// The hub creates its certificate on first start; the dev server needs it before it starts.
const deadline = Date.now() + 30_000;
while (!fs.existsSync(certFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
if (!fs.existsSync(certFile)) console.warn('[dev] the hub has not produced a certificate yet; the dev server will use plain HTTP');

run('app', '35', [viteBin], path.join(root, 'app'));

setTimeout(() => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\n\x1b[1mDev ready.\x1b[0m Open https://localhost:5173 here${ips.length ? `, or https://${ips[0]}:5173 on a phone that trusts the hub certificate` : ''}.`);
  console.log('Run the fake device in another terminal:  npm run fake-device\n');
}, 4000).unref();
