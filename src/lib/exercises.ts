import catalogData from '../data/catalog.json';
import { db } from '../db';
import type {
  CatalogExercise,
  CustomExercise,
  Equipment,
  Exercise,
  ExerciseOverride,
  ExerciseType,
  Muscle,
} from '../types';
import { EQUIPMENT_LABEL, MUSCLE_LABEL } from './exerciseMeta';
import { uid } from './ids';

export const CATALOG = catalogData as CatalogExercise[];
export const CATALOG_BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

/** Prefix a public/ asset path with the app base URL. */
export function assetUrl(path: string): string {
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  const base = import.meta.env.BASE_URL || '/';
  return base.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
}

export interface ExerciseIndex {
  /** Every resolvable exercise (catalog + custom, archived customs excluded). */
  list: Exercise[];
  byId: Map<string, Exercise>;
  /** Always returns an Exercise — a "missing" placeholder for unknown ids so old history still renders. */
  get(id: string): Exercise;
}

function missingExercise(id: string, loading = false): Exercise {
  const name = loading ? '…' : 'Deleted exercise';
  return {
    id,
    name,
    originalName: name,
    equipment: 'other',
    primary: 'other',
    secondary: [],
    type: 'weight_reps',
    images: [],
    photoIds: [],
    instructions: [],
    source: 'custom',
    aliases: [],
    missing: true,
  };
}

export function buildExerciseIndex(
  custom: CustomExercise[],
  overrides: ExerciseOverride[],
  opts: { loading?: boolean } = {},
): ExerciseIndex {
  const ovr = new Map(overrides.map((o) => [o.id, o]));
  const customById = new Map(custom.map((c) => [c.id, c]));
  const byId = new Map<string, Exercise>();

  const resolveCatalog = (c: CatalogExercise): Exercise => {
    const o = ovr.get(c.id);
    return {
      id: c.id,
      name: o?.name?.trim() || c.name,
      originalName: c.name,
      equipment: c.equipment,
      primary: c.primary,
      secondary: c.secondary,
      type: c.type,
      images: c.images.map(assetUrl),
      photoIds: o?.photoIds ?? [],
      instructions: c.instructions,
      source: 'catalog',
      notes: o?.notes,
      restSec: o?.restSec,
      hidden: o?.hidden,
      aliases: c.aliases ?? [],
      met: c.met,
      level: c.level,
      mechanic: c.mechanic,
    };
  };

  const resolving = new Set<string>();
  const resolveCustom = (c: CustomExercise): Exercise => {
    const cached = byId.get(c.id);
    if (cached) return cached;
    resolving.add(c.id);
    let base: Exercise | undefined;
    if (c.variantOf && !resolving.has(c.variantOf)) {
      const cat = CATALOG_BY_ID.get(c.variantOf);
      const cus = customById.get(c.variantOf);
      base = byId.get(c.variantOf) ?? (cat ? resolveCatalog(cat) : cus ? resolveCustom(cus) : undefined);
    }
    resolving.delete(c.id);
    const o = ovr.get(c.id);
    const ex: Exercise = {
      id: c.id,
      name: c.name,
      originalName: c.name,
      equipment: c.equipment,
      primary: c.primary,
      secondary: c.secondary,
      type: c.type,
      images: base?.images ?? [],
      photoIds: c.photoIds?.length ? c.photoIds : base?.photoIds ?? [],
      instructions: c.instructions?.length ? c.instructions : base?.instructions ?? [],
      source: 'custom',
      variantOf: c.variantOf ?? null,
      brand: c.brand,
      notes: o?.notes,
      restSec: o?.restSec,
      hidden: o?.hidden || c.archived,
      aliases: base ? [base.name, ...base.aliases] : [],
      met: base?.met,
      level: base?.level,
      mechanic: base?.mechanic,
    };
    byId.set(c.id, ex);
    return ex;
  };

  for (const c of CATALOG) byId.set(c.id, resolveCatalog(c));
  for (const c of custom) resolveCustom(c);

  const list = [...byId.values()].filter((e) => !(e.source === 'custom' && customById.get(e.id)?.archived));
  return {
    list,
    byId,
    get: (id: string) => byId.get(id) ?? missingExercise(id, opts.loading),
  };
}

