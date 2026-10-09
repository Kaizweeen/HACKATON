#!/usr/bin/env node
// Writes PLACEHOLDER map tiles (a hatched grid, no map data) so the offline tile pipeline can be tested before real tiles exist.
//   npm run tiles:placeholder -w @lubak/app -- --radius-km 3 --zooms 12-16
// Real tiles: see public/tiles/README.md. Never ship these as if they were a map.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    center: { type: 'string', default: '14.585,121.176' },
    'radius-km': { type: 'string', default: '3' },
    zooms: { type: 'string', default: '12-16' },
    out: { type: 'string', default: path.resolve(here, '../public/tiles') },
  },
});

const [lat, lon] = values.center.split(',').map(Number);
const radiusKm = Number(values['radius-km']);
const [zMin, zMax] = values.zooms.split('-').map(Number);
if (![lat, lon, radiusKm, zMin, zMax].every(Number.isFinite)) throw new Error('bad arguments; see the header of this file');

const tileX = (lonDeg, z) => Math.floor(((lonDeg + 180) / 360) * 2 ** z);
const tileY = (latDeg, z) => {
  const rad = (latDeg * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
};

function tilePixels(x, y) {
  const S = 256;
  const rgba = new Uint8Array(S * S * 4);
  const base = (x + y) % 2 === 0 ? [233, 236, 240] : [222, 226, 232];
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let c = base;
      if (px === 0 || py === 0 || px === S - 1 || py === S - 1) c = [150, 158, 170]; // tile border
      else if ((px + py) % 24 < 2) c = [208, 213, 221]; // diagonal hatch = "placeholder"
      const i = (py * S + px) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const dLat = radiusKm / 111.195;
const dLon = radiusKm / (111.195 * Math.cos((lat * Math.PI) / 180));
let count = 0;
let bytes = 0;
for (let z = zMin; z <= zMax; z++) {
  const x0 = tileX(lon - dLon, z), x1 = tileX(lon + dLon, z);
  const y0 = tileY(lat + dLat, z), y1 = tileY(lat - dLat, z);
  for (let x = x0; x <= x1; x++) {
    fs.mkdirSync(path.join(values.out, String(z), String(x)), { recursive: true });
    for (let y = y0; y <= y1; y++) {
      const png = encodePng(256, 256, tilePixels(x, y));
      fs.writeFileSync(path.join(values.out, String(z), String(x), `${y}.png`), png);
      count += 1;
      bytes += png.length;
    }
  }
  console.log(`z${z}: x ${x0}..${x1}, y ${y0}..${y1}`);
}
console.log(`wrote ${count} placeholder tiles (${(bytes / 1024).toFixed(0)} KB) to ${values.out}`);
