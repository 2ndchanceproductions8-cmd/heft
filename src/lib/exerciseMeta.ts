import type { Equipment, ExerciseType, Muscle, SetType } from '../types';

export const EQUIPMENT_LABEL: Record<Equipment, string> = {
  barbell: 'Barbell',
  dumbbell: 'Dumbbell',
  machine: 'Machine',
  smith_machine: 'Smith Machine',
  cable: 'Cable',
  kettlebell: 'Kettlebell',
  band: 'Resistance Band',
  ez_bar: 'EZ Bar',
  plate: 'Plate',
  bodyweight: 'Bodyweight',
  cardio: 'Cardio',
  other: 'Other',
};

export const MUSCLE_LABEL: Record<Muscle, string> = {
  abdominals: 'Abdominals',
  abductors: 'Abductors',
  adductors: 'Adductors',
  biceps: 'Biceps',
  calves: 'Calves',
  cardio: 'Cardio',
  chest: 'Chest',
  forearms: 'Forearms',
  full_body: 'Full Body',
  glutes: 'Glutes',
  hamstrings: 'Hamstrings',
  lats: 'Lats',
  lower_back: 'Lower Back',
  neck: 'Neck',
  quadriceps: 'Quadriceps',
  shoulders: 'Shoulders',
  traps: 'Traps',
  triceps: 'Triceps',
  upper_back: 'Upper Back',
  other: 'Other',
};

export const EXERCISE_TYPE_LABEL: Record<ExerciseType, string> = {
  weight_reps: 'Weight & Reps',
  bodyweight_reps: 'Bodyweight Reps',
  weighted_bodyweight: 'Weighted Bodyweight',
  assisted_bodyweight: 'Assisted Bodyweight',
  duration: 'Duration',
  duration_weight: 'Duration & Weight',
  distance_duration: 'Distance & Duration',
  weight_distance: 'Weight & Distance',
};

export const EXERCISE_TYPE_EXAMPLE: Record<ExerciseType, string> = {
  weight_reps: 'Bench Press, Lat Pulldown',
  bodyweight_reps: 'Push Ups, Sit Ups',
  weighted_bodyweight: 'Weighted Pull Ups, Weighted Dips',
  assisted_bodyweight: 'Assisted Pull Ups, Assisted Dips',
  duration: 'Plank, Wall Sit',
  duration_weight: 'Weighted Plank, Dead Hang with Weight',
  distance_duration: 'Running, Rowing, Cycling',
  weight_distance: "Farmer's Walk, Sled Push",
};

export const SET_TYPE_LABEL: Record<SetType, string> = {
  normal: 'Normal Set',
  warmup: 'Warm Up Set',
  failure: 'Failure Set',
  drop: 'Drop Set',
};
/** Short badge letter shown instead of the set number. */
export const SET_TYPE_SHORT: Record<SetType, string> = { normal: '', warmup: 'W', failure: 'F', drop: 'D' };

/**
 * THE set-numbering rule, used by every set table (workout logger, routine editor/detail, workout history,
 * exercise history) so "set 4" while logging is "set 4" everywhere: warm-ups show "W" and are not counted;
 * every other set takes the next number, with failure / drop sets showing "F" / "D" in its place.
 * [W, normal, normal, F, D, normal] -> ["W", "1", "2", "F", "D", "5"].
 */
export function setNumberLabels(sets: readonly { type: SetType }[]): string[] {
  let n = 0;
  return sets.map((s) => {
    if (s.type === 'warmup') return SET_TYPE_SHORT.warmup;
    n += 1;
    return s.type === 'normal' ? String(n) : SET_TYPE_SHORT[s.type] || String(n);
  });
}

export interface TypeFields {
  weight: boolean;
  reps: boolean;
  duration: boolean;
  distance: boolean;
  /** Prefix for the weight column header: '' | '+' | '-' (assisted shows the assistance as negative). */
  weightSign: '' | '+' | '-';
}

export function typeFields(type: ExerciseType): TypeFields {
  switch (type) {
    case 'weight_reps':
      return { weight: true, reps: true, duration: false, distance: false, weightSign: '' };
    case 'bodyweight_reps':
      return { weight: false, reps: true, duration: false, distance: false, weightSign: '' };
    case 'weighted_bodyweight':
      return { weight: true, reps: true, duration: false, distance: false, weightSign: '+' };
    case 'assisted_bodyweight':
      return { weight: true, reps: true, duration: false, distance: false, weightSign: '-' };
    case 'duration':
      return { weight: false, reps: false, duration: true, distance: false, weightSign: '' };
    case 'duration_weight':
      return { weight: true, reps: false, duration: true, distance: false, weightSign: '' };
    case 'distance_duration':
      return { weight: false, reps: false, duration: true, distance: true, weightSign: '' };
    case 'weight_distance':
      return { weight: true, reps: false, duration: false, distance: true, weightSign: '' };
  }
}

/** Equipment filter chips, in the order shown in the exercise picker. */
export const EQUIPMENT_FILTERS: Equipment[] = [
  'barbell',
  'dumbbell',
  'machine',
  'smith_machine',
  'cable',
  'kettlebell',
  'ez_bar',
  'plate',
  'band',
  'bodyweight',
  'cardio',
  'other',
];

/** Muscle filter chips, in the order shown in the exercise picker. */
export const MUSCLE_FILTERS: Muscle[] = [
  'chest',
  'shoulders',
  'triceps',
  'biceps',
  'forearms',
  'lats',
  'upper_back',
  'traps',
  'lower_back',
  'abdominals',
  'quadriceps',
  'hamstrings',
  'glutes',
  'calves',
  'adductors',
  'abductors',
  'neck',
  'cardio',
  'full_body',
  'other',
];
