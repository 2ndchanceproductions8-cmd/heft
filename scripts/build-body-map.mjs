// Builds src/features/progress/bodyFigures.ts — the muscle map's body artwork — from MuscleMap by Melih Colpan
// (https://github.com/melihcolpan/MuscleMap, MIT License; see THIRD_PARTY_NOTICES.md).
//
//   git clone https://github.com/melihcolpan/MuscleMap.git <dir>
//   git -C <dir> checkout 7dc0307
//   node scripts/build-body-map.mjs <dir>
//
// The output is committed; re-run this only to pick up new upstream artwork (then look at the map, see below).
//
// Pipeline
//   1. Parse the four Swift path files (Sources/MuscleMap/Data/{Male,Female}{Front,Back}Paths.swift): a list of
//      `BodyPartPathData(slug:, common:, left:, right:)` records, each holding SVG path strings.
//   2. Map every MuscleMap slug to Heft's muscle vocabulary (MUSCLES in src/types.ts), to the neutral body tone,
//      to hair, or drop it (SLUG_MAP below). An unknown slug FAILS the build, so new upstream shapes get a decision.
//      "upper-back" is split by area: per body side the LARGEST shape is the lat, the smaller ones (teres /
//      infraspinatus) are upper_back.
//   3. Parse each path to absolute segments and compute exact bounds (Bézier extrema, arc extrema). Each figure is
//      cropped to its own width; front and back of the same sex share one height and one scale (the source draws
//      them side by side on one canvas), so the two figures line up when shown next to each other.
//   4. Re-encode each path translated into its figure's box, coordinates rounded to PRECISION decimals on an
//      absolute grid (relative commands are computed from the rounded points, so rounding never drifts), and merge
//      the paths of one region into a single `d` at the region's first position in the source draw order.
//
// Shared lighting (a region also lit by another muscle) is a runtime rule in src/features/progress/anatomy.ts.
// After a re-run, check the result visually (both sexes, both themes): a correct-looking file proves nothing.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src/features/progress/bodyFigures.ts');
const EXPECTED_COMMIT = '7dc0307';
// Decimals kept. The figures are ~630 units wide and shown at most ~170 px wide, so a whole unit is under 0.3 px:
// rounded to whole units the art rasterises like the source (compared pixel by pixel in Chrome at 2.5x the app's
// size) and the module is a third smaller than with 1 decimal (44 kB vs 66 kB for both sexes).
const PRECISION = 0;
const PAD = 3; // units of empty margin around each figure (keeps the selection outline inside the viewBox)