// ---------------------------------------------------------------- search

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[()\-–—_/,.'’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface ExerciseFilter {
  equipment?: Equipment | null;
  muscle?: Muscle | null;
  includeHidden?: boolean;
}

/** Popular equipment wins ties ("Bench Press (Barbell)" before "Bench Press (Band)"). */
const EQUIPMENT_PRIORITY: Record<Equipment, number> = {
  barbell: 3,
  dumbbell: 2.8,
  machine: 2.6,
  cable: 2.5,
  smith_machine: 2.4,
  bodyweight: 2.2,
  ez_bar: 2,
  kettlebell: 1.8,
  cardio: 1.8,
  plate: 1,
  band: 0.5,
  other: 0,
};

const words = (s: string) => (s ? s.split(' ') : []);
/** Every query token must start some word ("rdl" must not match "hurdle"). */
const tokensMatch = (tokens: string[], ws: string[]) => tokens.every((t) => ws.some((w) => w.startsWith(t)));
/** Query appears as a phrase starting at a word boundary. */
const phraseAt = (text: string, q: string) => text === q || text.startsWith(q) || text.includes(' ' + q);

/**
 * Search over name, aliases, brand, equipment and muscles. Tokens match word starts; exact/prefix
 * matches on the name (then aliases) rank highest; popular equipment breaks ties.
 */
export function searchExercises(list: Exercise[], query: string, filter: ExerciseFilter = {}): Exercise[] {
  const q = norm(query);
  const tokens = words(q);
  const out: { ex: Exercise; score: number }[] = [];
  for (const ex of list) {
    if (!filter.includeHidden && ex.hidden) continue;
    if (filter.equipment && ex.equipment !== filter.equipment) continue;
    if (filter.muscle && ex.primary !== filter.muscle && !ex.secondary.includes(filter.muscle)) continue;
    if (!tokens.length) {
      out.push({ ex, score: filter.muscle && ex.primary === filter.muscle ? 1 : 0 });
      continue;
    }
    const name = norm(ex.name);
    const aliases = [norm(ex.originalName), ...ex.aliases.map(norm)].filter((a) => a && a !== name);
    const meta = [
      norm(ex.brand ?? ''),
      norm(EQUIPMENT_LABEL[ex.equipment]),
      norm(MUSCLE_LABEL[ex.primary]),
      ...ex.secondary.map((m) => norm(MUSCLE_LABEL[m])),
    ].join(' ');
    const nameWords = words(name);
    const allWords = [...nameWords, ...aliases.flatMap(words), ...words(meta)];
    if (!tokensMatch(tokens, allWords)) continue;

    let score = 1;
    if (name === q) score += 100;
    else if (name.startsWith(q)) score += 60;
    else if (phraseAt(name, q)) score += 30;
    let aliasBest = 0;
    for (const a of aliases) {
      if (a === q) aliasBest = Math.max(aliasBest, 80);
      else if (a.startsWith(q)) aliasBest = Math.max(aliasBest, 45);
      else if (phraseAt(a, q)) aliasBest = Math.max(aliasBest, 20);
      else if (tokensMatch(tokens, words(a))) aliasBest = Math.max(aliasBest, 10);
    }
    score += aliasBest;
    score += tokens.filter((t) => nameWords.some((w) => w.startsWith(t))).length * 6;
    score += EQUIPMENT_PRIORITY[ex.equipment] ?? 0;
    score -= name.length / 100; // prefer shorter, more canonical names
    out.push({ ex, score });
  }
  out.sort((a, b) => b.score - a.score || a.ex.name.localeCompare(b.ex.name));
  return out.map((o) => o.ex);
}

