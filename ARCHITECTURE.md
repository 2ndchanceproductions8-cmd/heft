# Heft — architecture & build contract

Heft is a personal, offline-first **Hevy-style workout tracker** (no social features) built as an
installable PWA for the owner's phone (iPhone/Android, ~375–430px wide). Everything lives on-device in
IndexedDB. Stack: React 19 + TypeScript (strict) + Vite 8 + Tailwind v4 + Dexie 4 (`useLiveQuery`) +
Zustand 5 + React Router 7 (hash router) + Recharts 3 + lucide-react icons + date-fns 4 + @dnd-kit. The Food tab
adds `@anthropic-ai/sdk`, `barcode-detector` and `zxing-wasm`, all loaded lazily (never in the main bundle).

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
7. A **Food tab** (port of his older SnapPlate app): photograph or describe a meal, Claude names the foods and
   estimates grams, USDA supplies the numbers; barcodes read the label via Open Food Facts. See "Food tab".

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
  `Routine` / `RoutineFolder`, `Measurement` (`source: 'health'` + `healthAt` = imported from Apple Health, see
  "Import from Apple Health"), `Media` (photo blobs), `Settings`.
- `ExerciseType` decides which columns a set has — use `typeFields(type)` from `lib/exerciseMeta.ts`
  (weight/reps/duration/distance + weight sign "+" weighted, "-" assisted).
- Food (`src/lib/nutrition/types.ts`: `Meal`, `MealItem`, `Food`, `NutritionProfile`) is the one storage exception:
  food mass in **grams**, energy in **kcal** (see "Food tab").

## Foundation APIs (do not re-implement; import these)
| Module | Exports |
|---|---|
| `src/db.ts` | `db` (Dexie tables: workouts, routines, folders, customExercises, overrides, measurements, media, settings, active; v2 adds the Food tab's meals, foods, nutrition) |
| `lib/units.ts` | unit conversion + formatting + `parseDecimal`, `parseClock` (bare digits = seconds, for prompts), `round`; time cells: `clockDigits`/`formatClockDigits`/`digitsToSeconds`/`parseTimeEntry` (digits fill m:ss from the right: "130" = 1:30); food mass: `MassUnit` ('g' \| 'oz'), `massUnitFor(unit)` (lb → oz, kg → g), `gToOz`, `ozToG`, `displayMass`, `massToG`, `formatGrams`, `G_PER_OZ` |
| `lib/backup.ts` | `BACKUP_VERSION` (2), `buildBackup`, `exportBackup`, `parseBackup` (validate without touching the DB, for a preview), `importBackup` (one transaction; returns counts incl. meals/foods), `keepsFoodLog(file)` (a v1 file keeps the food log), `exportCsv`, `downloadBlob` |
| `lib/nutrition/*` | the Food tab engine: see "Food tab" below for the module table |
| `lib/exerciseMeta.ts` | `EQUIPMENT_LABEL`, `MUSCLE_LABEL`, `EXERCISE_TYPE_LABEL`, `EXERCISE_TYPE_EXAMPLE`, `SET_TYPE_LABEL`, `SET_TYPE_SHORT`, `setNumberLabels(sets)` (THE set-number rule: W not counted, F/D take a number), `typeFields`, `EQUIPMENT_FILTERS`, `MUSCLE_FILTERS` |
| `lib/rest.ts` | THE rest-timer vocabulary: `REST_OPTIONS` (Off, 5s … 5:00), `restOptionLabel(sec)` ("Off", "45s", "1:30"), `restSettingLabel(sec, defaultSec)` ("Default (1:30)"), `restOptionsWith(current)` |
| `lib/useWakeNow.ts` | `useWakeNow()` — Date.now() refreshed when the app returns to the foreground |
| `lib/exercises.ts` | `CATALOG`, `assetUrl`, `buildExerciseIndex`, `searchExercises(list, query, {equipment, muscle})`, `variantRoot`, `variantFamily`, `renameExercise(id, name)` ('' resets), `createCustomExercise`, `createVariant(base, brand, name?)`, `variantName`, `updateCustomExercise`, `exerciseUsage(id)` / `exerciseInUse(usage)`, `deleteCustomExercise` (archives instead if used in history, a routine, the running workout, or as a variant base), `setExercisePhotos`, `setExerciseRest`, `setExerciseNote`, `setExerciseHidden`, `setExercisePerSide` |
| `lib/ExerciseProvider.tsx` | `useExercises()` → `{ list, byId, get(id) }` (get never returns undefined), `useExercise(id)` |
| `lib/calc.ts` | `estimate1RM` (Epley), `setVolumeKg`, `workoutVolumeKg`, `countDoneSets`, `totalReps`, `prKindsFor`, `PR_LABEL`, `prMetric`, `detectPRs`, `computeAllPRs`, `bestsByExercise`, `isRecordSet`, `previousInstanceSets(history, exerciseId, {mode, routineId, occurrence})` (the n-th instance's last session, never merged), `exerciseSessions` (per-workout rows for charts; `sides` = left/right bests), `repRecords`; per-side reads: `isSideSet`, `setLimbs` (THE way to read a set's values: two sides or the set), `setReps` / `setDurationSec` / `setDistanceM`, `limbMetric`, `prMetricSide`, `sideMetricFor`, `sideBalance` (see "Per-side sets") |
| `lib/sides.ts` | per-side set editing: `SIDES`, `SIDE_LETTER`, `SIDE_LABEL`, `valuesOf`, `hasSideValue`, `betterSide`, `syncSideSet` (the mirror), `splitSet`, `joinSet`, `sidesDiffer`, `patchSide`, `sideOf`, `sideTarget`, `formatSidesLine`, `defaultPerSide(name)` |
| `lib/calories.ts` | `estimateCalories({durationSec, bodyweightKg, exercises, getExercise})` (MET method; see doc comment), `DEFAULT_BODYWEIGHT_KG` |
| `lib/settings.ts` | `useSettings()` (never undefined), `getSettings`, `updateSettings(patch)` (a `bodyweightKg` patch is a manual edit, stamped `bodyweightUpdatedAt`; copying the newest weigh-in into it is ignored), `currentBodyweightKg` / `useBodyweightKg` (profile or newest weigh-in, whichever is newer), `pickBodyweightKg(settings, latest)`, `newestWeighIn()` |
| `lib/today.ts` | the Today dashboard's pure math, by LOCAL day: `lastDays`, `daysBetween`, `dailyWeighIns` (one per day: a typed row beats a Health row, else the day's LATEST reading, so a re-weigh replaces a bad one), `dailyBodyFat`, `latestBodyFat`, `weightTrend` (gap-aware EMA), `weeklySlope` / `weeklyRateKg`, `goalRateKgPerWeek`, `bodySummary`, `dailyIntake` / `averageIntake`, `dailyTraining`, `unsentWorkouts`, `buildWeek`, `KCAL_PER_KG` |
| `lib/healthImport.ts` | Apple Health → Measurements: `parseHealthText`, `parseHealthDate`, `parseWeightKg`, `parseBodyFatPct`, `groupWeighIns`, `planHealthImport`, `applyHealthImport(plan)`, `deleteMeasurement(entry)` (THE delete; tombstones Apple Health weigh-ins), `healthSampleAt`, `editedMeasurement(entry, changes, edited)` (THE way to save a user edit of a measurement), `HEALTH_SKIP_LABEL`, `HEALTH_IMPORT_SHORTCUT`, `importShortcutUrl()`, `HEALTH_TEMPLATE_LINES` / `healthTemplateText()`, `localDayKey` |
| `lib/healthInbox.ts` | automatic sync: `INBOX`, `INBOX_COMMENTS_URL`, `getInboxToken` / `setInboxToken` / `clearInboxToken`, `testInboxToken`, `checkInboxNow`, `useInboxStatus`, `inboxMessage`, `inboxImportMessage` (see "Automatic sync") |
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
| `components/MuscleMap.tsx` | `MuscleMap({ values?, highlight?: {primary, secondary}, view?, onSelect?, selected?, figure? })` (`figure` 'male' \| 'female' defaults to `Settings.sex`), `HEAT_STEPS`, `heatOpacity` |