const checkout = process.argv[2];
if (!checkout) {
  console.error('usage: node scripts/build-body-map.mjs <path to a MuscleMap checkout>');
  process.exit(1);
}
const dataDir = join(resolve(checkout), 'Sources/MuscleMap/Data');
if (!existsSync(dataDir)) {
  console.error(`not a MuscleMap checkout (missing ${dataDir})`);
  process.exit(1);
}
const rev = spawnSync('git', ['-C', resolve(checkout), 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' });
const commit = rev.status === 0 ? rev.stdout.trim() : 'unknown';
if (commit !== EXPECTED_COMMIT) console.warn(`warning: checkout is at ${commit}, this script was written against ${EXPECTED_COMMIT}`);

// ------------------------------------------------------------------ vocabulary (single source: src/types.ts)

const typesSrc = readFileSync(join(root, 'src/types.ts'), 'utf8');
const musclesMatch = typesSrc.match(/export const MUSCLES\s*=\s*\[([\s\S]*?)\]\s*as const/);
if (!musclesMatch) throw new Error('could not read MUSCLES from src/types.ts');
const MUSCLES = [...musclesMatch[1].replace(/\/\/.*$/gm, '').matchAll(/['"]([a-z_]+)['"]/g)].map((x) => x[1]);

// ------------------------------------------------------------------ slug → Heft part

const SPLIT_UPPER_BACK = Symbol('upper-back');
/**
 * MuscleMap slug (Swift case name) → Heft part: a muscle from MUSCLES, 'body' (neutral tone), 'hair', or null (not
 * drawn). The dropped slugs are MuscleMap's sub-group marker shapes, drawn over their parent and hidden by default
 * in MuscleMap itself; adductors, neck and ankles are its always-visible sub-groups and are kept.
 */
const SLUG_MAP = {
  chest: 'chest',
  abs: 'abdominals',
  obliques: 'abdominals',
  biceps: 'biceps',
  triceps: 'triceps',
  deltoids: 'shoulders',
  forearm: 'forearms',
  quadriceps: 'quadriceps',
  adductors: 'adductors',
  hamstring: 'hamstrings',
  calves: 'calves',
  gluteal: 'glutes',
  lowerBack: 'lower_back',
  neck: 'neck',
  trapezius: 'traps',
  upperBack: SPLIT_UPPER_BACK,
  head: 'body',
  hands: 'body',
  feet: 'body',
  knees: 'body',
  ankles: 'body',
  tibialis: 'body',
  hair: 'hair',
  serratus: null,
  hipFlexors: null,
  upperChest: null,
  lowerChest: null,
  innerQuad: null,
  outerQuad: null,
  upperAbs: null,
  lowerAbs: null,
  frontDeltoid: null,
  rearDeltoid: null,
  upperTrapezius: null,
  lowerTrapezius: null,
};
for (const [slug, part] of Object.entries(SLUG_MAP)) {
  if (typeof part === 'string' && part !== 'body' && part !== 'hair' && !MUSCLES.includes(part))
    throw new Error(`SLUG_MAP.${slug}: "${part}" is not in MUSCLES`);
}

// ------------------------------------------------------------------ Swift parsing

/** Index just past the bracket that closes the one at `open`, skipping string literals. */
function closing(src, open) {
  const pairs = { '(': ')', '[': ']' };
  const stack = [pairs[src[open]]];
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '[') stack.push(pairs[c]);
    else if (c === ')' || c === ']') {
      if (stack.pop() !== c) throw new Error(`unbalanced "${c}" at ${i}`);
      if (!stack.length) return i + 1;
    }
  }
  throw new Error(`unclosed bracket at ${open}`);
}

function parseSwift(file) {
  const src = readFileSync(join(dataDir, file), 'utf8').replace(/\/\/.*$/gm, '');
  const parts = [];
  const re = /BodyPartPathData\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const body = src.slice(open + 1, closing(src, open) - 1);
    const slug = body.match(/slug:\s*\.(\w+)/)?.[1];
    if (!slug) throw new Error(`${file}: BodyPartPathData without a slug`);
    const list = (name) => {
      const at = body.match(new RegExp(`\\b${name}:\\s*\\[`));
      if (!at) return [];
      const start = at.index + at[0].length - 1;
      return [...body.slice(start, closing(body, start)).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    };
    parts.push({ slug, common: list('common'), left: list('left'), right: list('right') });
  }
  if (!parts.length) throw new Error(`${file}: no BodyPartPathData found`);
  return parts;
}

// ------------------------------------------------------------------ SVG path parsing (to absolute segments)

const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

function tokenize(d) {
  const out = []; // [letter, numbers[]]
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const num = () => {
    skip();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) throw new Error(`bad number at ${i} in "${d.slice(i, i + 20)}"`);
    i = NUM.lastIndex;
    return Number(m[0]);
  };
  const flag = () => {
    skip();
    const c = d[i++];
    if (c !== '0' && c !== '1') throw new Error(`bad arc flag at ${i - 1}`);
    return Number(c);
  };
  let cmd = null;
  for (;;) {
    skip();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) {
      cmd = d[i++];
      if (!(cmd.toUpperCase() in ARITY)) throw new Error(`unknown command ${cmd}`);
    } else if (!cmd) throw new Error('path must start with a command');
    else if (cmd === 'M') cmd = 'L'; // implicit repeats after a moveto are linetos
    else if (cmd === 'm') cmd = 'l';
    const up = cmd.toUpperCase();
    if (up === 'Z') {
      out.push(['Z', []]);
      cmd = null;
      continue;
    }
    const args = [];
    for (let k = 0; k < ARITY[up]; k++) args.push(up === 'A' && (k === 3 || k === 4) ? flag() : num());
    out.push([cmd, args]);
  }
  return out;
}

/** Absolute segments: M/L [x,y], Q [x1,y1,x,y], C [x1,y1,x2,y2,x,y], A [rx,ry,rot,fa,fs,x,y], Z []. */
function toAbsolute(d) {
  const segs = [];
  let cx = 0, cy = 0, sx = 0, sy = 0; // current point, subpath start
  let lastC = null, lastQ = null; // reflected control points for S / T
  for (const [cmd, a] of tokenize(d)) {
    const rel = cmd !== cmd.toUpperCase();
    const up = cmd.toUpperCase();
    const X = (v) => (rel ? cx + v : v);
    const Y = (v) => (rel ? cy + v : v);
    let c = null, q = null;
    switch (up) {
      case 'M':
        cx = X(a[0]); cy = Y(a[1]); sx = cx; sy = cy;
        segs.push(['M', [cx, cy]]);
        break;
      case 'L':
        cx = X(a[0]); cy = Y(a[1]);
        segs.push(['L', [cx, cy]]);
        break;
      case 'H':
        cx = X(a[0]);
        segs.push(['L', [cx, cy]]);
        break;
      case 'V':
        cy = rel ? cy + a[0] : a[0];
        segs.push(['L', [cx, cy]]);
        break;
      case 'C': {
        const p = [X(a[0]), Y(a[1]), X(a[2]), Y(a[3]), X(a[4]), Y(a[5])];
        segs.push(['C', p]);
        c = [p[2], p[3]]; cx = p[4]; cy = p[5];
        break;
      }
      case 'S': {
        const r = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
        const p = [r[0], r[1], X(a[0]), Y(a[1]), X(a[2]), Y(a[3])];
        segs.push(['C', p]);
        c = [p[2], p[3]]; cx = p[4]; cy = p[5];
        break;
      }
      case 'Q': {
        const p = [X(a[0]), Y(a[1]), X(a[2]), Y(a[3])];
        segs.push(['Q', p]);
        q = [p[0], p[1]]; cx = p[2]; cy = p[3];
        break;
      }
      case 'T': {
        const r = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
        const p = [r[0], r[1], X(a[0]), Y(a[1])];
        segs.push(['Q', p]);
        q = r; cx = p[2]; cy = p[3];
        break;
      }
      case 'A':
        cx = X(a[5]); cy = Y(a[6]);
        segs.push(['A', [a[0], a[1], a[2], a[3], a[4], cx, cy]]);
        break;
      case 'Z':
        segs.push(['Z', []]);
        cx = sx; cy = sy;
        break;
    }
    lastC = c;
    lastQ = q;
  }
  return segs;
}

// ------------------------------------------------------------------ geometry: exact bounds, area

/** SVG arc endpoint → center parameterization (SVG 1.1 F.6.5–F.6.6). null = draws as a straight line / nothing. */
function arcCenter(x1, y1, [rx0, ry0, rotDeg, fa, fs, x2, y2]) {
  if (x1 === x2 && y1 === y2) return null;
  let rx = Math.abs(rx0), ry = Math.abs(ry0);
  if (!rx || !ry) return null;
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let k = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) k = -k;
  const cxp = (k * rx * y1p) / ry, cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const th1 = ang(1, 0, ux, uy);
  let dth = ang(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI;
  else if (fs && dth < 0) dth += 2 * Math.PI;
  const at = (t) => {
    const th = th1 + t * dth;
    return [cx + rx * cos * Math.cos(th) - ry * sin * Math.sin(th), cy + rx * sin * Math.cos(th) + ry * cos * Math.sin(th)];
  };
  // Angles where x' or y' is 0, as fractions of the sweep that fall inside it.
  const extrema = [];
  for (const base of [Math.atan2(-ry * sin, rx * cos), Math.atan2(ry * cos, rx * sin)])
    for (let n = -3; n <= 3; n++) {
      const t = (base + n * Math.PI - th1) / dth;
      if (t > 0 && t < 1) extrema.push(t);
    }
  return { at, dth, extrema };
}

/** Roots in (0,1) of the derivative of a 1-D cubic / quadratic Bézier. */
function cubicExtrema(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0; // B'(t)/3 = a t² + b t + c
  const ts = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) ts.push((-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a));
  }
  return ts.filter((t) => t > 0 && t < 1);
}
const cubicAt = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};
const quadAt = (p0, p1, p2, t) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;

