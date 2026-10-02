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
