// Generates the Heft app icon set from one parametric SVG mark.
//
//   node scripts/make-icons.mjs
//
// Writes public/icons/:
//   icon.svg               master, 512 viewBox, superellipse ("squircle") tile with transparent corners
//   icon-192.png           192x192  same as master (manifest "any")
//   icon-512.png           512x512  same as master (manifest "any")
//   icon-maskable-512.png  512x512  full-bleed gradient, mark inside the central 80% safe circle
//   apple-touch-icon.png   180x180  full-bleed square (iOS rounds the corners itself)
//
// PNGs are rasterised by headless Chrome/Edge (no npm deps). Set HEFT_CHROME to point at another
// Chromium binary if neither is installed in the default location. Every PNG is verified after
// rendering: exact pixel size, corner transparency (or opacity, for full-bleed), the mark being
// centred, and - for the maskable icon - every mark pixel sitting inside the safe-zone circle.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import os from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public', 'icons');

// ---------------------------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------------------------
// A capital "H" read as a loaded barbell seen side-on: the two uprights are big weight plates, a
// smaller plate sits outside each one, the crossbar is the bar, and the sleeves poke out past the
// plates. The stacked plates keep it from reading as a plain "H" (hospital/hotel sign) while the
// tall inner plates still carry the letterform at 32-48px. Geometry is in a 512 grid, centred on
// the origin, before the per-variant scale is applied.
const MARK = {
  plateW: 74, // big plates = the H uprights
  plateH: 304,
  plateR: 28,
  gap: 112, // inner distance between the big plates (the H counter)
  smallW: 34, // smaller plate loaded outside each big plate, touching it (no hairline gaps)
  smallH: 200,
  smallR: 14,
  barH: 50, // crossbar thickness
  barR: 14,
  sleeve: 26, // how far the bar sticks out beyond the outer plates
};

const COLORS = {
  from: '#4a95ff', // tile gradient, top-left
  to: '#1f5fd6', // tile gradient, bottom-right
  shadow: '#0a2f80',
  ink: ['#ffffff', '#ecf3ff'], // bar + big plates (the "H"), top -> bottom
  inkPlate: ['#dce8ff', '#c9dafb'], // small outer plates: a step cooler so the plates read as a stack
};

const n = (v) => +v.toFixed(2);

function rect(x, y, w, h, r) {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}"/>`;
}

// The small plates are extended under the big ones (and hidden by them) so the two never share an
// edge: abutting anti-aliased edges leave a faint background-coloured seam.
const OVERLAP = 12;

/** Mark as SVG groups; `fills` = { bar, big, small } paint values (one colour for the shadow). */
function markShapes(fills) {
  const { plateW, plateH, plateR, gap, smallW, smallH, smallR, barH, barR, sleeve } = MARK;
  const bigX = gap / 2; // inner edge of a big plate
  const smallX = bigX + plateW; // inner edge of a small plate
  const half = smallX + smallW + sleeve; // bar end
  const bar = rect(-half, -barH / 2, half * 2, barH, barR);
  const small = [-1, 1]
    .map((side) => rect(side < 0 ? -(smallX + smallW) : smallX - OVERLAP, -smallH / 2, smallW + OVERLAP, smallH, smallR))
    .join('');
  const big = [-1, 1]
    .map((side) => rect(side < 0 ? -(bigX + plateW) : bigX, -plateH / 2, plateW, plateH, plateR))
    .join('');
  return `<g fill="${fills.bar}">${bar}</g><g fill="${fills.small}">${small}</g><g fill="${fills.big}">${big}</g>`;
}

/** Superellipse |x|^p + |y|^p = 1 spanning the 512 tile - smoother than a plain rounded rect. */
function squirclePath(size = 512, p = 5, steps = 360) {
  const c = size / 2;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = Math.sign(cos) * Math.abs(cos) ** (2 / p);
    const y = Math.sign(sin) * Math.abs(sin) ** (2 / p);
    pts.push(`${n(c + c * x)} ${n(c + c * y)}`);
  }
  return `M${pts.join('L')}Z`;
}

/**
 * @param {{ shape: 'squircle' | 'square', scale: number }} opts
 *   shape  - squircle: transparent corners (favicon / manifest "any"); square: full-bleed.
 *   scale  - size of the mark relative to the design grid.
 */
