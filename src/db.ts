import Dexie, { type EntityTable } from 'dexie';
import type {
  ActiveWorkout,
  CustomExercise,
  ExerciseOverride,
  Measurement,
  Media,
  Routine,
  RoutineFolder,
  Settings,
  Workout,
} from './types';
import type { AiSpendRow, Food, Meal, NutritionProfile } from './lib/nutrition/types';

export interface ActiveRecord {
  id: 'current';
  workout: ActiveWorkout;
}

export class HeftDB extends Dexie {
  workouts!: EntityTable<Workout, 'id'>;
  routines!: EntityTable<Routine, 'id'>;
  folders!: EntityTable<RoutineFolder, 'id'>;
  customExercises!: EntityTable<CustomExercise, 'id'>;
  overrides!: EntityTable<ExerciseOverride, 'id'>;
  measurements!: EntityTable<Measurement, 'id'>;
  media!: EntityTable<Media, 'id'>;
  settings!: EntityTable<Settings, 'id'>;
  active!: EntityTable<ActiveRecord, 'id'>;
  // v2 — Food tab (lib/nutrition)
  meals!: EntityTable<Meal, 'id'>;
  foods!: EntityTable<Food, 'id'>;
  nutrition!: EntityTable<NutritionProfile, 'id'>;
  aiSpend!: EntityTable<AiSpendRow, 'id'>;

  constructor(name = 'heft') {
    super(name);
    this.version(1).stores({
      workouts: 'id, startedAt, *exerciseIds, routineId',
      routines: 'id, folderId, order',
      folders: 'id, order',
      customExercises: 'id, name, variantOf',
      overrides: 'id',
      measurements: 'id, date',
      media: 'id',
      settings: 'id',
      active: 'id',
    });
    // v2 adds the Food tab's tables. Dexie keeps every v1 table and its rows; only new stores are created.
    this.version(2).stores({
      meals: 'id, day, at, status',
      foods: 'id, barcode, lastUsedAt',
      nutrition: 'id',
      aiSpend: 'id, at, mealId',
    });
  }
}

export const db = new HeftDB();

// Ask the browser not to evict our data (important on iOS Safari for home-screen apps).
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* ignore */
  }
  return false;
}
