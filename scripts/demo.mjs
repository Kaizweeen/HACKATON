#!/usr/bin/env node
// `npm run demo`: everything a rehearsal needs in one command.
//   1. placeholder map tiles, only if app/public/tiles has none (real tiles are never overwritten)
//   2. a fresh build of the app (the hub serves app/dist)
//   3. the hub with an empty hazard store
// Extra arguments go to the hub: `npm run demo -- --no-mkcert`.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tilesDir = path.join(root, 'app', 'public', 'tiles');
const hasTiles = fs.existsSync(tilesDir) && fs.readdirSync(tilesDir).some((name) => /^\d+$/.test(name));

function step(label, args) {
  console.log(`\n[demo] ${label}`);
  const result = spawnSync(npm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`[demo] "${label}" failed; fix that first.`);
    process.exit(result.status ?? 1);
  }
}

if (!hasTiles) {
  console.log('[demo] no map tiles found: generating PLACEHOLDER tiles (hatched grid, no map data). Render real ones for the stage, see app/public/tiles/README.md.');
  step('placeholder tiles', ['run', 'tiles:placeholder', '-w', '@lubak/app', '--', '--radius-km', '2', '--zooms', '12-17']);
}
step('build the app', ['run', 'build']);
if (!fs.existsSync(path.join(root, 'app', 'public', 'models', 'lubak.onnx'))) {
  console.log('\n[demo] NOTE: app/public/models/lubak.onnx is missing, so the Drive screen shows MOCK (random boxes). Demo mode (?demo=1) is unaffected.');
}
console.log('\n[demo] starting the hub with --fresh. Open the URL it prints on each phone.\n');
const hub = spawn(npm, ['run', 'hub', '--', '--fresh', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
hub.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => hub.kill(signal));