function buildSvg({ shape, scale }) {
  const tile = shape === 'square' ? '<rect width="512" height="512"/>' : `<path d="${squirclePath()}"/>`;
  const shadowDy = n(14 * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>Heft</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.from}"/>
      <stop offset="1" stop-color="${COLORS.to}"/>
    </linearGradient>
    <radialGradient id="sheen" cx="110" cy="30" r="460" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ink" x1="0" y1="-160" x2="0" y2="160" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.ink[0]}"/>
      <stop offset="1" stop-color="${COLORS.ink[1]}"/>
    </linearGradient>
    <linearGradient id="inkPlate" x1="0" y1="-110" x2="0" y2="110" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLORS.inkPlate[0]}"/>
      <stop offset="1" stop-color="${COLORS.inkPlate[1]}"/>
    </linearGradient>
    <clipPath id="tile">${tile}</clipPath>
    <filter id="soft" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="${n(10 * scale)}"/>
    </filter>
  </defs>
  <g clip-path="url(#tile)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <rect width="512" height="512" fill="url(#sheen)"/>
    <g transform="translate(256 ${n(256 + shadowDy)}) scale(${scale})" opacity="0.38" filter="url(#soft)">${markShapes({ bar: COLORS.shadow, small: COLORS.shadow, big: COLORS.shadow })}</g>
    <g transform="translate(256 256) scale(${scale})">${markShapes({ bar: 'url(#ink)', small: 'url(#inkPlate)', big: 'url(#ink)' })}</g>
  </g>
</svg>
`;
}

// Scale of the mark on the regular tile (mark ~64% of the tile wide, ~51% tall).
const BASE_SCALE = 0.86;
// Maskable: launchers crop to (at least) the central 80% circle and show that at the same size as
// other icons, so shrink the mark by the same 0.8 to keep its visual weight identical.
const MASKABLE_SCALE = BASE_SCALE * 0.8;

const TARGETS = [
  { file: 'icon-192.png', size: 192, shape: 'squircle', scale: BASE_SCALE },
  { file: 'icon-512.png', size: 512, shape: 'squircle', scale: BASE_SCALE },
  { file: 'icon-maskable-512.png', size: 512, shape: 'square', scale: MASKABLE_SCALE, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, shape: 'square', scale: BASE_SCALE },
];

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
function findBrowser() {
  const candidates = [
    process.env.HEFT_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error('No Chrome/Edge found. Set HEFT_CHROME to a Chromium-based browser binary.');
  }
  return found;
}

function render(browser, workDir, svg, size, outFile) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:${size}px;height:${size}px}
svg{display:block;width:${size}px;height:${size}px}
</style></head><body>${svg}</body></html>`;
  const page = join(workDir, `page-${size}-${Math.random().toString(36).slice(2, 8)}.html`);
  writeFileSync(page, html);
  if (existsSync(outFile)) rmSync(outFile);
  const res = spawnSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--user-data-dir=${join(workDir, 'profile')}`,
      `--window-size=${size},${size}`,
      `--screenshot=${outFile}`,
      pathToFileURL(page).href,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (!existsSync(outFile)) {
    throw new Error(`Browser did not write ${outFile} (exit ${res.status}).\n${(res.stderr || '').slice(-800)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Verification (tiny PNG decoder: 8-bit RGB/RGBA, non-interlaced - what Chromium writes)
// ---------------------------------------------------------------------------------------------
function decodePng(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || !channels || interlace) {
    return { width, height, pixels: null }; // size is still checkable
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * channels];
      out[o + 1] = cur[x * channels + 1];
      out[o + 2] = cur[x * channels + 2];
      out[o + 3] = channels === 4 ? cur[x * channels + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, pixels: out };
}

function verify(target, file) {
  const { width, height, pixels } = decodePng(file);
  const problems = [];
  if (width !== target.size || height !== target.size) {
    problems.push(`size is ${width}x${height}, expected ${target.size}x${target.size}`);
  }
  if (!pixels) {
    problems.push('could not decode pixels for inspection');
    return problems;
  }
  const px = (x, y) => pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
  const corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)];
  if (target.shape === 'square') {
    if (corners.some((c) => c[3] !== 255)) problems.push('full-bleed icon has non-opaque corners');
  } else if (corners.some((c) => c[3] !== 0)) {
    problems.push('squircle icon corners are not transparent');
  }
  // Mark pixels: near-white (the blue background never gets R above ~120).
  let minX = width, minY = height, maxX = -1, maxY = -1, maxR = 0;
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = px(x, y);
      if (p[3] < 200 || p[0] < 180) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      maxR = Math.max(maxR, Math.hypot(x - cx, y - cy));
    }
  }
  if (maxX < 0) {
    problems.push('no mark pixels found');
    return problems;
  }
  const offX = (minX + maxX) / 2 - cx;
  const offY = (minY + maxY) / 2 - cy;
  if (Math.abs(offX) > 1.5 || Math.abs(offY) > 1.5) {
    problems.push(`mark off-centre by (${offX.toFixed(1)}, ${offY.toFixed(1)}) px`);
  }
  if (target.maskable && maxR > width * 0.4) {
    problems.push(`mark reaches r=${maxR.toFixed(1)} px, outside the ${width * 0.4} px safe zone`);
  }
  target.report = `mark ${maxX - minX + 1}x${maxY - minY + 1}px (${Math.round(((maxX - minX + 1) / width) * 100)}% wide), max radius ${(maxR / width * 100).toFixed(1)}% of size`;
  return problems;
}

// ---------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const master = buildSvg({ shape: 'squircle', scale: BASE_SCALE });
writeFileSync(join(outDir, 'icon.svg'), master);
console.log('wrote public/icons/icon.svg');

const browser = findBrowser();
const workDir = mkdtempSync(join(os.tmpdir(), 'heft-icons-'));
let failed = false;
try {
  for (const t of TARGETS) {
    const out = join(outDir, t.file);
    render(browser, workDir, buildSvg(t), t.size, out);
    const problems = verify(t, out);
    if (problems.length) {
      failed = true;
      console.error(`FAIL ${t.file}: ${problems.join('; ')}`);
    } else {
      console.log(`ok   ${t.file} ${t.size}x${t.size} - ${t.report}`);
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (failed) process.exit(1);
