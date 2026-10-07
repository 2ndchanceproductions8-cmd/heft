// Domain model for Heft. ALL weights are stored in KILOGRAMS and all distances in METERS.
// Conversion to the user's display unit happens only at the UI edge (see lib/units.ts).

export type Unit = 'kg' | 'lb';
export type DistanceUnit = 'km' | 'mi';

export const EQUIPMENT = [
  'barbell',
  'dumbbell',
  'machine',
  'smith_machine',
  'cable',
  'kettlebell',
  'band',
  'ez_bar',
  'plate',
  'bodyweight',
  'cardio',
  'other',
] as const;
export type Equipment = (typeof EQUIPMENT)[number];

// Same muscle-group vocabulary Hevy uses.
export const MUSCLES = [
  'abdominals',
  'abductors',
  'adductors',
  'biceps',
  'calves',
  'cardio',
  'chest',
  'forearms',
  'full_body',
  'glutes',
  'hamstrings',
  'lats',
  'lower_back',
  'neck',
  'quadriceps',
  'shoulders',
  'traps',
  'triceps',
  'upper_back',
  'other',
] as const;
export type Muscle = (typeof MUSCLES)[number];

export const EXERCISE_TYPES = [
  'weight_reps', // 60 kg x 8
  'bodyweight_reps', // 12 reps
  'weighted_bodyweight', // +20 kg x 8 (dips, pull-ups with belt)
  'assisted_bodyweight', // -20 kg x 8 (assisted pull-up machine)
  'duration', // 1:00 (plank)
  'duration_weight', // 20 kg for 0:45 (weighted plank / carries by time)
  'distance_duration', // 5 km in 25:00 (treadmill, rower)
  'weight_distance', // 40 kg for 30 m (farmer's walk, sled)
] as const;
export type ExerciseType = (typeof EXERCISE_TYPES)[number];

/** A built-in exercise shipped in src/data/catalog.json (never mutated at runtime). */
export interface CatalogExercise {
  id: string;
  name: string;
  equipment: Equipment;
  primary: Muscle;
  secondary: Muscle[];
  type: ExerciseType;
  /** Image paths relative to the app base URL, e.g. "ex/Barbell_Squat/0.webp". Usually [start, end] frames. */
  images: string[];
  instructions: string[];
  aliases?: string[];
  level?: 'beginner' | 'intermediate' | 'expert';
  mechanic?: 'compound' | 'isolation';
  force?: 'push' | 'pull' | 'static';
  /** MET value used for calorie estimates of cardio exercises. */
  met?: number;
}

/** A user-created exercise — either fully custom, or a gym/brand variant of another exercise. */
export interface CustomExercise {
  id: string; // "c_<uid>"
  name: string;
  equipment: Equipment;
  primary: Muscle;
  secondary: Muscle[];
  type: ExerciseType;
  /** Base exercise id (catalog or custom) when this is a gym/brand variant. Variants keep their OWN history. */
  variantOf?: string | null;
  /** Machine brand / gym label for variants, e.g. "Hammer Strength". */
  brand?: string;
  /** User photos (media ids). If empty, a variant inherits the base exercise's images. */
  photoIds: string[];
  instructions?: string[];
  createdAt: number;
  archived?: boolean;
}

/** Per-exercise user overrides, keyed by exercise id (works for catalog AND custom exercises). */
export interface ExerciseOverride {
  id: string;
  /** Renamed display name (catalog exercises; custom exercises are renamed in place). */
  name?: string;
  /** User photos (media ids) shown instead of the catalog images. */
  photoIds?: string[];
  hidden?: boolean;
  /** Sticky note shown every time the exercise is added to a workout. */
  notes?: string;
  /** Default rest timer (seconds) for this exercise. 0 = off. Undefined = settings default. */
  restSec?: number;
  /**
   * Log left and right separately (single-arm / single-leg work). Undefined = the default: on for catalog
   * exercises named as one-sided (lib/sides.ts `defaultPerSide`), a variant follows its base, else off.
   */
  perSide?: boolean;
}

