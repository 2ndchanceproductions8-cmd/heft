// Builds public/food-index.<hash>.json — the Food tab's offline "common foods" index — and its pointer
// src/lib/nutrition/foodIndexMeta.ts, from USDA FoodData Central's bulk downloads (public domain, CC0 1.0; see
// THIRD_PARTY_NOTICES.md).
//
//   node scripts/build-food-index.mjs [cache dir]
//
// The outputs are committed; re-run this only to pick up a new USDA release (then search a few foods in the app).
//
// Pipeline
//   1. Read https://fdc.nal.usda.gov/download-datasets and take the newest JSON zip of each whole-food dataset:
//      Foundation, SR Legacy (frozen at 2018-04) and Survey (FNDDS). Zips already in the cache dir (default: the OS
//      temp dir) are reused, so a re-run is offline.
//   2. Unzip (a small reader below: one deflated JSON per zip) and parse each food with foodFromBulk
//      (src/lib/nutrition/fdcData.ts — the same nutrient-number rules as the live API: energy 208 → 958 → 957,
//      carbs 205 → 205.2, sugar 269 → 269.3). Rows without an energy value are dropped, as the app drops them.
//   3. Keep per 100 g kcal / protein / carbs / fat / fiber / sugar / sodium and up to MAX_PORTIONS household
//      measures, sort by name (similar names sit together and gzip better), and write the compact rows
//      (encodeFoodIndex). The file name carries a hash of the content, so the service worker's CacheFirst rule can
//      never serve a stale index; older index files in public/ are deleted.
//
// Node runs fdcData.ts directly (type stripping, Node 22.18+ / 23.6+); it has no value imports for that reason.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { encodeFoodIndex, foodFromBulk, INDEX_DATA_TYPES, MAX_PORTIONS } from '../src/lib/nutrition/fdcData.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(root, 'public');
const META = join(root, 'src/lib/nutrition/foodIndexMeta.ts');
const PAGE = 'https://fdc.nal.usda.gov/download-datasets';
const cacheDir = resolve(process.argv[2] ?? join(tmpdir(), 'heft-fdc'));

/** Dataset → its zip-name stem and the top-level key of its JSON. A dataset that parses to fewer foods FAILS the build. */
const DATASETS = [
  { dataType: 'Foundation', stem: 'foundation_food_json', key: 'FoundationFoods', min: 250 },
  { dataType: 'SR Legacy', stem: 'sr_legacy_food_json', key: 'SRLegacyFoods', min: 7000 },
  { dataType: 'Survey (FNDDS)', stem: 'survey_food_json', key: 'SurveyFoods', min: 4000 },
];

// ------------------------------------------------------------------ 1. pick + download

mkdirSync(cacheDir, { recursive: true });
const cached = readdirSync(cacheDir);

async function pickZips() {
  let html = '';
  try {
    const res = await fetch(PAGE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.warn(`warning: could not read ${PAGE} (${e.message}); using the zips in ${cacheDir}`);
  }
  return DATASETS.map((d) => {
    const pattern = `FoodData_Central_${d.stem}_(\\d{4}-\\d{2}(?:-\\d{2})?)\\.zip`;
    const names = new Set([...html.matchAll(new RegExp(pattern, 'g'))].map((m) => m[0]));
    for (const f of cached) if (new RegExp(`^${pattern}$`).test(f)) names.add(f);
    // The release date is in the name (yyyy-mm or yyyy-mm-dd), so the newest sorts last.
    const releaseOf = (name) => name.match(new RegExp(pattern))[1];
    const newest = [...names].sort((a, b) => releaseOf(a).localeCompare(releaseOf(b))).at(-1);
    if (!newest) throw new Error(`no ${d.stem} zip on ${PAGE} or in ${cacheDir}`);
    return { ...d, file: newest, release: releaseOf(newest) };
  });
}

async function download(file) {
  const path = join(cacheDir, file);
  if (existsSync(path) && statSync(path).size > 0) return path;
  const url = `https://fdc.nal.usda.gov/fdc-datasets/${file}`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

// ------------------------------------------------------------------ 2. unzip + parse

/** The first .json entry of a zip (stored or deflated; no ZIP64 — USDA's largest unzips to ~210 MB). */
function readJsonFromZip(path) {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${path}: not a zip`);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = buf.readUInt16LE(eocd + 10); k > 0; k--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path}: bad central directory`);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (!name.toLowerCase().endsWith('.json')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`${path}: ${name} uses zip method ${method}`);
    return JSON.parse((method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
  }
  throw new Error(`${path}: no .json inside`);
}

const zips = await pickZips();
const foods = [];
const sources = [];
for (const d of zips) {
  const json = readJsonFromZip(await download(d.file));
  const rows = json[d.key];
  if (!Array.isArray(rows)) throw new Error(`${d.file}: no "${d.key}" array (format changed?)`);
  let kept = 0;
  let dropped = 0;
  for (const row of rows) {
    const f = foodFromBulk(row);
    if (f && f.dataType === d.dataType) {
      foods.push(f);
      kept++;
    } else dropped++;
  }
  if (kept < d.min) throw new Error(`${d.file}: only ${kept} usable foods (expected ≥ ${d.min}; format changed?)`);
  sources.push({ dataType: d.dataType, release: d.release });
  console.log(`${d.dataType.padEnd(15)} ${d.file}: ${kept} foods (${dropped} rows without an fdcId, name or energy value)`);
}

// ------------------------------------------------------------------ 3. write

const seen = new Set();
const unique = foods.filter((f) => !seen.has(f.fdcId) && seen.add(f.fdcId));
unique.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.fdcId - b.fdcId));
sources.sort((a, b) => INDEX_DATA_TYPES.indexOf(a.dataType) - INDEX_DATA_TYPES.indexOf(b.dataType));

const text = JSON.stringify(encodeFoodIndex(unique, sources));
const hash = createHash('sha256').update(text).digest('hex').slice(0, 10);
const file = `food-index.${hash}.json`;
for (const f of readdirSync(PUBLIC)) if (/^food-index\..*\.json$/.test(f) && f !== file) unlinkSync(join(PUBLIC, f));
writeFileSync(join(PUBLIC, file), text);

const portions = unique.reduce((n, f) => n + f.portions.length, 0);
writeFileSync(
  META,
  `// Generated by scripts/build-food-index.mjs — do not edit. The offline food index in public/ (see foodIndex.ts).
import type { FoodIndexSource } from './fdcData';

export const FOOD_INDEX_FILE = '${file}';
export const FOOD_INDEX_FOODS = ${unique.length};
export const FOOD_INDEX_SOURCES: FoodIndexSource[] = [
${sources.map((s) => `  { dataType: '${s.dataType}', release: '${s.release}' },`).join('\n')}
];
`,
);

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
console.log(`\n${unique.length} foods, ${portions} portions (≤ ${MAX_PORTIONS} per food)`);
console.log(`wrote ${relative(root, join(PUBLIC, file))}: ${kb(Buffer.byteLength(text))} raw, ${kb(gzipSync(text, { level: 9 }).length)} gzipped`);
console.log(`wrote ${relative(root, META)}`);