// ---------------------------------------------------------------- variants

/** Root exercise of a variant chain (the exercise all brand variants derive from). */
export function variantRoot(index: ExerciseIndex, id: string): Exercise {
  let ex = index.get(id);
  const seen = new Set<string>();
  while (ex.variantOf && !seen.has(ex.id)) {
    seen.add(ex.id);
    const next = index.byId.get(ex.variantOf);
    if (!next) break;
    ex = next;
  }
  return ex;
}

/** The root exercise plus every gym/brand variant derived from it (root first). */
export function variantFamily(index: ExerciseIndex, id: string): Exercise[] {
  const root = variantRoot(index, id);
  const fam = index.list.filter((e) => e.id !== root.id && variantRoot(index, e.id).id === root.id);
  fam.sort((a, b) => a.name.localeCompare(b.name));
  return [root, ...fam];
}

// ---------------------------------------------------------------- mutations

const isCustomId = (id: string) => id.startsWith('c_');

async function patchOverride(id: string, patch: Partial<ExerciseOverride>) {
  await db.transaction('rw', db.overrides, async () => {
    const cur = (await db.overrides.get(id)) ?? { id };
    const next: ExerciseOverride = { ...cur, ...patch, id };
    for (const k of Object.keys(next) as (keyof ExerciseOverride)[]) {
      if (next[k] === undefined) delete next[k];
    }
    if (Object.keys(next).length === 1) await db.overrides.delete(id);
    else await db.overrides.put(next);
  });
}

/** Rename any exercise. Catalog exercises keep their original name underneath; pass '' to reset. */
export async function renameExercise(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (isCustomId(id)) {
    if (!clean) return;
    await db.customExercises.update(id, { name: clean });
  } else {
    const original = CATALOG_BY_ID.get(id)?.name;
    await patchOverride(id, { name: clean && clean !== original ? clean : undefined });
  }
}

export interface NewExerciseInput {
  name: string;
  equipment: Equipment;
  primary: Muscle;
  secondary?: Muscle[];
  type: ExerciseType;
  photoIds?: string[];
  instructions?: string[];
  variantOf?: string | null;
  brand?: string;
}

export async function createCustomExercise(input: NewExerciseInput): Promise<string> {
  const id = 'c_' + uid();
  const rec: CustomExercise = {
    id,
    name: input.name.trim() || 'Custom Exercise',
    equipment: input.equipment,
    primary: input.primary,
    secondary: input.secondary ?? [],
    type: input.type,
    photoIds: input.photoIds ?? [],
    instructions: input.instructions,
    variantOf: input.variantOf ?? null,
    brand: input.brand?.trim() || undefined,
    createdAt: Date.now(),
  };
  await db.customExercises.add(rec);
  return id;
}

/** Default display name for a gym/brand variant, e.g. "Lat Pulldown (Cable) – Hammer Strength". */
export function variantName(baseName: string, brand: string): string {
  return `${baseName} – ${brand.trim()}`;
}

/**
 * Create a gym/brand variant of an exercise (e.g. the OTHER lat pulldown machine). It copies the base
 * exercise's equipment, muscles and type, inherits its pictures, but keeps a completely separate history
 * so weights from different machines never mix.
 */
export async function createVariant(base: Exercise, brand: string, name?: string): Promise<string> {
  return createCustomExercise({
    name: name?.trim() || variantName(base.name, brand),
    equipment: base.equipment,
    primary: base.primary,
    secondary: base.secondary,
    type: base.type,
    variantOf: base.id,
    brand,
  });
}

export async function updateCustomExercise(
  id: string,
  patch: Partial<Omit<CustomExercise, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.customExercises.update(id, patch);
}