/** Resolved, display-ready exercise (catalog/custom + overrides merged). Produced by lib/exercises.ts. */
export interface Exercise {
  id: string;
  name: string; // display name (after rename)
  originalName: string; // catalog/canonical name before any rename
  equipment: Equipment;
  primary: Muscle;
  secondary: Muscle[];
  type: ExerciseType;
  /** Catalog image URLs (already prefixed with BASE_URL). Variants inherit their base's images. */
  images: string[];
  /** User photo media ids. When non-empty these are shown instead of `images`. */
  photoIds: string[];
  instructions: string[];
  source: 'catalog' | 'custom';
  variantOf?: string | null;
  brand?: string;
  notes?: string;
  restSec?: number;
  /** New sets are logged left and right separately (resolved from ExerciseOverride.perSide). */
  perSide: boolean;
  hidden?: boolean;
  aliases: string[];
  met?: number;
  level?: CatalogExercise['level'];
  mechanic?: CatalogExercise['mechanic'];
  /** True when the id could not be resolved (e.g. a deleted custom exercise referenced by old workouts). */
  missing?: boolean;
}

export type SetType = 'normal' | 'warmup' | 'failure' | 'drop';

/** A body side of a per-side set (single-arm / single-leg work). The lifter's own left and right. */
export type Side = 'left' | 'right';

/** One side's values in a per-side set (same units as SetEntry). */
export interface SideValues {
  weightKg?: number | null;
  reps?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
}

/** Left and right values of a per-side set. */
export interface SetSides {
  left: SideValues;
  right: SideValues;
}

/** Planned values for a set (from a routine or the previous session). Shown as grey placeholders. */
export interface SetTarget {
  weightKg?: number | null;
  reps?: number | null;
  repsMax?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  /** Per-side placeholders (last session's left and right). Missing = the plain values apply to each side. */
  sides?: SetSides | null;
}

export interface SetEntry {
  id: string;
  type: SetType;
  /**
   * Per-side sets (`sides` present): the top-level weight/reps/time/distance MIRROR the better side (lib/sides.ts
   * `syncSideSet`), so code that reads a set as one value sees its strongest side. `sides` is the source of truth:
   * totals (volume, reps) add both sides, records take the better side (lib/calc.ts `setLimbs`).
   */
  weightKg?: number | null;
  reps?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  /** Left and right values of a single-arm / single-leg set. Missing = a plain (both sides together) set. */
  sides?: SetSides | null;
  rpe?: number | null;
  /** Ticked off. Saved workouts only contain done sets. */
  done: boolean;
  /**
   * ACTIVE WORKOUT ONLY: the placeholder values. Ticking a set whose inputs are empty copies the target in
   * (Hevy behaviour). Stripped when the workout is saved.
   */
  target?: SetTarget | null;
}

export interface WorkoutExercise {
  id: string; // instance id (unique within the workout)
  exerciseId: string;
  notes?: string;
  /** Rest timer for this exercise in this workout. null/undefined = exercise/settings default, 0 = off. */
  restSec?: number | null;
  /** Exercises sharing a supersetId are performed back-to-back. */
  supersetId?: string | null;
  /**
   * The routine slot (`RoutineExercise.id`) this exercise was started from: set when the workout starts from a
   * routine or a routine exercise is picked in the logger, kept through Replace / machine-variant switches (a
   * split-off card keeps it too) and saved with the workout. "Update routine" pairs logged exercises with
   * routine slots by this link first (then by exerciseId), so a swapped variant REPLACES its slot's exercise
   * instead of being appended. null/missing = not from a routine (older data has none).
   */
  routineExerciseId?: string | null;
  sets: SetEntry[];
}

export type PRKind =
  | 'heaviest_weight'
  | 'best_1rm'
  | 'best_set_volume'
  | 'most_reps'
  | 'longest_duration'
  | 'longest_distance';

export interface PRRecord {
  exerciseId: string;
  workoutExerciseId: string;
  setId: string;
  kind: PRKind;
  value: number; // kg, reps, seconds or meters depending on kind
  /** Set by a per-side set: the side that set the record. */
  side?: Side;
}

