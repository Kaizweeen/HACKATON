#!/usr/bin/env node
// Draws the app icons (warning triangle with an exclamation mark) with a tiny supersampling rasteriser.
// Output: public/icons/{icon-192,icon-512,maskable-512,apple-touch-icon}.png and public/favicon.svg
//   npm run icons -w @lubak/app
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../public/icons');
fs.mkdirSync(outDir, { recursive: true });

const BG = [14, 17, 22];
const ACCENT = [255, 90, 77];

const distToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const inTriangle = (px, py, [a, b, c]) => {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const p = [px, py];
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

/** Is (x, y) inside a triangle of circumradius R rounded with radius r (Minkowski sum of an inset triangle and a disc)? */
function roundedTriangle(x, y, cx, cy, R, r) {
  const Ri = R - 2 * r;
  const v = [-90, 30, 150].map((deg) => [cx + Ri * Math.cos((deg * Math.PI) / 180), cy + Ri * Math.sin((deg * Math.PI) / 180)]);
  if (inTriangle(x, y, v)) return true;
  return Math.min(distToSegment(x, y, ...v[0], ...v[1]), distToSegment(x, y, ...v[1], ...v[2]), distToSegment(x, y, ...v[2], ...v[0])) <= r;
}

function roundedRect(x, y, left, top, w, h, r) {
  const qx = Math.abs(x - (left + w / 2)) - (w / 2 - r);
  const qy = Math.abs(y - (top + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= r;
}

/** @param {{size:number, fullBleed:boolean, scale:number}} o */
function render({ size, fullBleed, scale }) {
  const SS = 4; // 4x4 samples per pixel
  const rgba = new Uint8Array(size * size * 4);
  const cx = size / 2;
  const cy = size / 2 + size * 0.015;
  const R = size * 0.36 * scale;
  const r = size * 0.05 * scale;
  const corner = size * 0.22;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          let color = null;
          if (fullBleed || roundedRect(x, y, 0, 0, size, size, corner)) color = BG;
          if (color && roundedTriangle(x, y, cx, cy, R, r)) {
            color = ACCENT;
            const bar = roundedRect(x, y, cx - 0.085 * R, cy - 0.3 * R, 0.17 * R, 0.5 * R, 0.085 * R);
            const dot = Math.hypot(x - cx, y - (cy + 0.34 * R)) <= 0.095 * R;
            if (bar || dot) color = BG;
          }
          if (color) { rr += color[0]; gg += color[1]; bb += color[2]; aa += 255; }
        }
      }
      const n = SS * SS;
      const covered = aa / 255;
      const i = (py * size + px) * 4;
      if (covered > 0) {
        rgba[i] = Math.round(rr / covered);
        rgba[i + 1] = Math.round(gg / covered);
        rgba[i + 2] = Math.round(bb / covered);
        rgba[i + 3] = Math.round((covered / n) * 255);
      }
    }
  }
  return rgba;
}

const files = [
  ['icon-192.png', { size: 192, fullBleed: false, scale: 1 }],
  ['icon-512.png', { size: 512, fullBleed: false, scale: 1 }],
  ['maskable-512.png', { size: 512, fullBleed: true, scale: 0.9 }], // content stays inside the maskable safe zone
  ['apple-touch-icon.png', { size: 180, fullBleed: true, scale: 0.95 }], // iOS rounds the corners itself
];
for (const [name, o] of files) {
  fs.writeFileSync(path.join(outDir, name), encodePng(o.size, o.size, render(o)));
  console.log('wrote', path.join('public/icons', name));
}

// favicon.svg: the same drawing as vector.
const R = 22;
const tri = [-90, 30, 150].map((d) => [32 + R * Math.cos((d * Math.PI) / 180), 33 + R * Math.sin((d * Math.PI) / 180)].map((n) => n.toFixed(2)).join(','));
fs.writeFileSync(
  path.resolve(here, '../public/favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0e1116"/>
  <polygon points="${tri.join(' ')}" fill="#ff5a4d" stroke="#ff5a4d" stroke-width="5" stroke-linejoin="round"/>
  <rect x="29.9" y="25" width="4.2" height="12" rx="2.1" fill="#0e1116"/>
  <circle cx="32" cy="41.5" r="2.4" fill="#0e1116"/>
</svg>
`,
);
console.log('wrote public/favicon.svg');