/**
 * Walk the segments: exact bounding box, plus a polyline per subpath for the area.
 * Returns { box: [minX, minY, maxX, maxY], area }.
 */
function measure(segs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  let area = 0;
  let poly = [];
  const flush = () => {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      area += x1 * y2 - x2 * y1;
    }
    poly = [];
  };
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const STEPS = 16;
  for (const [t, p] of segs) {
    if (t === 'M') {
      flush();
      cx = sx = p[0]; cy = sy = p[1];
      grow(cx, cy);
      poly.push([cx, cy]);
    } else if (t === 'L') {
      cx = p[0]; cy = p[1];
      grow(cx, cy);
      poly.push([cx, cy]);
    } else if (t === 'C') {
      for (const s of [...cubicExtrema(cx, p[0], p[2], p[4]), ...cubicExtrema(cy, p[1], p[3], p[5])])
        grow(cubicAt(cx, p[0], p[2], p[4], s), cubicAt(cy, p[1], p[3], p[5], s));
      for (let k = 1; k <= STEPS; k++) poly.push([cubicAt(cx, p[0], p[2], p[4], k / STEPS), cubicAt(cy, p[1], p[3], p[5], k / STEPS)]);
      cx = p[4]; cy = p[5];
      grow(cx, cy);
    } else if (t === 'Q') {
      for (const [a, b, c, isX] of [[cx, p[0], p[2], true], [cy, p[1], p[3], false]]) {
        const den = a - 2 * b + c;
        if (Math.abs(den) > 1e-12) {
          const s = (a - b) / den;
          if (s > 0 && s < 1) {
            const v = quadAt(a, b, c, s);
            if (isX) grow(v, cy);
            else grow(cx, v);
          }
        }
      }
      for (let k = 1; k <= STEPS; k++) poly.push([quadAt(cx, p[0], p[2], k / STEPS), quadAt(cy, p[1], p[3], k / STEPS)]);
      cx = p[2]; cy = p[3];
      grow(cx, cy);
    } else if (t === 'A') {
      const arc = arcCenter(cx, cy, p);
      if (arc) {
        for (const s of arc.extrema) grow(...arc.at(s));
        const n = Math.max(2, Math.ceil((Math.abs(arc.dth) / Math.PI) * STEPS));
        for (let k = 1; k <= n; k++) poly.push(arc.at(k / n));
      } else poly.push([p[5], p[6]]);
      cx = p[5]; cy = p[6];
      grow(cx, cy);
    } else if (t === 'Z') {
      cx = sx; cy = sy;
    }
  }
  flush();
  return { box: [minX, minY, maxX, maxY], area: Math.abs(area) / 2 };
}