export interface Workout {
  id: string;
  name: string;
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms
  durationSec: number;
  notes?: string;
  routineId?: string | null;
  exercises: WorkoutExercise[];
  /** Denormalized for the multiEntry index (history per exercise). */
  exerciseIds: string[];
  photoIds: string[];
  /** Body weight snapshot used for calories (kg). */
  bodyweightKg?: number | null;
  calories?: number | null;
  /** True when the user typed calories in (e.g. from a watch) instead of using the estimate. */
  caloriesManual?: boolean;
  volumeKg: number;
  setCount: number;
  /** Personal records set in this workout (recomputed chronologically whenever history changes). */
  prs: PRRecord[];
  /** When this workout was last handed to Apple Health (via the "Heft to Health" Shortcut). */
  healthSentAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RestTimerState {
  endsAt: number; // epoch ms
  totalSec: number;
  workoutExerciseId: string;
  setId: string;
}

/** The in-progress workout. Persisted in db.active under id "current" so it survives app restarts. */
export interface ActiveWorkout {
  id: string; // becomes the saved Workout id
  name: string;
  startedAt: number;
  notes?: string;
  routineId?: string | null;
  exercises: WorkoutExercise[];
  rest?: RestTimerState | null;
}

export interface RoutineSet {
  id: string;
  type: SetType;
  weightKg?: number | null;
  reps?: number | null;
  /** Optional rep-range upper bound (reps = lower bound), e.g. 8–12. */
  repsMax?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
}

export interface RoutineExercise {
  id: string;
  exerciseId: string;
  notes?: string;
  restSec?: number | null;
  supersetId?: string | null;
  sets: RoutineSet[];
}

export interface Routine {
  id: string;
  name: string;
  folderId: string | null;
  order: number;
  notes?: string;
  exercises: RoutineExercise[];
  createdAt: number;
  updatedAt: number;
  lastPerformedAt?: number | null;
}

export interface RoutineFolder {
  id: string;
  name: string;
  order: number;
  collapsed?: boolean;
}

export interface Measurement {
  id: string;
  date: number; // epoch ms
  bodyweightKg?: number | null;
  bodyFatPct?: number | null;
  waistCm?: number | null;
  chestCm?: number | null;
  armCm?: number | null;
  thighCm?: number | null;
  hipsCm?: number | null;
  neckCm?: number | null;
  photoIds: string[];
  notes?: string;
  /**
   * Where the entry came from: 'health' = imported from Apple Health (lib/healthImport.ts, id "hk_<sample ms>"),
   * 'manual' (or missing, older data) = typed in Heft. Any user edit of a 'health' row makes it 'manual', and an
   * import never overwrites a manual row.
   */
  source?: 'manual' | 'health';
  /** Imported rows: epoch ms of the Apple Health sample the row was created from (its anchor weigh-in). */
  healthAt?: number;
}

export interface Media {
  id: string;
  blob: Blob;
  type: string;
  createdAt: number;
  width?: number;
  height?: number;
}

export interface Settings {
  id: 'settings';
  unit: Unit;
  distanceUnit: DistanceUnit;
  /**
   * Body weight (kg) the user typed into their profile. Calories use `currentBodyweightKg()`: this value or
   * the newest weigh-in, whichever is newer (compared with `bodyweightUpdatedAt`).
   */
  bodyweightKg: number | null;
  /** Epoch ms when `bodyweightKg` was last set by hand. Missing (older data) counts as 0. */
  bodyweightUpdatedAt?: number | null;
  heightCm: number | null;
  sex: 'male' | 'female' | null;
  birthYear: number | null;
  /** Default rest timer in seconds (0 = off). */
  defaultRestSec: number;
  restTimerSound: boolean;
  restTimerVibrate: boolean;
  keepAwake: boolean;
  theme: 'dark' | 'light' | 'system';
  weekStartsOn: 0 | 1;
  /** Which past values fill the PREVIOUS column: last time you did the exercise anywhere, or last time in the same routine. */
  previousValues: 'any' | 'same_routine';
  showRpe: boolean;
  /** Empty barbell weight in kg for the plate calculator. */
  barKg: number;
  /** The "Heft to Health" Shortcut is set up: show "Send to Apple Health" on workouts. */
  appleHealth: boolean;
  /**
   * The newest Apple Health sample Heft holds (epoch ms), for "last weigh-in from Hume" displays. Since every weigh-in
   * became its own row (2026-10-06) it no longer decides what an import may add: `healthDeleted` does.
   */
  healthImportedThrough?: number | null;
  /** Epoch ms of the last saved Apple Health import (null = never). */
  healthImportedAt?: number | null;
  /**
   * Imported weigh-ins the user deleted in Heft (their Apple Health sample time, epoch ms): an import never brings
   * one back: the deleted sample itself (to the second), or its body fat arriving alone within 10 minutes, unless the
   * user asks to bring deleted weigh-ins back. Written by lib/healthImport.ts deleteMeasurement().
   */
  healthDeleted?: number[];
}
