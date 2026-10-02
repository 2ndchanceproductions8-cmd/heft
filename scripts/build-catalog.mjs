// Builds src/data/catalog.json from free-exercise-db (Unlicense) + scripts/catalog-overrides.json.
//
//   npm run catalog
//
// Pipeline
//   1. Every non-stretching dataset exercise gets heuristic metadata (equipment, muscles, type, MET).
//   2. scripts/catalog-overrides.json is applied:
//        rename  { id: "Hevy-style Name (Equipment)" }  – curated display names
//        patch   { id: { ...partial CatalogExercise } } – fixes; `aliases` are MERGED, `null` deletes a field
//        exclude [ id ]                                   – absurd entries and exact duplicates
//        add     [ CatalogExercise ]                      – common gym exercises the dataset lacks (ids "hv_*")
//      Keys starting with "_" are comments and ignored.
//   3. The result is validated (unique ids + case-insensitive names, vocabularies from src/types.ts, images
//      on disk, cardio MET and MET only on timed types, Smith/equipment-suffix consistency, overrides pointing at
//      real catalog ids with known fields, no alias that is another exercise's name) and the build FAILS with a
//      full list of problems instead of shipping a bad catalog. src/data/catalog.test.ts re-checks the output
//      and that catalog.json matches a fresh build.
//
// Naming convention (Hevy): "<Movement> (<Equipment>)" for barbell, dumbbell, machine, cable, Smith machine,
// kettlebell, EZ bar, band and plate; no suffix for bodyweight, cardio and other ("Pull Up", "Treadmill Run").
// When a name carries an equipment suffix, the equipment is DERIVED from it so the two can never disagree.
//
// IDs are never changed: saved workouts and routines reference them. The original dataset name is kept in
// `aliases` so search still finds it — EXCEPT when that old name is now the display name of a different exercise
// (the dataset's "Air Bike" is a bicycle crunch, while "Air Bike" is now the fan bike): an alias that equals
// another exercise's name would send a search to the wrong exercise, so it is dropped (and logged). Curated
// aliases may never equal another exercise's name; the build fails instead.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--check` validates without writing; `--out <file>` writes somewhere else (for reviewing changes).
const CHECK_ONLY = process.argv.includes('--check');
const outArg = process.argv.indexOf('--out');
if (outArg > 0 && (!process.argv[outArg + 1] || process.argv[outArg + 1].startsWith('--'))) {
  console.error('catalog: --out needs a file path, e.g. --out tmp/catalog.json');
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = JSON.parse(readFileSync(join(root, 'scripts/source/free-exercise-db.json'), 'utf8'));
const ovPath = join(root, 'scripts/catalog-overrides.json');
const overrides = existsSync(ovPath)
  ? JSON.parse(readFileSync(ovPath, 'utf8'))
  : { rename: {}, patch: {}, exclude: [], add: [] };
const strip = (obj = {}) => Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_')));
const RENAME = strip(overrides.rename);
const PATCH = strip(overrides.patch);
const EXCLUDE = new Set((overrides.exclude ?? []).filter((id) => !id.startsWith('_')));
const ADD = overrides.add ?? [];

// ------------------------------------------------------------------ vocabularies (single source: src/types.ts)

const typesSrc = readFileSync(join(root, 'src/types.ts'), 'utf8');
function vocab(name) {
  const m = typesSrc.match(new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
  if (!m) throw new Error(`could not read ${name} from src/types.ts`);
  // Strip line comments first so a quoted word inside a comment can't sneak into the vocabulary.
  const body = m[1].replace(/\/\/.*$/gm, '');
  const list = [...body.matchAll(/['"]([a-z_]+)['"]/g)].map((x) => x[1]);
  if (!list.length) throw new Error(`${name} in src/types.ts parsed as empty`);
  return list;
}
const EQUIPMENT = vocab('EQUIPMENT');
const MUSCLES = vocab('MUSCLES');
const EXERCISE_TYPES = vocab('EXERCISE_TYPES');
// Optional CatalogExercise fields (string unions in src/types.ts).
const LEVELS = ['beginner', 'intermediate', 'expert'];
const MECHANICS = ['compound', 'isolation'];
const FORCES = ['push', 'pull', 'static'];
/** Fields a patch / added exercise may set. Anything else is a typo that `ordered()` would silently drop. */
const FIELDS = new Set([
  'name', 'aliases', 'equipment', 'primary', 'secondary', 'type', 'met', 'images', 'instructions', 'level', 'mechanic', 'force',
]);
/**
 * Types whose sets log time. lib/calories.ts treats any exercise with a MET as cardio and multiplies the MET by
 * the time logged in its sets, so a MET on any other type would earn 0 kcal AND drop those sets from the
 * strength estimate.
 */
const TIMED_TYPES = new Set(['duration', 'duration_weight', 'distance_duration']);

/** Equipment that is written as a name suffix, in the order longer labels are tested first. */
const SUFFIX = [
  ['Smith Machine', 'smith_machine'],
  ['Barbell', 'barbell'],
  ['Dumbbell', 'dumbbell'],
  ['Machine', 'machine'],
  ['Cable', 'cable'],
  ['Kettlebell', 'kettlebell'],
  ['EZ Bar', 'ez_bar'],
  ['Band', 'band'],
  ['Plate', 'plate'],
];
const SUFFIX_LABEL = Object.fromEntries(SUFFIX.map(([label, eq]) => [eq, label]));
function suffixEquipment(name) {
  const m = name.match(/\(([^()]+)\)\s*$/);
  if (!m) return null;
  return SUFFIX.find(([label]) => label === m[1])?.[1] ?? null;
}

// ------------------------------------------------------------------ heuristics for dataset entries

const MUSCLE = {
  abdominals: 'abdominals', hamstrings: 'hamstrings', adductors: 'adductors', quadriceps: 'quadriceps',
  biceps: 'biceps', shoulders: 'shoulders', chest: 'chest', 'middle back': 'upper_back', calves: 'calves',
  glutes: 'glutes', 'lower back': 'lower_back', lats: 'lats', triceps: 'triceps', traps: 'traps',
  forearms: 'forearms', neck: 'neck', abductors: 'abductors',
};

function datasetEquipment(e) {
  if (/smith/i.test(e.name)) return 'smith_machine';
  if (e.category === 'cardio') return 'cardio';
  if (/\bplate\b/i.test(e.name) && e.equipment === 'other') return 'plate';
  if (/\bez[- ]?bar\b/i.test(e.name)) return 'ez_bar';
  switch (e.equipment) {
    case 'barbell': return 'barbell';
    case 'dumbbell': return 'dumbbell';
    case 'machine': return 'machine';
    case 'cable': return 'cable';
    case 'kettlebells': return 'kettlebell';
    case 'bands': return 'band';
    case 'e-z curl bar': return 'ez_bar';
    case 'body only':
    case null: return 'bodyweight';
    case 'other': return e.category === 'plyometrics' ? 'bodyweight' : 'other';
    default: return 'other'; // medicine ball, exercise ball
  }
}

/** Fallback Hevy-style name for dataset entries the overrides don't rename (future dataset updates). */
const EQUIPMENT_WORDS = {
  barbell: /\bbarbell\b/gi,
  dumbbell: /\b(two-|one-)?dumbbells?\b|\bDB\b/gi,
  machine: /\b(machine|leverage)\b/gi,
  smith_machine: /\bsmith( machine)?\b/gi,
  cable: /\bcables?\b/gi,
  kettlebell: /\bkettlebells?\b/gi,
  ez_bar: /\bez[- ]?(curl )?bar\b/gi,
  band: /\s*-?\s*with bands?\b|\bbands?\b/gi,
  plate: /\bplate\b/gi,
};
const SMALL = new Set(['a', 'an', 'and', 'of', 'on', 'the', 'to', 'with', 'from', 'for', 'in', 'over', 'or']);
function autoName(name, equipment) {
  let s = ` ${name} `
    .replace(/\(([^)]*)\)/g, ' - $1 ')
    .replace(/\bpush[- ]?ups?\b|\bpushups\b/gi, 'Push Up')
    .replace(/\bpull[- ]?ups?\b|\bpullups?\b/gi, 'Pull Up')
    .replace(/\bchin[- ]?ups?\b/gi, 'Chin Up')
    .replace(/\bsit[- ]?ups?\b/gi, 'Sit Up')
    .replace(/\bstep[- ]?ups?\b/gi, 'Step Up')
    .replace(/\bflyes\b|\bflye\b|\bflys\b/gi, 'Fly')
    .replace(/\bskullcrushers?\b/gi, 'Skull Crusher')
    .replace(/\b(curl|row|raise|squat|lunge|crunche|extension|shrug|deadlift|dip|swing|pulldown|pushdown|press)s\b/gi, '$1')
    .replace(/\bcrunche\b/gi, 'Crunch')
    .replace(/\bone[- ]arm\b/gi, 'Single Arm')
    .replace(/\bone[- ]leg(ged)?\b/gi, 'Single Leg');
  const re = EQUIPMENT_WORDS[equipment];
  if (re) s = s.replace(re, ' ');
  s = s
    .replace(/\s*-\s*(-\s*)*/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*-\s*|\s*-\s*$/g, '')
    .trim();
  s = s
    .split(' ')
    .map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
  const label = SUFFIX_LABEL[equipment];
  return label ? `${s} (${label})` : s;
}

const CARDIO_MET = [
  [/incline (treadmill )?walk/i, 6.0],
  [/treadmill run|^running/i, 9.8],
  [/jog/i, 7.0],
  [/walk/i, 4.0],
  [/spin/i, 8.5],
  [/air bike|assault/i, 8.0],
  [/recumbent/i, 5.5],
  [/stationary bike|bike/i, 7.0],
  [/cycling|bicycl/i, 7.5],
  [/elliptical/i, 5.0],
  [/rowing|rower/i, 7.0],
  [/stair|step mill/i, 9.0],
  [/jump rope|rope jump|skipping/i, 11.8],
  [/battle rope|battling rope/i, 10.3],
];

function heuristicType(e, rec) {
  const n = rec.name.toLowerCase();
  if (rec.equipment === 'cardio' || rec.primary === 'cardio') {
    return /treadmill|bike|bicycl|cycling|rowing|rower|elliptical|running|jogging|walking|skating|^run|^walk/.test(n)
      ? 'distance_duration'
      : 'duration';
  }
  if (/\bweighted (pull up|chin up|dip|push up)/.test(n)) return 'weighted_bodyweight';
  if (/\bassisted\b/.test(n) && rec.equipment === 'machine') return 'assisted_bodyweight';
  if (/farmer|yoke walk|sled (push|pull|drag)|carry\b/.test(n)) return 'weight_distance';
  const bodyweightish = rec.equipment === 'bodyweight' || rec.equipment === 'other';
  if (e?.force === 'static' || /\b(plank|wall sit|dead hang|hold)\b/.test(n)) {
    return bodyweightish ? 'duration' : 'duration_weight';
  }
  if (rec.equipment === 'bodyweight') return 'bodyweight_reps';
  return 'weight_reps';
}

const clean = (lines) => (lines ?? []).map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);

function mergeAliases(name, ...lists) {
  const seen = new Set([name.toLowerCase()]);
  const out = [];
  for (const a of lists.flat()) {
    if (!a) continue;
    const t = String(a).trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** Apply a patch: `aliases` merge, `null` deletes, everything else replaces. */
function applyPatch(rec, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('_') || k === 'aliases') continue;
    if (v === null) delete rec[k];
    else rec[k] = v;
  }
}

/** Canonical key order so the JSON diff stays readable. */
function ordered(r) {
  return {
    id: r.id,
    name: r.name,
    ...(r.aliases?.length ? { aliases: r.aliases } : {}),
    equipment: r.equipment,
    primary: r.primary,
    secondary: r.secondary,
    type: r.type,
    ...(r.met != null ? { met: r.met } : {}),
    images: r.images,
    instructions: r.instructions,
    ...(r.level ? { level: r.level } : {}),
    ...(r.mechanic ? { mechanic: r.mechanic } : {}),
    ...(r.force ? { force: r.force } : {}),
  };
}

// ------------------------------------------------------------------ build

const errors = [];
const srcIds = new Set(src.map((e) => e.id));
const isDropped = (e) => e.category === 'stretching' || e.equipment === 'foam roll';
const droppedIds = new Set(src.filter(isDropped).map((e) => e.id));
for (const [section, ids] of [['rename', Object.keys(RENAME)], ['patch', Object.keys(PATCH)], ['exclude', [...EXCLUDE]]]) {
  for (const id of ids) {
    if (!srcIds.has(id)) errors.push(`overrides.${section}: unknown dataset id "${id}"`);
    // Stretches/foam-roll entries never reach the catalog, so an override for one would be silently ignored.
    else if (droppedIds.has(id)) errors.push(`overrides.${section}: "${id}" is a stretch/foam-roll entry, which the build drops`);
  }
}
for (const id of EXCLUDE) {
  if (RENAME[id] || PATCH[id]) errors.push(`overrides: "${id}" is excluded but also renamed/patched`);
}
for (const [id, name] of Object.entries(RENAME)) {
  if (typeof name !== 'string' || !name.trim()) errors.push(`overrides.rename: "${id}" must map to a non-empty name`);
}
for (const [id, patch] of Object.entries(PATCH)) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    errors.push(`overrides.patch: "${id}" must be an object`);
    continue;
  }
  for (const k of Object.keys(patch)) {
    if (!k.startsWith('_') && !FIELDS.has(k)) errors.push(`overrides.patch: "${id}" has unknown field "${k}"`);
  }
}
const strings = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string');
/** An explicit equipment that disagrees with the name's suffix is a data mistake, not something to fix silently. */
function checkSuffix(where, name, equipment) {
  const fromName = suffixEquipment(name);
  if (fromName && equipment && equipment !== fromName) {
    errors.push(`${where}: equipment "${equipment}" contradicts the name suffix (${SUFFIX_LABEL[fromName]})`);
  }
}

const ORIGINAL_NAME = new Map(src.map((e) => [e.id, e.name]));
const out = [];
let droppedStretching = 0;
for (const e of src) {
  if (isDropped(e)) {
    droppedStretching++;
    continue;
  }
  if (EXCLUDE.has(e.id)) continue;
  const patch = PATCH[e.id] && typeof PATCH[e.id] === 'object' && !Array.isArray(PATCH[e.id]) ? PATCH[e.id] : {};

  const mapped = (list) => list.map((m) => MUSCLE[m]).filter(Boolean);
  const prim = mapped(e.primaryMuscles);
  const all = [...prim, ...mapped(e.secondaryMuscles)];
  const isCardio = e.category === 'cardio';
  const primary = isCardio ? 'cardio' : prim[0] ?? 'other';
  const rec = {
    id: e.id,
    name: '',
    equipment: datasetEquipment(e),
    primary,
    secondary: [...new Set(isCardio ? all : all.slice(1))].filter((m) => m !== primary),
    type: 'weight_reps',
    images: e.images.map((p) => `ex/${p.replace(/\.jpe?g$/i, '.webp')}`),
    instructions: clean(e.instructions),
    level: e.level ?? undefined,
    mechanic: e.mechanic ?? undefined,
    force: e.force ?? undefined,
  };
  applyPatch(rec, patch);
  rec.name = String(RENAME[e.id] ?? patch.name ?? autoName(e.name, rec.equipment)).trim();
  checkSuffix(`overrides.patch "${e.id}"`, rec.name, patch.equipment);
  // A suffix in the name decides the equipment, so "(Smith Machine)" etc. can't drift from the data.
  rec.equipment = suffixEquipment(rec.name) ?? (patch.equipment ?? rec.equipment);
  if (/smith/i.test(rec.name)) rec.equipment = 'smith_machine';
  if (!('type' in patch)) rec.type = heuristicType(e, rec);
  if (rec.secondary.includes(rec.primary)) rec.secondary = rec.secondary.filter((m) => m !== rec.primary);
  if ((rec.equipment === 'cardio' || rec.primary === 'cardio') && rec.met == null) {
    rec.met = (CARDIO_MET.find(([re]) => re.test(rec.name)) ?? [null, 7.0])[1];
  }
  if (patch.aliases !== undefined && !Array.isArray(patch.aliases)) errors.push(`overrides.patch "${e.id}": aliases must be an array`);
  rec.aliases = mergeAliases(rec.name, e.name, strings(patch.aliases));
  out.push(ordered(rec));
}

ADD.forEach((a, i) => {
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    errors.push(`overrides.add[${i}]: must be an object`);
    return;
  }
  const where = `overrides.add "${a.id ?? i}"`;
  for (const k of Object.keys(a)) {
    if (k !== 'id' && !k.startsWith('_') && !FIELDS.has(k)) errors.push(`${where}: unknown field "${k}"`);
  }
  for (const k of ['aliases', 'images', 'instructions', 'secondary']) {
    if (a[k] !== undefined && !Array.isArray(a[k])) errors.push(`${where}: ${k} must be an array`);
  }
  const rec = {
    ...a,
    name: String(a.name ?? '').trim(),
    secondary: Array.isArray(a.secondary) ? a.secondary : [],
    images: strings(a.images),
    instructions: clean(strings(a.instructions)),
  };
  checkSuffix(where, rec.name, a.equipment);
  rec.equipment = suffixEquipment(rec.name) ?? rec.equipment;
  rec.aliases = mergeAliases(rec.name, strings(a.aliases));
  if (!/^hv_[a-z0-9]+(_[a-z0-9]+)*$/.test(rec.id ?? '')) errors.push(`${where}: id must be snake_case with the "hv_" prefix`);
  if (srcIds.has(rec.id)) errors.push(`${where}: id collides with a dataset id`);
  out.push(ordered(rec));
});