`confirm/prompt/toast` are plain async functions (no hooks): `if (await confirm({title, message, danger:true, confirmLabel:'Delete'}))`,
`const name = await prompt({title:'Rename', initial})` (null = cancelled), `toast('Saved','success')` (kinds: info/success/error/pr).

## Routes (`src/App.tsx`, hash router)
Tab pages (bottom tab bar + mini workout bar): `/today` (TodayPage, the first tab and the LANDING route: `/` and
unknown paths redirect there; see "Today dashboard"), `/workout` (WorkoutHomePage), `/nutrition` (Food Diary,
`?d=yyyy-MM-dd` for another day), `/nutrition/settings` (Food settings), `/routines/:id` (RoutineDetailPage),
`/history`, `/history/:id`, `/exercises`, `/exercises/:id`, `/progress`, `/progress/measurements` (`?add=1` opens the
new-entry sheet on arrival, then drops the param), `/settings`, `/settings/apple-health`.
Full-screen: `/workout/active`, `/workout/finish`, `/routines/new` (optional `?folder=<id>`),
`/routines/:id/edit`, `/history/:id/edit`, `/exercises/new` (optional `?variantOf=<id>`), `/exercises/:id/edit`,
`/nutrition/log`, `/nutrition/meal/:id`, `/nutrition/scan` (query params under "Food tab").
The Food routes live in `features/nutrition/routes.tsx` (`nutritionTabRoutes`, `nutritionFullRoutes`, every page
lazy) and are spread into `App.tsx`; `lib/pwa.tsx` never reloads under the full-screen ones.
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
  Body artwork: MuscleMap by Melih Colpan (MIT, `THIRD_PARTY_NOTICES.md`), male and female, converted by
  `scripts/build-body-map.mjs` into the GENERATED `features/progress/bodyFigures.ts` (never hand-edit it).
  `features/progress/anatomy.ts` turns its layers into one tappable region per muscle (upper-back art split by area:
  the largest shape per side is `lats`, the rest `upper_back`) and holds the shared lighting (`ALSO_LIT_BY`: glutes
  also lit by abductors, back-view traps also by upper_back; a region shows its strongest muscle) and `DRAWN_MUSCLES`.

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

## Per-side sets (left / right, `lib/sides.ts`)
The owner wants to measure each arm's / leg's strength on single-arm and single-leg work. A **per-side set** is ONE
set (one badge, one RPE, one ✓, one rest timer, one set in the counts and the muscle map) that carries
`SetEntry.sides = { left, right }` (each `SideValues`: weight/reps/time/distance; the lifter's own left and right).
- **`sides` is the source of truth.** The set's top-level values MIRROR its better side (`syncSideSet`, by the type's
  metric: e1RM, reps (assisted: less help), time, distance), so code that reads a set as one value (routine updates,
  best-set lines, calories) sees its strongest side. Every write of a side goes through `patchSide` / `splitSet` /
  `joinSet`, which re-sync the mirror.
- **Totals add both sides** (`setVolumeKg`, `setReps`, `totalReps`, `exerciseSessions` totals, workout volume).
  **Records take the better limb** (`setLimbs` + `prMetricSide`; `PRRecord.side`, `RecordEntry.side`, `repRecords`
  rows name it). Per limb on purpose: before per-side logging a single-arm set "50 lb x 10" meant each arm, so limb
  vs limb keeps old history comparable and the first per-side workout can't set a fake volume PR.