/** Where a custom exercise is still referenced (what decides delete vs archive). */
export interface ExerciseUsage {
  /** Saved workouts that logged it. */
  workouts: number;
  /** Routines that plan it. */
  routines: number;
  /** In the workout in progress. */
  activeWorkout: boolean;
  /** Custom exercises that are gym/brand variants of it. */
  variants: number;
}

/** True when deleting would break something, so `deleteCustomExercise` archives instead. */
export const exerciseInUse = (u: ExerciseUsage): boolean =>
  u.workouts > 0 || u.routines > 0 || u.activeWorkout || u.variants > 0;

/**
 * Is it in the workout in progress? Lets the logger's latest change (adding or swapping to this exercise)
 * reach IndexedDB first, and also checks the in-memory workout in case persisting it failed. Imported
 * lazily: workoutStore imports this module (through workouts.ts).
 */
async function usedInMemoryActive(id: string): Promise<boolean> {
  try {
    const store = await import('./workoutStore');
    await store.flushActiveWorkout();
    return !!store.useWorkoutStore.getState().active?.exercises.some((e) => e.exerciseId === id);
  } catch {
    return false; // store unavailable — db.active still covers the persisted workout
  }
}

/** The DB part of the usage check (runs inside deleteCustomExercise's transaction). */
async function readUsage(id: string, inMemoryActive: boolean): Promise<ExerciseUsage> {
  const workouts = await db.workouts.where('exerciseIds').equals(id).count();
  const routines = (await db.routines.toArray()).filter((r) => r.exercises.some((e) => e.exerciseId === id)).length;
  const active = await db.active.get('current');
  const activeWorkout = inMemoryActive || !!active?.workout.exercises.some((e) => e.exerciseId === id);
  const variants = await db.customExercises.where('variantOf').equals(id).count();
  return { workouts, routines, activeWorkout, variants };
}

/** Where a custom exercise is used - e.g. so a delete confirmation can say it will be archived instead. */
export async function exerciseUsage(id: string): Promise<ExerciseUsage> {
  return readUsage(id, await usedInMemoryActive(id));
}

/**
 * Deletes a custom exercise if nothing refers to it; otherwise archives it (hidden from the library but
 * still resolvable by id). It counts as used (`exerciseUsage`) when it is logged in a saved workout, planned
 * in a routine, in the workout in progress, or the base of another custom exercise — variants inherit its
 * pictures, steps and aliases, and `variantFamily` groups them through it (archived variants included, their
 * history still renders).
 */
export async function deleteCustomExercise(id: string): Promise<'deleted' | 'archived'> {
  const inMemoryActive = await usedInMemoryActive(id);
  // Check and delete in one transaction so nothing can start using it in between.
  return db.transaction(
    'rw',
    [db.workouts, db.routines, db.active, db.customExercises, db.overrides, db.media],
    async (): Promise<'deleted' | 'archived'> => {
      if (exerciseInUse(await readUsage(id, inMemoryActive))) {
        await db.customExercises.update(id, { archived: true });
        return 'archived';
      }
      const rec = await db.customExercises.get(id);
      if (rec?.photoIds?.length) await db.media.bulkDelete(rec.photoIds);
      await db.customExercises.delete(id);
      await db.overrides.delete(id);
      return 'deleted';
    },
  );
}

/** Replace the pictures for an exercise with the user's own photos (e.g. of the exact machine at their gym). */
export async function setExercisePhotos(id: string, photoIds: string[]): Promise<void> {
  if (isCustomId(id)) await db.customExercises.update(id, { photoIds });
  else await patchOverride(id, { photoIds: photoIds.length ? photoIds : undefined });
}

export async function setExerciseRest(id: string, restSec: number | undefined): Promise<void> {
  await patchOverride(id, { restSec });
}

export async function setExerciseNote(id: string, notes: string): Promise<void> {
  await patchOverride(id, { notes: notes.trim() || undefined });
}

export async function setExerciseHidden(id: string, hidden: boolean): Promise<void> {
  await patchOverride(id, { hidden: hidden || undefined });
}
