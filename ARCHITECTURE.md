# Heft — architecture & build contract

Heft is a personal, offline-first **Hevy-style workout tracker** (no social features) built as an
installable PWA for the owner's phone (iPhone/Android, ~375–430px wide). Everything lives on-device in
IndexedDB. Stack: React 19 + TypeScript (strict) + Vite 8 + Tailwind v4 + Dexie 4 (`useLiveQuery`) +
Zustand 5 + React Router 7 (hash router) + Recharts 3 + lucide-react icons + date-fns 4 + @dnd-kit.

Run: `npm run dev` (port 5180). Typecheck: `npx tsc --noEmit`. Tests: `npx vitest run` (node env;
`fake-indexeddb` is installed — `import 'fake-indexeddb/auto'` at the top of a test touching Dexie).

## What the owner asked for (the product thesis)
1. Track workouts: sets, weights, reps, **time** (workout duration + rest timer) and **calories burned**.
2. **Routines**: create a routine, pick its exercises from a big library — barbell, dumbbell, machine,
   cable, **Smith machine**, kettlebell, bands, bodyweight, cardio.
3. **Rename exercises.** Real case: the gym has two brands of lat-pulldown machine with different weight
   stacks. He must be able to rename an exercise, AND (our improvement) create a **gym/brand variant**
   ("Lat Pulldown (Cable) – Hammer Strength") that keeps its OWN history so weights never mix, and switch
   to it mid-workout.