- **Which exercises:** `Exercise.perSide`, resolved from `ExerciseOverride.perSide` (`setExercisePerSide`), else
  `defaultPerSide(catalog name)` (Single Arm/Leg, One Arm, Iso-Lateral / unilateral machines, split squats, lunges,
  step-ups, pistols, concentration curls, side planks, suitcase carries; 91 catalog exercises), a variant follows its
  base, a custom exercise is off. Toggles: the logger's exercise menu ("Log Left & Right Separately", converts this
  instance's sets: a plain value becomes each side's, joining keeps the better side after a confirm when sides differ),
  the exercise page's Left vs Right card / its settings row, and the custom exercise form's **Sides** switch
  (`features/exercises/ExerciseForm.tsx`: a new exercise's switch follows `defaultPerSide(name)` until touched, so
  "Iso-Lateral Row (Hammer Strength)" turns it on; a variant starts from its base; saved as the override only when it
  differs from what the exercise would get anyway; edit mode loads the override from Dexie, not the provider).
- **Logger** (`features/workout/SetRow.tsx`): a per-side exercise (or a set that already has `sides`) renders two lines,
  L and R, each with its own PREVIOUS (`sideOf(prevSet)`; a plain previous set applies to each side), placeholders
  (`sideTarget`: last session's side, else the plain plan incl. a rep range) and inputs. Plain sets of a per-side
  exercise (from a routine plan, a previous session, "Add Set") are split lazily on the first side edit or on the
  tick, so nothing converts sets up front. The tick fills each side (`filledValues`) and needs both
  ("Enter right reps first"). `targetFromValues` / `setsFromPrevious` carry `target.sides`.
- **Display:** `formatSidesLine` → "L 50 lb x 10 · R 50 lb x 9" ("L/R 50 lb x 10" when equal) in every set-line
  formatter; the saved workout's set table shows an L and an R line with their own e1RM; the CSV writes two rows with a
  `Side` column; PR toasts and the Records tab name the side.
- **Left vs Right card** (`features/exercises/SideBalanceCard.tsx`, exercise page, shown when the exercise is per-side
  or has per-side history): `sideBalance(sessions, type)` = the latest session's two sides on `sideMetricFor(type)`
  (est. 1RM, reps, hold time, distance), the gap % of the stronger side (<5 % Balanced, <10 % Slight gap, else
  Imbalance), best per side, both sides over time (Recharts), and the per-side switch.
- Backups carry `sides` / `target.sides` / `perSide` unchanged (no Dexie version bump; nothing indexed).

## Rules for builders
- Edit ONLY files you own (listed in your task). Do not modify foundation files (`types.ts`, `db.ts`,
  `lib/*` you don't own, `components/ui/*`, `App.tsx`, `AppShell.tsx`). If you truly need a foundation
  change, describe it in your final report under "FOUNDATION REQUESTS" instead of editing.
- You may create new files inside your own feature folder.
- Never run git. Never start/stop dev servers. Do not use the browser tools (another agent may be using it).
- Typecheck with `npx tsc --noEmit` and fix every error in YOUR files (ignore errors in files owned by
  others that are mid-edit). Your work is not done while your files have type errors.
- No placeholder/TODO features: everything you render must work.

## Apple Health (Shortcut bridge)
A web app cannot use HealthKit, so `lib/appleHealth.ts` hands a finished workout to an Apple Shortcut the user
builds once ("Heft to Health"; guide at `/settings/apple-health`, `features/progress/AppleHealthPage.tsx`) via
`shortcuts://run-shortcut?name=Heft%20to%20Health&input=text&text=<JSON>`. Payload keys: `start` ("October 2,
2026 at 6:05 PM"), `startISO`, `minutes`, `kcal` (ACTIVE calories = Heft's total estimate minus 1 MET × kg × h;
typed-in calories pass unchanged), `name`. The Shortcut: Get Dictionary from Input → Log Workout (Traditional
Strength Training; Date=start, Duration=minutes, Calories=kcal, Distance=0, because blank Distance fails) → Log Health
Sample (Active Energy=kcal, Date=start) for the Move ring. `Settings.appleHealth` turns on the
`features/history/SendToHealthButton.tsx` button (iPhone/iPad only); `Workout.healthSentAt` records sends.
A future native build (HealthKit) should reuse `healthPayload()`.

### Import from Apple Health (weigh-ins, `lib/healthImport.ts`)
The other direction: the owner's Hume Health scale (Body Pod) writes Weight and Body Fat Percentage to Apple Health,
and a second Shortcut, **"Health to Heft"** (`HEALTH_IMPORT_SHORTCUT`; guide in the second half of
`/settings/apple-health`, `?to=weigh-ins` scrolls there), brings EVERY weigh-in of the last 30 days into Measurements:
automatically through the GitHub inbox (see "Automatic sync" below), or by hand through the **clipboard**. Two Find
Health Samples actions (Weight, then Body Fat Percentage; Start Date in the last 30 days, sorted latest first, no
limit; the guide has the user Clear the second
action's auto-wired input, because added under the first it becomes "Filter Health Samples" over the weight and finds
no body fat) → a Text action with the template `heft-health` / `weight: …` / `weight date: …` / `body fat: …` /
`body fat date: …` (`HEALTH_TEMPLATE_LINES`; date bubbles = Start Date, Date Format ISO 8601 with time, which reads the
same in every region; a list variable writes one value per line under its key, paired with the dates by position) →
Copy to Clipboard → Get Contents of URL (the inbox POST). A Shortcut must **never** return by opening a Heft URL: that
lands in Safari, whose storage is separate from the home-screen app.
- UI: the flow lives in ONE hook, `features/progress/components/useHealthImport.tsx` (`useHealthImport(unit)` → handlers,
  status flags and the paste/preview `sheet` node; it marks `lib/busy.ts` while the Shortcut is open so a waiting app
  update can't reload Heft behind it). Two places use it: `HealthImportCard.tsx` on `/progress/measurements` and the
  Hume row on Today's Body card (both only when `isAppleMobile()`); bind its handlers straight to `onClick`.
  "Get from Health" sets `location.href = importShortcutUrl()` from the tap; "Paste from Health" calls
  `navigator.clipboard.readText()` as the FIRST statement of its tap handler (iOS rejects a read that starts after an
  await), then parse → preview sheet (added / updated / skipped / errors) → Save. A refused read opens a TextArea to
  long-press-paste into. Imported rows carry an "Apple Health" tag in the history list. The preview explains itself:
  "Heft couldn't read the Shortcut's text" when values were dropped with errors (vs "No weigh-ins in it" when nothing
  was found), a "Nothing new" message chosen by the newest skip's reason, and a warning when a line came back empty
  (`missing`, e.g. body fat = the step 3 Filter trap).
- `parseHealthText(text, {unit, now?})` → `{samples, errors, recognized, missing}` (samples: `{kind: 'weight' |
  'bodyFat', value: kg | percent, at}`; `missing` = kinds whose line was there but empty). Tolerant:
  case/space/underscore-insensitive keys, lb/lbs/kg/st (+ "13 st 2 lb")/g or no unit (= the user's), decimal commas,
  body fat as "18.5%", "18.5" or a bare fraction ≤ 1 (never with a % sign: "1%" is 1 %; a value with a mass unit is
  rejected), JSON objects/lists, multi-sample lists (repeated keys or values continued under a key). Dates via
  `parseHealthDate` — an explicit parser (never `Date.parse`) for ISO 8601 (offset or local), "Oct 5, 2026 at 7:02 AM",
  "10/5/26, 7:02 AM" (month first unless the first number is over 12), day-first, RFC 2822 ("Mon, 05 Oct 2026 07:02:00
  -0400"), Today / Yesterday, with U+202F / U+00A0 spaces; a numeric offset or "GMT-4" / "UTC" after the time is
  applied, a zone name alone ("EDT") is local; missing date = now. `recognized` is false without the `heft-health` line
  and without weight/body-fat keys, so random clipboard text is rejected; the generic keys `fat` / `mass` / `bf`
  (`WEAK_KEYS`) don't count on their own, so a nutrition label ("Fat: 12 g") is rejected too. Weight 20–400 kg (the
  error shows the range in the user's unit), body fat 1–75 %, else dropped with an error.
- **Every weigh-in is its own row** (since 2026-10-06; the owner: every time they step on the scale all the data should
  transfer, and they can delete a weigh-in that isn't accurate). `groupWeighIns(samples)`: each weight is one weigh-in;
  body fat within 10 min (`SAME_WEIGH_IN_MS`) joins the nearest weight; leftover body fat is a body-fat-only weigh-in.
  `planHealthImport(samples, existing, settings, {reimportAll?})` → `{add, update, skipped: {reason, at}[],
  importedThrough, clearDeleted}`: a weigh-in finds its row by the sample time (`hk_<ms>` id or `healthAt`, within 1 s;
  rows from the old one-per-day import are recognised the same way); a body-fat-only row whose weight synced later is
  joined by it (only if they agree). Skips: `edited` (the user edited that row: never overwritten), `unchanged`,
  `deleted`. Typed rows never block anything. A value the paste doesn't carry is never cleared.
- **Deletes stick**: `deleteMeasurement(entry)` (THE delete: Measurements' sheet and Today's Weigh-ins sheet) removes the
  row and its photos and adds its Apple Health sample time (`healthSampleAt`) to `Settings.healthDeleted`; each such
  tombstone holds back the ONE weigh-in nearest to it within 10 min (so a re-weigh a few minutes after a deleted bad
  reading still comes in). The paste preview's "Bring deleted weigh-ins back" (`reimportAll`) restores them and lifts
  only those tombstones (`plan.clearDeleted`). Rows deleted before tombstones existed may come back once.
- `applyHealthImport(plan)`: ONE `rw` transaction; it re-checks the database first (a row edited or deleted since the plan
  was made is left alone) and returns the rows actually written. `healthImportedAt` = now when it wrote rows;
  `healthImportedThrough` = the newest sample Heft holds (display only). It never writes the profile weight: calories and
  Food targets follow the newest weigh-in through `pickBodyweightKg`, and a newer hand-typed profile weight still wins.
- `Measurement.source` (`'manual' | 'health'`, missing = manual) and `healthAt` are not indexed (no Dexie version
  bump); they ride in backups unchanged, as do `Settings.healthImportedThrough` / `healthImportedAt` / `healthDeleted`. Any user edit of
  a health row makes it `'manual'`: `MeasurementSheet` saves through `editedMeasurement(entry, changes, dirty)`
  (starts from the stored row, so unknown fields survive) and Settings' body-weight edit of today's weigh-in sets
  `source: 'manual'` too.

### Automatic sync (the GitHub inbox, `lib/healthInbox.ts`)
A web app can't read HealthKit in the background, so the owner's iPhone does the pushing: a Shortcuts personal automation
(App → Hume Health → **Is Closed** → Run Immediately, Notify off → "Health to Heft") ends with **Get Contents of URL**:
POST `{"body": <heft-health text>}` to `INBOX_COMMENTS_URL`, a comment on issue #1 of the owner's PRIVATE repo
`2ndchanceproductions8-cmd/heft-inbox` (`INBOX`), with a fine-grained GitHub token (that repo only; Issues read/write).
- Heft holds the same token ONLY in localStorage (`heft-key:github-inbox`; never Dexie, a backup, a log or a URL; shown
  masked; "Delete all data" clears it; `lib/secrets.guard.test.ts` fails on a real-looking token under `src/`). The repo
  and the Pages site are PUBLIC: fixtures use obvious fakes.
- `checkInboxNow()` (single-flight, never throws): GET the comments (paged, `cache: 'no-store'`, 15 s timeout, headers
  Authorization Bearer + `Accept: application/vnd.github+json` + `X-GitHub-Api-Version: 2022-11-28`, which pass CORS),
  `parseHealthText` each, plan + apply ONE import, then DELETE the comments it read (only after the commit; a failed
  delete is harmless because re-reading is idempotent). Comments that aren't heft-health text are left alone. 401/403 →
  `token_rejected`, 404 → `not_found` (the token can't see the repo), network → `offline`.
- `HealthInboxWatcher` (mounted in RootLayout) checks on launch, when Heft comes back on screen and when the connection
  returns (at most once per 15 s, never while hidden or offline), plus two follow-ups (16 s, 45 s) because the Shortcut
  posts when Hume CLOSES, often just after Heft opens. It toasts what came in ("From Hume: 184.2 lb · 19.4% body fat")
  and one error toast when the key stops working. `useInboxStatus()` feeds Today's Hume row and the Settings page.
- Setup guide: `/settings/apple-health?to=auto` (make the key, paste + Test it, the Shortcut's extra step, the
  automation, try it). Verified 2026-10-06 in the browser with a stubbed GitHub: an automatic check on foreground, no
  duplicates on a 30-day re-send, the comment deleted, a deleted weigh-in held back on re-send. The real iPhone
  automation is untested until the owner runs it.

## Food tab (nutrition)
A port of SnapPlate. Log a meal by **photo or description** (Claude names the foods and estimates grams, USDA
FoodData Central supplies the numbers), by **barcode** (Open Food Facts reads the label), by **search** (USDA +
your recent foods) or by **quick add** (just calories, macros optional). The engine is `src/lib/nutrition/*`
(node-testable, I/O behind injectable deps); the screens are `src/features/nutrition/*`.

### Data model (`lib/nutrition/types.ts`, Dexie v2)
- **Storage exception:** food mass in **grams**, energy in **kcal** (nutrition databases are per 100 g). Convert
  only at the UI edge with the `lib/units.ts` mass helpers (lb users see oz, kg users g; `useMassUnit()` in
  `features/nutrition/ui.tsx` adds a per-screen g/oz toggle). Timestamps epoch ms; `day` is local `yyyy-MM-dd`.
- `meals` (id `meal_<uid>`; indexes `day`, `at`, `status`): `at` = when eaten, `day` derived from it, `status`
  `draft` (capture in progress, saved on the first photo so an iOS kill can't lose it) → `pending` → `analyzing`
  → `done` | `failed` (`error` says why; photos kept for Retry). `input` = {kind photo/text/barcode/search/quick,
  description, weightG}, `photoIds` (db.media; referenced, so never swept), `serves` 1–20, `items`, `totals`
  (cache), `confidence`, `scaleReference`, `notes`, `angles`, `aiCalls` (append-only billed Claude calls,
  failures included).
- `aiSpend` (indexes `at`, `mealId`): the spend LEDGER, one row per billed call, written by `store.ts` in the same
  transaction whenever a meal's `aiCalls` grows (and by `recordSpend` when the meal vanished mid-call). Food
  settings sums it by CALL time, so deleting or back-dating a meal never hides money spent. Not in backups: a v2
  restore rebuilds it from the restored meals; a v1 restore leaves it alone.
- `MealItem`: nutrients = `per100g × grams/100 × serves` (per100g is the source of truth; grams per serving are
  user-editable, `baselineGrams` drives Reset). Quick-add items carry `fixed` totals instead (not scaled by
  grams). `source` = `usda` | `off` | `estimate` | `manual`; `name` is never overwritten by a match
  (`matchedName` holds the database description); `lookup` records the per-item database outcome.
- `foods` (id `usda:<fdcId>` | `off:<barcode>` | `custom:<uid>`; indexes `barcode`, `lastUsedAt`): recents for
  search and the offline barcode cache.
- `nutrition` (one row, id `profile`): activity, goal, pace, kcal / protein overrides, `setupDoneAt`. Body inputs
  (sex, birth year, height, body weight) are NOT duplicated: they are Heft's `Settings` + the newest weigh-in,
  edited from either Settings page.
- Every meal write goes through `store.ts` (`createMeal`, `updateMeal`, item helpers), which always runs
  `recomputeMeal()`, so `totals` can't drift from the items. `day` is derived when the meal is created and
  re-derived ONLY when `at` changes (re-deriving on every edit would move a meal to another day after a
  time-zone change); `atForDay` builds times from calendar fields, so DST days keep their wall-clock hour. While a meal is `analyzing` only the
  analysis may write (`{ force: true }`); any other write throws `MealBusyError`.
- Only `done` meals count toward a day (`countsTowardDay`, `sumMeals`); the Diary says so under the list.

### Accuracy architecture (non-negotiable)
- **Claude does recognition + portion only**: per item a name, a USDA search phrase (`fdcQuery`), a portion and
  grams. `ground.ts` looks every phrase up in USDA (`bestMatch`) and the per-100 g numbers come from there.
- **Barcodes**: the numbers are the manufacturer's label via Open Food Facts (`off.ts`); the product is cached in
  `foods`, so a second scan works offline.
- **Claude's own nutrient figures are a labelled fallback**: an item USDA can't match keeps Claude's estimate
  with `source: 'estimate'`, shown as "Est." with the per-item reason (no match / rate-limited / failed). It is
  never passed off as a database value. Search, scan and quick add use no AI at all.
- USDA quirk (measured 2026-10-03): any `dataType` list containing "Survey (FNDDS)" gets HTTP 400. `usda.ts`
  tries the filter, then without commas, then no filter (Branded rows ranked down), and remembers a rejected
  filter for 3 days (localStorage `heft-fdc-datatype-rejected`, a timestamp, not a key) as soon as both filtered
  variants 400, so a DEMO_KEY meal doesn't spend three requests per item. Each item's 6 s lookup budget starts
  when it may send (not while it waits for that one probe). Nutrients: energy 208 → 958 → 957, carbs 205 → 205.2,
  sugar 269 → 269.3. HTTP 401/403 = `key_rejected` (shown as such, never as "no connection").
- Network rules: USDA and OFF are GET-only with no custom headers (no CORS preflight). Claude is called from the
  phone with the official SDK (`dangerouslyAllowBrowser`, the user's own key), model `claude-opus-5-5`,
  structured output (`schema.ts` still validates and clamps), server-side refusal fallback (`fallbacks:
  'default'`), no `thinking` param (always on for Opus 5.5), effort `medium`, 600 s timeout, SDK retries off
  (`foodAi.ts` decides), and every billed response is recorded in `aiCalls`. The prompt never asks Claude to
  show its reasoning (Opus 5.5 declines that as `reasoning_extraction`, and fallbacks don't retry it).
- Photos are saved ≤ 2048 px (Opus 5.5 reads up to 2576; a coin must stay legible for the scale procedure),
  stepping down until the base64 fits Claude's 5 MB image limit.

### Confidence cap (`confidence.ts finalConfidence`)
Start from Claude's level; +1 when every item matched a database; +1 when the user weighed the food AND every
item matched (a weight can't rescue a misidentified food — SnapPlate's rule). Then the cap, applied last and always: **without a user weight or a scale reference found in the photo, confidence is at
most `medium`** (a portion judged from pixels is a guess). Claude saying `low` with unmatched items also stays at
most `medium`.

### API keys stay on the device (`lib/nutrition/keys.ts`)
- The repo and the Pages site are **public**: no key is bundled (no `VITE_` env var), committed, or in a fixture
  (USDA fixtures were recorded with `DEMO_KEY`, `api_key` stripped). `guard.test.ts` fails on a real-looking
  Anthropic key or a `VITE_…KEY` read under `src/`.
- Keys live only in this browser's localStorage (`heft-key:anthropic`, `heft-key:fdc`): never in Dexie, never in
  a backup (`backup.food.test.ts` checks), never logged, never in a printed URL; shown masked (`maskKey`). The
  installed home-screen app has storage separate from Safari, so keys are pasted inside the app.
- CAVEAT: localStorage is per ORIGIN, and Heft shares `2ndchanceproductions8-cmd.github.io` with any other Pages
  site on the account (e.g. trading-sims). Scripts on those pages can read these keys in a browser tab (the iOS
  home-screen app's storage is separate). Hence the advice: a separate, spend-limited key used only for Heft. A
  custom (sub)domain for Heft would remove the overlap.
- A Claude key never goes to USDA: `isAnthropicSecret` (matches `sk-ant-` anywhere) is refused by the USDA field
  and `fdcKeyOrDemo()` falls back to DEMO_KEY rather than send it.
- With no personal USDA key, lookups use the shared `DEMO_KEY` (~10 requests an hour); the UI says so.
- Settings → "Delete all data" also calls `clearNutritionKeys()`, so a wiped phone forgets the keys.

### Workout burn is display-only
The Diary shows "Workouts: N kcal active · already in your target" (`burn.ts`: Heft's ACTIVE calories, the same
number the Apple Health bridge sends). It is **never** added to the food budget: `remaining(target, eaten)` has
exactly two inputs and `computeTargets` has no burn input, because the TDEE activity factor already assumes the
training. `guard.test.ts` fails if `targets.ts` or `math.ts` import burn / calories / appleHealth.

### Targets (`targets.ts`)
Mifflin-St Jeor BMR × activity factor (sedentary 1.2 … very active 1.9), goal offset (lose −400 / −750
aggressive, gain +250 / +500), protein 0.8 g/lb (1.0 when losing), fat 0.35 g/lb, carbs fill the rest, fiber
14 g per 1000 kcal. Ported verbatim from SnapPlate including its lb-first rounding. kcal / protein overrides
replace the computed values; missing body fields return `missing` instead of targets (the Diary prompts setup).

### Maintain · Recomp (body recomposition)
The owner (≈23 % body fat) wants to build muscle and lose fat together. After weighing a flat ±200 band and
+200/−200 cycling (≈ maintenance over a week, slow fat loss), they chose a **cycling deficit**: `NutritionProfile.recomp`
(only with goal `maintain`; Food settings → Goal → Maintain → Maintenance | Recomp) makes **training days =
maintenance** (`RECOMP_TRAINING_OFFSET` 0) and **rest days = maintenance −400** (`RECOMP_REST_OFFSET`), protein 1 g/lb
(as when losing), fat unchanged, carbs absorb the difference. A kcal override stays fixed every day (no cycling; the
targets card says so). `Targets.recomp` = `{trainingDay, trainingKcal, restKcal, trainingDaysPerWeek, avgKcal}`.
- **Training day** (`store.ts trainingDayInfo(day, profile, now)` → `{training, source}`): the user's mark
  (`NutritionProfile.trainingDays[day]`, `setTrainingDay(day, true | false | null)`, pruned to 60 days) wins; else a
  workout started that local day (`source: 'logged'`); else, for today, a workout running (`'running'`); else rest.
  `targets.ts` never imports workouts (the guard test): store.ts decides and passes `{trainingDay}` into
  `computeTargets(profile, body, day?)`. Workouts only say THAT you trained; their burn is still display-only.
- **Weekly average** (`recentTrainingDaysPerWeek`): distinct workout days (± marks) over the last 28 days, or since
  the first workout when that is newer (≥ 7-day window), else `ACTIVITY_TRAINING_DAYS[activity]`.
  `avgKcal = TDEE + recompAverageOffset(n)` (4 days ≈ −171/day). `goalRateKgPerWeek` uses `avgKcal`, so Today's pace
  pill and the week card's goal follow the plan's average, not today's kind of day.
- **Per day:** `loadTargets(now, day)` / `useTargets(day)` (Diary `?d=`, a meal's day, Today = today). The Diary's
  budget card and Today's Food card show `TrainingDayChip` (`features/nutrition/diary/TrainingDayChip.tsx`: "Training
  day · maintenance" / "Rest day · −400 kcal", why, one tap flips the day). The Today week card gives each day its own
  target (`weekModel` `dayTargetKcal`, same rule incl. marks and a running workout): per-column target marks instead
  of one line, a bar is "over" only against its own day, and the summary reads "avg target".

### Analysis lifecycle (`analyze.ts runAnalysis(mealId)`)
Capture → Analyze sets `pending` and opens `/nutrition/meal/:id`, which starts the run when a Claude key is saved
(without one the meal waits as `pending` and runs once a key is added). The run: `analyzing` (force) → Claude →
USDA grounding → confidence → `done` (title from the food names when empty; only the first photo is kept,
re-encoded ≤ 640 px via `finishMealPhotos`, the ONE shrink path every photo meal that reaches `done` uses —
analysis, "Enter manually", a draft folded into a search or scan) or `failed` with a readable message. Runs are tracked per app
session: a meal left `analyzing` with no run here was interrupted (iOS killed the app), and
`analysisInterrupted(meal)` makes the UI offer Retry instead of an endless spinner. `runAnalysis` never throws and
a second call for the same meal joins the first. While a run is in flight (and while any bottom sheet is open)
`lib/busy.ts` is marked, and `lib/pwa.tsx` won't apply a waiting app update in the background.

### Routes (`features/nutrition/routes.tsx`, all lazy)
| Route | Page |
|---|---|
| `/nutrition` (tab) | `DiaryPage`: budget ring + macros, training line, Log food (photo / scan / search / quick add), the day's meals. `?d=yyyy-MM-dd` for another day (capped at today) |
| `/nutrition/settings` (tab) | `NutritionSettingsPage`: body, activity, goal, targets + overrides, Claude key (test, spend), USDA key, attribution |
| `/nutrition/log` | `CapturePage`: up to 4 photos + description + optional weight, Analyze. `?meal=<id>` resumes a draft, `?d=` logs on another day |
| `/nutrition/meal/:id` | `MealPage`: analyzing / failed / no key (Retry, enter manually) and the done editor (grams, serves, change food, add food). A draft redirects to capture |
| `/nutrition/scan` | `ScanPage`: barcode from a photo (not saved) or typed digits. `?meal=<id>` adds the product to that meal, else a new meal on `?d=` |

### Backup v2
`BACKUP_VERSION` is 2: the file also carries `meals`, `foods` and `nutrition` (meal photos ride in `media`).
Import re-derives each meal's `day` / `totals`. **Restoring a version-1 file (made before the Food tab) replaces
the workout side only and keeps this device's food log** (meals, foods, targets and the photos those meals use);
`keepsFoodLog(file)` decides it, and Settings' import confirmation and toast say so. Keys are never in a backup.

### Bundle and offline
`@anthropic-ai/sdk` is imported dynamically inside `foodAi.ts` (its own chunk). The barcode ponyfill and the
zxing wasm are imported dynamically in `barcode.ts`; the wasm is self-hosted via `?url` (`zxing-wasm` is a direct
dependency pinned to 3.1.3, the version `barcode-detector` pins) and precached by the service worker (`*.wasm` in
`vite.config.ts` globPatterns), so a barcode photo decodes offline. A native `BarcodeDetector` that reads EAN-13
is used instead when the browser has one.

### `lib/nutrition` modules
| Module | Exports |
|---|---|
| `types.ts` | `Meal`, `MealItem`, `MealInput`, `MealStatus`, `AiCall`, `Food`, `FoodChoice`, `Per100g`, `Totals`, `NutritionProfile`, `Body`, `Targets`, `Confidence`, `NutrientSource`, `LookupStatus`, `Activity`, `Goal`, `Pace` |
| `math.ts` | pure: `emptyTotals`, `scalePer100g`, `addTotals`, `multiplyTotals`, `clampServes`, `MAX_SERVES`, `itemServing`, `itemNutrients`, `mealTotals`, `recomputeMeal`, `countsTowardDay`, `sumMeals`, `remaining(target, eaten)`, `per100gFromEstimate`, `dayKey`, `dayStart`, `shiftDay`, `atForDay(day, now)`, `kcal`, `macroG` |
| `targets.ts` | `computeTargets(profile, body, day?)`, `bmr`, `tdee`, `calorieAdjustment`, recomp: `isRecomp`, `recompAdjustment`, `recompAverageOffset`, `RECOMP_TRAINING_OFFSET` / `RECOMP_REST_OFFSET` / `RECOMP_MARK_DAYS`, `ACTIVITY_TRAINING_DAYS`, `bodyFromSettings(settings, kg, now)` (body, or the `missing` fields), `DEFAULT_NUTRITION`, `ACTIVITY_FACTOR` / `ACTIVITY_LABEL` / `ACTIVITY_SUBTITLE`, `GOAL_LABEL`, `PACE_LABEL`, `BODY_FIELD_LABEL`, `KG_PER_LB` |
| `store.ts` | meals: `createMeal`, `updateMeal(id, patch \| fn, {force})`, `setMealStatus`, `deleteMeal` (and its photos), `addItem`, `updateItem`, `removeItem`, `newItemId`, `itemFromChoice(choice, grams, name?)`, `MealBusyError`; hooks (undefined while loading): `useDayMeals`, `useMeal` (null = missing), `useDayTotals`, `useUnfinishedMeals`, `useAiSpend(since)` / `loadAiSpend` / `recordSpend` (the ledger), `useTargets(day?)` / `loadTargets(now, day?)` (`TargetsState.day`, `.training`), recomp: `trainingDayInfo`, `recentTrainingDaysPerWeek`, `setTrainingDay`, `useNutritionProfile` / `getNutritionProfile` / `updateNutritionProfile`; foods: `upsertFood`, `useRecentFoods`, `foodByBarcode`, `foodFromChoice`, `choiceFromFood`; `todayKey` |
| `keys.ts` | `getAnthropicKey` / `setAnthropicKey`, `getFdcKey` / `setFdcKey`, `fdcKeyOrDemo`, `FDC_DEMO_KEY`, `isAnthropicSecret`, `clearNutritionKeys`, `maskKey`, `looksLikeAnthropicKey`, `useNutritionKeys()` |
| `burn.ts` | display-only: `useDayBurn(day)`, `loadDayBurn`, `sumActiveKcal` |
| `usda.ts` | `searchFoods(query, {pageSize, signal})` → `{status: ok/rate_limited/failed, foods, demoKey}`, `bestMatch(query, signal)`, ranking (`rankFoods`, `scoreCandidate`, `tokens`), `extractPer100g`, `choiceFromFdc`, `timeoutSignal`, `NUTRIENT`, `FDC_DATA_TYPES`, `resetUsdaDataTypeMemo` (tests) |
| `off.ts` | `lookupBarcode(code, signal)` → `{status: ok/not_found/unavailable, food}` (`not_found` only when OFF says so), `choiceFromOff`, `offPer100g`, `offServingG` |
| `barcode.ts` | `normalizeBarcode(raw, format?)` (EAN-13 / EAN-8 / UPC-A / UPC-E with check digit), `expandUpcE`, `gs1CheckDigit`, `decodeBarcodeFromImage(blob)` (null = none found; throws only if the reader can't load) |
| `photos.ts` | `saveMealPhoto(file)` (≤ 2048 px JPEG, stepped down to fit 5 MB; `PhotoError` for undecodable files), `shrinkMealPhotos(ids)` (keep one ≤ 640 px), `finishMealPhotos(mealId)` (the shrink path for every finished photo meal; never throws) |
| `images.ts` | `loadImagesForAi(photoIds)` (base64 blocks, ≤ 4, type and size checked; `ImageLoadError`), `blobToBase64` |
| `prompt.ts` | `buildPrompt({imageCount, description, weightG})` (multi-angle, scale reference and user-context rules) |
| `schema.ts` | `MEAL_SCHEMA` (structured output), `parseMealOutput` (validate + clamp; `MealOutputError`), `clampWeightG` |
| `foodAi.ts` | `analyzeMeal(input, deps)` → `AnalyzeResult` (items, confidence, scaleReference, notes, billed `calls`) or throws `AiError` with a `code`; `testApiKey(key)` (spends no tokens); pricing `PRICES`, `priceFor`, `costUsd`, `billedCall`; `AI_MODEL` |
| `ground.ts` | `groundItems(aiItems, opts)` → meal items with USDA numbers or labelled estimates (4 at a time, 6 s per item) |
| `confidence.ts` | `finalConfidence({model, items, hasUserWeight, hasScaleRef})`, `allItemsMatched` |
| `analyze.ts` | `runAnalysis(mealId)`, `aiErrorMessage`, `titleFromItems`, `NO_KEY_MESSAGE`; re-exports the run registry below |
| `running.ts` | the dependency-free run registry: `isAnalysisRunning`, `analysisInterrupted(meal)`, `useAnalysisRunning(id)`, `subscribeRunning` (Today reads it without loading the analysis pipeline) |

Feature-side shared pieces: `features/nutrition/ui.tsx` (`Ring`, `MacroBar`, `MacroLine`, `SourceChip`,
`ConfidenceBadge`, `formatKcal`, `useMassUnit`, and `GramsSheet`, the one gram-entry sheet) and
`FoodSearchSheet.tsx` (`<FoodSearchSheet open onClose mode="add" | "change" initialQuery? title? onPick={(choice,
grams | null) => …} />`; `add` asks for grams, `change` returns the food at once).

## Today dashboard (`/today`, `features/today/*`)
The owner runs Heft, its Food tab (the old SnapPlate) and a **Hume Health Body Pod** scale as one ecosystem; Today puts
them on one screen, each card one tap from its own tab. `TodayPage` renders four cards, each in its own
`CardBoundary` (a card that throws shows a Retry box; the others keep working). It is Recharts-free (plain SVG/HTML) and
imported eagerly, because it is the landing page. `today` = `useTodayKey()` (rolls over at midnight / app wake), `now`
moves on wake. Live reads: `features/today/data.ts` (`useMeasurements`, `useMealsInDays`) plus the existing hooks. Every
card exports a pure `…View` for the server-render tests (`features/today/*.render.test.ts`).
- **Body** (`BodyCard`, `body/*`): the latest weigh-in (`dailyWeighIns`: a typed row, else the day's latest reading;
  tapping it opens the Weigh-ins sheet, `body/WeighInsSheet.tsx`: 14 days, "Counts for the day", Delete per row), the
  pace pill (`weeklyRateKg`, 28-day least squares; green only when it agrees with the goal pace `goalRateKgPerWeek` from
  the final targets), trend weight (EMA, 10 %/day), body fat with its 4-week change (needs readings across 21+ days), a
  30-day chart, a stale nudge after 7 days, and the Hume row (`body/HumeSync.tsx`): automatic-sync status + Check now
  when a token is saved on the device, else (iPhone) Get from Health / Paste + "Make it automatic".
- **Food** (`FuelCard`, `fuel/*`): today's ring and macros, the same numbers as the Diary (only `done` meals count; budget =
  `remaining(target, eaten)`, burn never added), today's unfinished meals (an analysis cut off by iOS reads "needs a
  retry", via `lib/nutrition/running.ts`), Snap a meal / Scan.
- **Training** (`TrainingCard`, `training/*`): a running workout (Resume), today's workouts (or the last one), this week vs
  last week and the streak (the same `weeklyBuckets` / `weekStreak` as Progress), the Apple Health "not sent" nudge
  (iPhone + `Settings.appleHealth`), Start empty workout / Routines.
- **Last 7 days** (`WeekCard`, `week/*`): `buildWeek` lines up three lanes by day: weight dots + trend line, food bars
  vs the target (a day with nothing logged gets NO bar, never 0 kcal; today's bar is striped), training. Then the average
  eaten (logged days, today excluded), the weekly rate vs goal, and the workouts. Tapping a day opens its sheet.
- Settings note: `useSettings()` returns defaults while loading, so the cards read the unit from `useTargets().settings`
  or the settings row and show a fixed-height skeleton until everything they need has loaded.
