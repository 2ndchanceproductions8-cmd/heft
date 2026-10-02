import type { Exercise, RoutineExercise } from '../../types';
import { db } from '../../db';
import { createFolderLast, createRoutine, nextRoutineOrder } from '../../lib/routines';
import { blankRoutineSet, newEditorExercise } from './routineUtils';

/*
 * "Add starter routines" on the first-run Workout page: a classic Push / Pull / Legs split built from the
 * exercise library. Exercises are found BY NAME at runtime (each slot lists fallbacks), so a catalog rebuild
 * or a missing entry just skips that slot instead of crashing.
 */

interface Slot {
  /** Candidate names, best first. Matched case-insensitively against the original AND renamed name. */
  names: string[];
  reps: number;
  repsMax: number;
  restSec?: number;
}

interface Template {
  name: string;
  notes: string;
  slots: Slot[];
}

export const STARTER_TEMPLATES: Template[] = [
  {
    name: 'Push',
    notes: 'Chest, shoulders & triceps. Add weight once you hit the top of the rep range on every set.',
    slots: [
      { names: ['Barbell Bench Press - Medium Grip', 'Dumbbell Bench Press', 'Machine Bench Press'], reps: 6, repsMax: 10, restSec: 150 },
      { names: ['Incline Dumbbell Press', 'Smith Machine Incline Bench Press', 'Barbell Incline Bench Press - Medium Grip'], reps: 8, repsMax: 12, restSec: 120 },
      { names: ['Dumbbell Shoulder Press', 'Machine Shoulder (Military) Press', 'Barbell Shoulder Press'], reps: 8, repsMax: 12, restSec: 120 },
      { names: ['Side Lateral Raise', 'Cable Seated Lateral Raise'], reps: 12, repsMax: 15, restSec: 60 },
      { names: ['Triceps Pushdown - Rope Attachment', 'Triceps Pushdown'], reps: 10, repsMax: 15, restSec: 60 },
      { names: ['Cable Crossover', 'Butterfly', 'Dumbbell Flyes'], reps: 12, repsMax: 15, restSec: 60 },
    ],
  },
  {
    name: 'Pull',
    notes: 'Back & biceps. Control the lowering part of every rep.',
    slots: [
      { names: ['Wide-Grip Lat Pulldown', 'Close-Grip Front Lat Pulldown', 'Pullups'], reps: 8, repsMax: 12, restSec: 120 },
      { names: ['Bent Over Barbell Row', 'Bent Over Two-Dumbbell Row', 'Leverage Iso Row'], reps: 6, repsMax: 10, restSec: 150 },
      { names: ['Seated Cable Rows', 'Leverage High Row'], reps: 10, repsMax: 12, restSec: 90 },
      { names: ['Face Pull', 'Cable Rear Delt Fly', 'Reverse Machine Flyes'], reps: 12, repsMax: 15, restSec: 60 },
      { names: ['Barbell Curl', 'EZ-Bar Curl', 'Dumbbell Bicep Curl'], reps: 8, repsMax: 12, restSec: 60 },
      { names: ['Hammer Curls', 'Cable Hammer Curls - Rope Attachment'], reps: 10, repsMax: 12, restSec: 60 },
    ],
  },
  {
    name: 'Legs',
    notes: 'Quads, hamstrings, glutes & calves. Warm up with a couple of light squat sets first.',
    slots: [
      { names: ['Barbell Squat', 'Barbell Full Squat', 'Hack Squat', 'Goblet Squat'], reps: 6, repsMax: 10, restSec: 180 },
      { names: ['Romanian Deadlift', 'Stiff-Legged Dumbbell Deadlift'], reps: 8, repsMax: 10, restSec: 150 },
      { names: ['Leg Press', 'Narrow Stance Leg Press'], reps: 10, repsMax: 12, restSec: 120 },
      { names: ['Lying Leg Curls', 'Seated Leg Curl', 'Standing Leg Curl'], reps: 10, repsMax: 12, restSec: 90 },
      { names: ['Leg Extensions', 'Single-Leg Leg Extension'], reps: 12, repsMax: 15, restSec: 60 },
      { names: ['Standing Calf Raises', 'Seated Calf Raise', 'Smith Machine Calf Raise'], reps: 12, repsMax: 15, restSec: 60 },
    ],
  },
];

const key = (s: string) => s.trim().toLowerCase();

/** Build the starter routines' exercises from the resolved exercise list (pure; skips anything not found). */
export function buildStarterRoutines(list: Exercise[]): { name: string; notes: string; exercises: RoutineExercise[] }[] {
  const byName = new Map<string, Exercise>();
  for (const ex of list) {
    if (ex.hidden || ex.missing) continue;
    // Original catalog name first so a user rename never hides the canonical match.
    if (!byName.has(key(ex.originalName))) byName.set(key(ex.originalName), ex);
    if (!byName.has(key(ex.name))) byName.set(key(ex.name), ex);
  }
  // Fallback: old dataset names survive as aliases after the catalog's Hevy-style renames.
  for (const ex of list) {
    if (ex.hidden || ex.missing) continue;
    for (const a of ex.aliases) if (!byName.has(key(a))) byName.set(key(a), ex);
  }
  return STARTER_TEMPLATES.map((t) => {
    const used = new Set<string>();
    const exercises: RoutineExercise[] = [];
    for (const slot of t.slots) {
      const ex = slot.names.map((n) => byName.get(key(n))).find((e) => e && !used.has(e.id));
      if (!ex) continue;
      used.add(ex.id);
      const re = newEditorExercise(
        ex.id,
        Array.from({ length: 3 }, () => blankRoutineSet({ reps: slot.reps, repsMax: slot.repsMax })),
      );
      exercises.push({ ...re, restSec: slot.restSec ?? null });
    }
    return { name: t.name, notes: t.notes, exercises };
  }).filter((r) => r.exercises.length > 0);
}

/** Create the starter routines inside a "Starter" folder. Returns how many routines were created. */
export async function addStarterRoutines(list: Exercise[]): Promise<number> {
  const routines = buildStarterRoutines(list);
  if (!routines.length) return 0;
  // One transaction: all three routines (and the folder) appear together, or none do.
  return db.transaction('rw', db.folders, db.routines, async () => {
    const existing = (await db.folders.toArray()).find((f) => f.name.trim().toLowerCase() === 'starter');
    const folderId = existing?.id ?? (await createFolderLast('Starter'));
    if (existing?.collapsed) await db.folders.update(existing.id, { collapsed: false });
    let order = await nextRoutineOrder();
    for (const r of routines) {
      await createRoutine({ name: r.name, notes: r.notes, exercises: r.exercises, folderId, order: order++ });
    }
    return routines.length;
  });
}