4. **Start an empty workout** and add exercises as he goes. The Add-Exercise list lets him pick either a
   **new exercise from the library** or **from one of his routines** (bringing that routine's planned sets).
5. **Track progress** with charts and a **muscle map** (body heat map of muscles trained).
6. Every exercise shows **pictures** like Hevy (start/end frames that cross-fade = animation; or his own
   photo of the actual machine).

## Data model — `src/types.ts` (read it)
- **Weights are ALWAYS stored in kg, distances in meters, durations in seconds, timestamps in epoch ms.**
  Convert only at the UI edge with `src/lib/units.ts` (`displayWeight`, `unitToKg`, `formatWeight`,
  `formatVolume`, `displayDistance`, `unitToMeters`, `formatDistance`, `formatDuration`, `formatClock`).
  **Weight & Distance exercises (carries, sleds) use yd (mi users) / m (km users)**, never mi/km: always go
  through `distanceUnitForType(type, unit)`, `displayDistanceAny` (m/yd to 0.1), `anyToMeters`,
  `formatDistanceForType(m, type, unit)` when a distance is shown or entered.
- `CatalogExercise` (static JSON `src/data/catalog.json`, ~800) + `CustomExercise` (Dexie, id `c_…`,
  `variantOf` for gym/brand variants) + `ExerciseOverride` (Dexie, per-id rename/photo/notes/rest/hidden)
  ⇒ resolved `Exercise` objects. ALWAYS display `exercise.name` (it already includes renames).
- `Workout` (saved; only completed sets; `prs`, `volumeKg`, `setCount`, `calories` derived),
  `ActiveWorkout` (in progress; sets have `done` flags and optional `target` placeholders).
  `WorkoutExercise.routineExerciseId` links a logged exercise to the routine slot it came from (set by
  `startFromRoutine` and routine picks, kept through Replace / variant switches / splits, saved with the
  workout); "Update routine" pairs by it first, so a swapped variant replaces its slot's exercise.
  `Routine` / `RoutineFolder`, `Measurement`, `Media` (photo blobs), `Settings`.
- `ExerciseType` decides which columns a set has — use `typeFields(type)` from `lib/exerciseMeta.ts`
  (weight/reps/duration/distance + weight sign "+" weighted, "-" assisted).

## Foundation APIs (do not re-implement; import these)
| Module | Exports |
|---|---|
| `src/db.ts` | `db` (Dexie tables: workouts, routines, folders, customExercises, overrides, measurements, media, settings, active) |
| `lib/units.ts` | unit conversion + formatting + `parseDecimal`, `parseClock` (bare digits = seconds, for prompts), `round`; time cells: `clockDigits`/`formatClockDigits`/`digitsToSeconds`/`parseTimeEntry` (digits fill m:ss from the right: "130" = 1:30) |
| `lib/exerciseMeta.ts` | `EQUIPMENT_LABEL`, `MUSCLE_LABEL`, `EXERCISE_TYPE_LABEL`, `EXERCISE_TYPE_EXAMPLE`, `SET_TYPE_LABEL`, `SET_TYPE_SHORT`, `setNumberLabels(sets)` (THE set-number rule: W not counted, F/D take a number), `typeFields`, `EQUIPMENT_FILTERS`, `MUSCLE_FILTERS` |
| `lib/rest.ts` | THE rest-timer vocabulary: `REST_OPTIONS` (Off, 5s … 5:00), `restOptionLabel(sec)` ("Off", "45s", "1:30"), `restSettingLabel(sec, defaultSec)` ("Default (1:30)"), `restOptionsWith(current)` |
| `lib/useWakeNow.ts` | `useWakeNow()` — Date.now() refreshed when the app returns to the foreground |
| `lib/exercises.ts` | `CATALOG`, `assetUrl`, `buildExerciseIndex`, `searchExercises(list, query, {equipment, muscle})`, `variantRoot`, `variantFamily`, `renameExercise(id, name)` ('' resets), `createCustomExercise`, `createVariant(base, brand, name?)`, `variantName`, `updateCustomExercise`, `exerciseUsage(id)` / `exerciseInUse(usage)`, `deleteCustomExercise` (archives instead if used in history, a routine, the running workout, or as a variant base), `setExercisePhotos`, `setExerciseRest`, `setExerciseNote`, `setExerciseHidden` |
| `lib/ExerciseProvider.tsx` | `useExercises()` → `{ list, byId, get(id) }` (get never returns undefined), `useExercise(id)` |
| `lib/calc.ts` | `estimate1RM` (Epley), `setVolumeKg`, `workoutVolumeKg`, `countDoneSets`, `totalReps`, `prKindsFor`, `PR_LABEL`, `prMetric`, `detectPRs`, `computeAllPRs`, `bestsByExercise`, `isRecordSet`, `previousInstanceSets(history, exerciseId, {mode, routineId, occurrence})` (the n-th instance's last session, never merged), `exerciseSessions` (per-workout rows for charts), `repRecords` |
| `lib/calories.ts` | `estimateCalories({durationSec, bodyweightKg, exercises, getExercise})` (MET method; see doc comment), `DEFAULT_BODYWEIGHT_KG` |
| `lib/settings.ts` | `useSettings()` (never undefined), `getSettings`, `updateSettings(patch)` (a `bodyweightKg` patch is a manual edit, stamped `bodyweightUpdatedAt`; copying the newest weigh-in into it is ignored), `currentBodyweightKg` / `useBodyweightKg` (profile or newest weigh-in, whichever is newer), `pickBodyweightKg(settings, latest)`, `newestWeighIn()` |
| `lib/media.ts` | `saveImageFile(file)` → media id (downscaled JPEG), `deleteMedia`, `useMediaUrl`, `useMediaUrls`, `useExerciseImages(ex)` |
| `lib/workouts.ts` | `saveWorkout(w)` (derives totals + recomputes PRs), `deleteWorkout`, `recomputeAllPRs`, `deriveWorkout`, `loadTypeLookup`, `useWorkouts()` (newest first), `useWorkout(id)`, `useExerciseWorkouts(exerciseId)` (oldest first), `createRoutineFromWorkout`, `workoutToRoutineExercises`, `defaultWorkoutName` |
| `lib/routines.ts` | `useRoutines`, `useRoutine`, `useFolders`, `newRoutineSet`, `newRoutineExercise`, `createRoutine`, `saveRoutine`, `deleteRoutine`, `duplicateRoutine`, `createFolder`, `renameFolder`, `deleteFolder`; "Update routine": `planRoutineUpdate(routine, workout, variantSplits?)` → `{exercises, changed, swaps, added}` and `updateRoutineFromWorkout(id, workout, variantSplits?)` (building blocks `pairWorkoutWithRoutine`, `workoutForRoutineUpdate`, `mergeWorkoutIntoRoutine`, `routineExerciseSwaps`, `workoutDiffersFromRoutine`) |
| `lib/workoutStore.ts` | Zustand `useWorkoutStore` (active workout, persisted on every change; actions: start*, discard, setName, addExercises(items,{superset}), removeExercise, replaceExercise, reorderExercises, updateExercise, setSuperset, removeFromSuperset, addSet, removeSet, updateSet, startRest, adjustRest, stopRest, finish(meta)), `useActiveWorkout`, `newSet`, `setsFromRoutineExercise`, `setsFromPrevious`, `targetFromValues`, types `PickedExercise`, `NewExerciseItem`, `FinishMeta` |
| `lib/startWorkout.ts` | `beginWorkout({type:'empty'} \| {type:'routine', routine} \| {type:'repeat', workout}, navigate)` — confirms if one is already running, then opens `/workout/active` |
| `lib/offline.ts` | `precacheExerciseImages(onProgress, signal)`, `countCachedExerciseImages()` |
| `lib/ids.ts` | `uid()` |
| `components/ui` | `Button`, `IconButton`, `cx`, `TopBar`, `Page`, `SectionHeader`, `Card`, `Sheet`, `ActionSheet`, `confirm()`, `prompt()`, `toast()`, `Segmented`, `Chip`, `Toggle`, `Field`, `TextField`, `TextArea`, `SelectField`, `ListRow`, `ListGroup`, `EmptyState`, `Spinner`, `Loading`, `Stat`, `NumberCell`, `DurationCell` |
| `components/ExerciseImage.tsx` | `ExerciseThumb` (static thumbnail), `ExerciseAnimation` (looping cross-fade hero) |
| `components/RouteError.tsx` | `RouteError` route `errorElement` (root, tab pages, full-screen flows; see `App.tsx`) |
| `lib/pwa.tsx` | `setupPwa()` (called in `main.tsx`): service worker in 'prompt' mode + "new version" toast, stale-chunk reload guard |
| `components/MuscleMap.tsx` | `MuscleMap({ values?, highlight?: {primary, secondary}, view?, onSelect? })` |

`confirm/prompt/toast` are plain async functions (no hooks): `if (await confirm({title, message, danger:true, confirmLabel:'Delete'}))`,
`const name = await prompt({title:'Rename', initial})` (null = cancelled), `toast('Saved','success')` (kinds: info/success/error/pr).

## Routes (`src/App.tsx`, hash router)
Tab pages (bottom tab bar + mini workout bar): `/workout` (WorkoutHomePage), `/routines/:id`
(RoutineDetailPage), `/history`, `/history/:id`, `/exercises`, `/exercises/:id`, `/progress`,
`/progress/measurements`, `/settings`.
Full-screen: `/workout/active`, `/workout/finish`, `/routines/new` (optional `?folder=<id>`),
`/routines/:id/edit`, `/history/:id/edit`, `/exercises/new` (optional `?variantOf=<id>`), `/exercises/:id/edit`.
Tab pages must use `<Page tabBar>` so content clears the fixed bottom bars.

## Cross-feature contracts
- **ExercisePicker** (`features/exercises/ExercisePicker.tsx`, owned by the exercises builder):
  `<ExercisePicker open onClose onAdd={(picked: PickedExercise[], {superset}) => …} single? title? hideRoutinesTab? />`.
  `PickedExercise = { exerciseId, fromRoutine?: { routineId, routineExerciseId } }`. Consumers turn a
  `fromRoutine` pick into planned sets with `setsFromRoutineExercise(routineExercise)` (and keep its
  `routineExerciseId`; when the picked exerciseId differs from the routine's - a variant made in the picker -
  the planned weights are dropped); plain picks get the previous session of that exercise INSTANCE as
  placeholders (`previousInstanceSets(..., {occurrence})`) or one empty set. The logger does this in
  `features/workout/logic.ts buildExerciseItems`, the routine editor in `routineUtils routineExercisesFromPicks`.
- **MiniWorkoutBar** (workout builder) is rendered by `AppShell` above the tab bar; returns null when no
  workout is active.
- **MuscleMap** (progress builder) is used by the exercise detail page (highlight mode) and Progress (heat mode).

## Design language (Hevy-inspired, dark-first, native-feeling)
- Use ONLY the semantic Tailwind colors: `bg-bg`, `bg-surface`, `bg-surface-2`, `bg-surface-3`,
  `border-line`, `text-fg`, `text-muted`, `text-faint`, `bg-accent`/`text-accent`, `bg-accent-soft`,
  `text-on-accent`, `success`(+`-soft`), `warn`(+`-soft`, warm-up sets), `danger`(+`-soft`, failure sets),
  `drop`(+`-soft`, drop sets), `gold`(+`-soft`, PRs). Never hard-code hex colors. Both light and dark must work.
- System font, `tabular-nums` for every number that changes. Large page titles via `<TopBar title large />`.
- Cards `rounded-2xl bg-surface`; inputs 16px font (iOS zoom); touch targets ≥ 40px; one-handed use.
- Exercise names in workout/routine cards are `text-accent font-semibold` (Hevy look) and tappable → detail.
- Set table columns: `SET | PREVIOUS | {KG|LB} | REPS | ✓` (adapt per `typeFields`). Completed rows get
  `bg-success-soft`; the ✓ button fills `bg-success`. Set number badge shows W/F/D colored for set types.
- Empty/loading states for every list. Destructive actions confirm. Feedback via toast.
- Mobile-first: test layouts at 375px. No horizontal scroll except intentional chip rows (`no-scrollbar`).

## Rules for builders
- Edit ONLY files you own (listed in your task). Do not modify foundation files (`types.ts`, `db.ts`,
  `lib/*` you don't own, `components/ui/*`, `App.tsx`, `AppShell.tsx`). If you truly need a foundation
  change, describe it in your final report under "FOUNDATION REQUESTS" instead of editing.
- You may create new files inside your own feature folder.
- Never run git. Never start/stop dev servers. Do not use the browser tools (another agent may be using it).
- Typecheck with `npx tsc --noEmit` and fix every error in YOUR files (ignore errors in files owned by
  others that are mid-edit). Your work is not done while your files have type errors.
- No placeholder/TODO features: everything you render must work.