// ------------------------------------------------------------------ encoding (translated + rounded)

const SCALE = 10 ** PRECISION;
/** Shortest decimal text for an integer count of 1/SCALE units ("-.5", "12.3", "40"). */
function fmtUnits(n) {
  let s = (n / SCALE).toFixed(PRECISION);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s.replace(/^(-?)0\./, '$1.');
}
function fmtPlain(v, decimals) {
  let s = v.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s.replace(/^(-?)0\./, '$1.');
}

/** Join numbers with the fewest separators ("1.5-2", "1.5.5", "1 2"). `prev` = the number written just before. */
function joinNums(nums, prev) {
  let out = '';
  for (const s of nums) {
    if (prev != null && !(s[0] === '-' || (s[0] === '.' && prev.includes('.') && !/e/i.test(prev)))) out += ' ';
    out += s;
    prev = s;
  }
  return out;
}

/** Encode absolute segments, translated by (dx, dy), as compact path data on a 1/SCALE grid. */
function encode(segs, dx, dy, state) {
  // state carries the current point (grid units), subpath start, last letter and last number across paths
  const g = (v, d) => Math.round((v + d) * SCALE);
  let out = '';
  const emit = (absLetter, absNums, relLetter, relNums) => {
    const cost = (letter, nums) => {
      const cont = letter === state.letter && letter !== 'M' && letter !== 'm';
      return { letter, cont, text: (cont ? '' : letter) + joinNums(nums, cont ? state.last : null) };
    };
    const a = cost(absLetter, absNums), r = cost(relLetter, relNums);
    const pick = r.text.length <= a.text.length ? r : a;
    out += pick.text;
    // after a moveto, implicit repeats are linetos, so only a following L / l may drop its letter
    state.letter = pick.letter === 'M' ? 'L' : pick.letter === 'm' ? 'l' : pick.letter;
    state.last = (pick === r ? relNums : absNums).at(-1) ?? null;
  };
  const pt = (x, y) => [g(x, dx), g(y, dy)];
  for (const [t, p] of segs) {
    const [cx, cy] = state.cur;
    if (t === 'Z') {
      out += 'z';
      state.letter = 'z';
      state.last = null;
      state.cur = state.start;
      continue;
    }
    if (t === 'M' || t === 'L') {
      const [x, y] = pt(p[0], p[1]);
      emit(t, [x, y].map(fmtUnits), t.toLowerCase(), [x - cx, y - cy].map(fmtUnits));
      state.cur = [x, y];
      if (t === 'M') state.start = [x, y];
    } else if (t === 'C' || t === 'Q') {
      const pts = [];
      for (let k = 0; k < p.length; k += 2) pts.push(...pt(p[k], p[k + 1]));
      emit(
        t,
        pts.map(fmtUnits),
        t.toLowerCase(),
        pts.map((v, k) => fmtUnits(v - (k % 2 ? cy : cx))),
      );
      state.cur = [pts.at(-2), pts.at(-1)];
    } else if (t === 'A') {
      const [x, y] = pt(p[5], p[6]);
      const minR = 1 / SCALE; // a radius rounded to 0 would turn the arc into a line
      const head = [
        fmtPlain(Math.max(minR, Math.abs(p[0])), PRECISION),
        fmtPlain(Math.max(minR, Math.abs(p[1])), PRECISION),
        fmtPlain(p[2], 1),
        String(p[3]),
        String(p[4]),
      ];
      emit('A', [...head, fmtUnits(x), fmtUnits(y)], 'a', [...head, fmtUnits(x - cx), fmtUnits(y - cy)]);
      state.cur = [x, y];
    }
  }
  return out;
}