// An alias that is another exercise's NAME would make search return the wrong exercise for that exact name.
// The dataset's own old name is dropped in that case (it now means something else); a curated alias is an error.
const nameOwner = new Map(out.map((r) => [r.name.toLowerCase(), r.id]));
const droppedOriginals = [];
for (const r of out) {
  if (!r.aliases?.length) continue;
  const original = ORIGINAL_NAME.get(r.id)?.toLowerCase();
  r.aliases = r.aliases.filter((alias) => {
    const owner = nameOwner.get(alias.toLowerCase());
    if (!owner || owner === r.id) return true;
    if (alias.toLowerCase() === original) {
      droppedOriginals.push(`${r.id}: old name "${alias}" is now ${owner}`);
      return false;
    }
    errors.push(`${r.id} "${r.name}": alias "${alias}" is the name of ${owner}; search would point at the wrong exercise`);
    return true;
  });
  if (!r.aliases.length) delete r.aliases;
}

out.sort((a, b) => a.name.localeCompare(b.name, 'en'));

// ------------------------------------------------------------------ validation

const ids = new Map();
const names = new Map();
for (const r of out) {
  const where = `${r.id} "${r.name}"`;
  if (ids.has(r.id)) errors.push(`duplicate id ${r.id}`);
  ids.set(r.id, r);
  const key = r.name.toLowerCase();
  if (!r.name) errors.push(`${r.id}: empty name`);
  if (names.has(key)) errors.push(`duplicate name "${r.name}" (${names.get(key)} and ${r.id})`);
  names.set(key, r.id);

  if (!EQUIPMENT.includes(r.equipment)) errors.push(`${where}: unknown equipment "${r.equipment}"`);
  if (!MUSCLES.includes(r.primary)) errors.push(`${where}: unknown primary muscle "${r.primary}"`);
  const secondary = Array.isArray(r.secondary) ? r.secondary : [];
  if (!Array.isArray(r.secondary)) errors.push(`${where}: secondary must be an array`);
  for (const m of secondary) if (!MUSCLES.includes(m)) errors.push(`${where}: unknown secondary muscle "${m}"`);
  if (new Set(secondary).size !== secondary.length) errors.push(`${where}: duplicate secondary muscles`);
  if (secondary.includes(r.primary)) errors.push(`${where}: primary repeated in secondary`);
  if (!EXERCISE_TYPES.includes(r.type)) errors.push(`${where}: unknown type "${r.type}"`);
  if (r.level !== undefined && !LEVELS.includes(r.level)) errors.push(`${where}: unknown level "${r.level}"`);
  if (r.mechanic !== undefined && !MECHANICS.includes(r.mechanic)) errors.push(`${where}: unknown mechanic "${r.mechanic}"`);
  if (r.force !== undefined && !FORCES.includes(r.force)) errors.push(`${where}: unknown force "${r.force}"`);

  const images = Array.isArray(r.images) ? r.images : [];
  if (!images.length) errors.push(`${where}: no images`);
  for (const p of images) {
    if (typeof p !== 'string' || !/^ex\/[^/]+\/[^/]+\.webp$/.test(p)) errors.push(`${where}: image path "${p}" must look like ex/<id>/<n>.webp`);
    else if (!existsSync(join(root, 'public', p))) errors.push(`${where}: image missing on disk: public/${p}`);
  }
  const instructions = Array.isArray(r.instructions) ? r.instructions : [];
  if (!instructions.length) errors.push(`${where}: no instructions`);
  if (instructions.some((s) => typeof s !== 'string' || !s.trim())) errors.push(`${where}: blank instruction line`);
  if (r.aliases !== undefined && (!Array.isArray(r.aliases) || r.aliases.some((a) => typeof a !== 'string' || !a.trim()))) {
    errors.push(`${where}: aliases must be non-empty strings`);
  }

  const cardio = r.primary === 'cardio' || r.equipment === 'cardio';
  if (cardio && !(r.met > 0)) errors.push(`${where}: cardio exercise without a MET value`);
  if (r.met != null && !(typeof r.met === 'number' && r.met > 0 && r.met < 25)) errors.push(`${where}: implausible MET ${r.met}`);
  if (r.met != null && !TIMED_TYPES.has(r.type)) {
    errors.push(`${where}: a MET needs a timed type (${[...TIMED_TYPES].join('/')}), not ${r.type}; calories.ts would count 0 kcal`);
  }

  if (/smith/i.test(r.name) && r.equipment !== 'smith_machine') errors.push(`${where}: "Smith" in name but equipment ${r.equipment}`);
  const label = SUFFIX_LABEL[r.equipment];
  if (label && !r.name.endsWith(`(${label})`)) errors.push(`${where}: equipment ${r.equipment} needs the "(${label})" suffix`);
  if (!label && suffixEquipment(r.name)) errors.push(`${where}: ${r.equipment} exercise must not carry an equipment suffix`);
  if (/\s{2,}|^\s|\s$/.test(r.name)) errors.push(`${where}: stray whitespace in name`);
}

if (errors.length) {
  console.error(`catalog: ${errors.length} problem(s)\n  - ` + errors.join('\n  - '));
  process.exit(1);
}

// One exercise per line keeps diffs reviewable while staying compact.
const outFile = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(root, 'src/data/catalog.json');
if (!CHECK_ONLY) {
  writeFileSync(outFile, '[\n' + out.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
}
for (const note of droppedOriginals) console.log(`  note: dropped alias - ${note}`);

const count = (key) => {
  const c = {};
  for (const r of out) c[r[key]] = (c[r[key]] ?? 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
};
const renamed = out.filter((r) => RENAME[r.id]).length;
console.log(
  `catalog: ${out.length} exercises (${out.length - ADD.length} from dataset, ${ADD.length} added, ` +
    `${renamed} curated names, ${EXCLUDE.size} excluded, ${droppedStretching} stretches/foam-roll dropped)`,
);
console.log(`  equipment: ${count('equipment')}`);
console.log(`  type:      ${count('type')}`);