// ------------------------------------------------------------------ build

const FIGURES = {
  male: { front: 'MaleFrontPaths.swift', back: 'MaleBackPaths.swift' },
  female: { front: 'FemaleFrontPaths.swift', back: 'FemaleBackPaths.swift' },
};

const report = [];
const built = {};
for (const [sex, views] of Object.entries(FIGURES)) {
  const figs = {};
  for (const [view, file] of Object.entries(views)) {
    const parts = parseSwift(file);
    const shapes = []; // { part, segs, box, area } in source draw order
    for (const p of parts) {
      if (!(p.slug in SLUG_MAP)) throw new Error(`${file}: unmapped MuscleMap slug "${p.slug}" (add it to SLUG_MAP)`);
      const target = SLUG_MAP[p.slug];
      if (target === null) continue;
      const measured = (d) => {
        const segs = toAbsolute(d);
        return { segs, ...measure(segs) };
      };
      if (target === SPLIT_UPPER_BACK) {
        if (p.common.length) throw new Error(`${file}: upper-back has centered paths; the lat split expects left/right only`);
        for (const [side, list] of [['left', p.left], ['right', p.right]]) {
          const ms = list.map(measured);
          const big = ms.reduce((best, m, i) => (m.area > ms[best].area ? i : best), 0);
          ms.forEach((m, i) => shapes.push({ part: i === big ? 'lats' : 'upper_back', ...m }));
          report.push(`${sex} ${view} upper-back ${side}: areas ${ms.map((m) => Math.round(m.area)).join(', ')} → lats = #${big}`);
        }
        continue;
      }
      for (const d of [...p.common, ...p.left, ...p.right]) shapes.push({ part: target, ...measured(d) });
    }
    const box = shapes.reduce(
      (b, s) => [Math.min(b[0], s.box[0]), Math.min(b[1], s.box[1]), Math.max(b[2], s.box[2]), Math.max(b[3], s.box[3])],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
    figs[view] = { shapes, box };
  }
  // One height and one scale per sex; each figure cropped to its own width and centered in the shared width.
  const top = Math.min(figs.front.box[1], figs.back.box[1]);
  const bottom = Math.max(figs.front.box[3], figs.back.box[3]);
  const width = Math.max(...Object.values(figs).map((f) => f.box[2] - f.box[0]));
  const W = Math.ceil(width + 2 * PAD);
  const H = Math.ceil(bottom - top + 2 * PAD);
  built[sex] = {};
  for (const [view, f] of Object.entries(figs)) {
    const dx = -f.box[0] + (W - (f.box[2] - f.box[0])) / 2;
    const dy = -top + PAD;
    const layers = new Map(); // part → d, in order of first appearance
    const states = new Map();
    for (const s of f.shapes) {
      if (!states.has(s.part)) states.set(s.part, { cur: [0, 0], start: [0, 0], letter: null, last: null });
      layers.set(s.part, (layers.get(s.part) ?? '') + encode(s.segs, dx, dy, states.get(s.part)));
    }
    built[sex][view] = { w: W, h: H, layers: [...layers].map(([part, d]) => ({ part, d })) };
    report.push(
      `${sex} ${view}: source box x ${f.box[0].toFixed(1)}–${f.box[2].toFixed(1)}, y ${f.box[1].toFixed(1)}–${f.box[3].toFixed(1)} → viewBox 0 0 ${W} ${H}; ` +
        `${f.shapes.length} paths in ${layers.size} layers: ${[...layers.keys()].join(' ')}`,
    );
  }
}

// ------------------------------------------------------------------ write

const lines = [
  '// GENERATED by scripts/build-body-map.mjs. DO NOT EDIT: change the script and re-run it.',
  '//   node scripts/build-body-map.mjs <MuscleMap checkout>',
  '//',
  `// Body artwork from MuscleMap by Melih Colpan, https://github.com/melihcolpan/MuscleMap (commit ${commit}).`,
  '// MIT License, Copyright (c) 2026 Melih Colpan; the full license text is in THIRD_PARTY_NOTICES.md.',
  '// Changes: converted from Swift to TypeScript, sub-group marker shapes dropped, paths of one region merged,',
  `// coordinates translated into each figure's box and rounded to ${PRECISION ? `${1 / SCALE} units` : 'whole units'};`,
  '// the shapes are otherwise unchanged.',
  '',
  "import type { Muscle } from '../../types';",
  '',
  "/** A Heft muscle, the neutral body tone ('body': head, hands, feet, knees, ankles, shins) or 'hair'. */",
  "export type BodyPart = Muscle | 'body' | 'hair';",
  '',
  '/** One shape layer; layers are listed in draw order (later layers paint over earlier ones). */',
  'export interface BodyLayer {',
  '  readonly part: BodyPart;',
  '  readonly d: string;',
  '}',
  '',
  '/** A figure in a `0 0 w h` viewBox. Front and back of one sex share w, h and scale, so they line up side by side. */',
  'export interface BodyFigure {',
  '  readonly w: number;',
  '  readonly h: number;',
  '  readonly layers: readonly BodyLayer[];',
  '}',
  '',
];
const constName = (sex, view) => `${sex.toUpperCase()}_${view.toUpperCase()}`;
for (const [sex, views] of Object.entries(built))
  for (const [view, fig] of Object.entries(views)) {
    lines.push(`export const ${constName(sex, view)}: BodyFigure = {`, `  w: ${fig.w},`, `  h: ${fig.h},`, '  layers: [');
    for (const l of fig.layers) lines.push(`    { part: '${l.part}', d: '${l.d}' },`);
    lines.push('  ],', '};', '');
  }
lines.push(
  'export const BODY_FIGURES = {',
  ...Object.keys(built).map((sex) => `  ${sex}: { front: ${constName(sex, 'front')}, back: ${constName(sex, 'back')} },`),
  '} as const;',
  '',
);
const text = lines.join('\n');
writeFileSync(OUT, text);
for (const r of report) console.log(r);
console.log(`wrote ${relative(root, OUT)} (${(text.length / 1024).toFixed(1)} kB)`);
