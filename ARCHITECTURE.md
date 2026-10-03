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
  `Routine` / `RoutineFolder`, `Measurement`, `Media` (photo blobs), `Settings`.
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
Tab pages (bottom tab bar + mini workout bar): `/workout` (WorkoutHomePage), `/nutrition` (Food Diary,
`?d=yyyy-MM-dd` for another day), `/nutrition/settings` (Food settings), `/routines/:id` (RoutineDetailPage),
`/history`, `/history/:id`, `/exercises`, `/exercises/:id`, `/progress`, `/progress/measurements`, `/settings`,
`/settings/apple-health`.
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

## Apple Health (Shortcut bridge)
A web app cannot use HealthKit, so `lib/appleHealth.ts` hands a finished workout to an Apple Shortcut the user
builds once ("Heft to Health"; guide at `/settings/apple-health`, `features/progress/AppleHealthPage.tsx`) via
`shortcuts://run-shortcut?name=Heft%20to%20Health&input=text&text=<JSON>`. Payload keys: `start` ("October 2,
2026 at 6:05 PM"), `startISO`, `minutes`, `kcal` (ACTIVE calories = Heft's total estimate minus 1 MET × kg × h;
typed-in calories pass unchanged), `name`. The Shortcut: Get Dictionary from Input → Log Workout (Traditional
Strength Training; Date=start, Duration=minutes, Calories=kcal, Distance=0, because blank Distance fails) → Log Health
Sample (Active Energy=kcal, Date=start) for the Move ring. `Settings.appleHealth` turns on the
`features/history/SendToHealthButton.tsx` button (iPhone/iPad only); `Workout.healthSentAt` records sends. One-way only.
A future native build (HealthKit) should reuse `healthPayload()`.

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
  failures included: Food settings shows this month's spend).
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
  `recomputeMeal()`, so `day` and `totals` can't drift from the items. While a meal is `analyzing` only the
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
  filter for 3 days (localStorage `heft-fdc-datatype-rejected`, a timestamp, not a key) so a DEMO_KEY meal
  doesn't spend three requests per item.
- Network rules: USDA and OFF are GET-only with no custom headers (no CORS preflight). Claude is called from the
  phone with the official SDK (`dangerouslyAllowBrowser`, the user's own key), model `claude-opus-5-5`,
  structured output (`schema.ts` still validates and clamps), SDK retries off (`foodAi.ts` decides), and every
  billed response is recorded in `aiCalls`.

### Confidence cap (`confidence.ts finalConfidence`)
Start from Claude's level; +1 when every item matched a database; +1 when the user weighed the food. Then the
cap, applied last and always: **without a user weight or a scale reference found in the photo, confidence is at
most `medium`** (a portion judged from pixels is a guess). Claude saying `low` with unmatched items also stays at
most `medium`.

### API keys are device-only (`lib/nutrition/keys.ts`)
- The repo and the Pages site are **public**: no key is bundled (no `VITE_` env var), committed, or in a fixture
  (USDA fixtures were recorded with `DEMO_KEY`, `api_key` stripped). `guard.test.ts` fails on a real-looking
  Anthropic key or a `VITE_…KEY` read under `src/`.
- Keys live only in this browser's localStorage (`heft-key:anthropic`, `heft-key:fdc`): never in Dexie, never in
  a backup (`backup.food.test.ts` checks), never logged, never in a printed URL; shown masked (`maskKey`). The
  installed home-screen app has storage separate from Safari, so keys are pasted inside the app.
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

### Analysis lifecycle (`analyze.ts runAnalysis(mealId)`)
Capture → Analyze sets `pending` and opens `/nutrition/meal/:id`, which starts the run when a Claude key is saved
(without one the meal waits as `pending` and runs once a key is added). The run: `analyzing` (force) → Claude →
USDA grounding → confidence → `done` (title from the food names when empty; only the first photo is kept,
re-encoded ≤ 640 px, so backups stay small) or `failed` with a readable message. Runs are tracked per app
session: a meal left `analyzing` with no run here was interrupted (iOS killed the app), and
`analysisInterrupted(meal)` makes the UI offer Retry instead of an endless spinner. `runAnalysis` never throws and
a second call for the same meal joins the first.

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
| `targets.ts` | `computeTargets(profile, body)`, `bmr`, `tdee`, `calorieAdjustment`, `bodyFromSettings(settings, kg, now)` (body, or the `missing` fields), `DEFAULT_NUTRITION`, `ACTIVITY_FACTOR` / `ACTIVITY_LABEL` / `ACTIVITY_SUBTITLE`, `GOAL_LABEL`, `PACE_LABEL`, `BODY_FIELD_LABEL`, `KG_PER_LB` |
| `store.ts` | meals: `createMeal`, `updateMeal(id, patch \| fn, {force})`, `setMealStatus`, `deleteMeal` (and its photos), `addItem`, `updateItem`, `removeItem`, `newItemId`, `itemFromChoice(choice, grams, name?)`, `MealBusyError`; hooks (undefined while loading): `useDayMeals`, `useMeal` (null = missing), `useDayTotals`, `useUnfinishedMeals`, `useAiSpend(since)`, `useTargets` / `loadTargets`, `useNutritionProfile` / `getNutritionProfile` / `updateNutritionProfile`; foods: `upsertFood`, `useRecentFoods`, `foodByBarcode`, `foodFromChoice`, `choiceFromFood`; `todayKey` |
| `keys.ts` | `getAnthropicKey` / `setAnthropicKey`, `getFdcKey` / `setFdcKey`, `fdcKeyOrDemo`, `FDC_DEMO_KEY`, `clearNutritionKeys`, `maskKey`, `looksLikeAnthropicKey`, `useNutritionKeys()` |
| `burn.ts` | display-only: `useDayBurn(day)`, `loadDayBurn`, `sumActiveKcal` |
| `usda.ts` | `searchFoods(query, {pageSize, signal})` → `{status: ok/rate_limited/failed, foods, demoKey}`, `bestMatch(query, signal)`, ranking (`rankFoods`, `scoreCandidate`, `tokens`), `extractPer100g`, `choiceFromFdc`, `timeoutSignal`, `NUTRIENT`, `FDC_DATA_TYPES`, `resetUsdaDataTypeMemo` (tests) |
| `off.ts` | `lookupBarcode(code, signal)` → `{status: ok/not_found/unavailable, food}` (`not_found` only when OFF says so), `choiceFromOff`, `offPer100g`, `offServingG` |
| `barcode.ts` | `normalizeBarcode(raw, format?)` (EAN-13 / EAN-8 / UPC-A / UPC-E with check digit), `expandUpcE`, `gs1CheckDigit`, `decodeBarcodeFromImage(blob)` (null = none found; throws only if the reader can't load) |
| `photos.ts` | `saveMealPhoto(file)` (≤ 1568 px JPEG; `PhotoError` for undecodable files), `shrinkMealPhotos(ids)` (keep one ≤ 640 px) |
| `images.ts` | `loadImagesForAi(photoIds)` (base64 blocks, ≤ 4, type and size checked; `ImageLoadError`), `blobToBase64` |
| `prompt.ts` | `buildPrompt({imageCount, description, weightG})` (multi-angle, scale reference and user-context rules) |
| `schema.ts` | `MEAL_SCHEMA` (structured output), `parseMealOutput` (validate + clamp; `MealOutputError`), `clampWeightG` |
| `foodAi.ts` | `analyzeMeal(input, deps)` → `AnalyzeResult` (items, confidence, scaleReference, notes, billed `calls`) or throws `AiError` with a `code`; `testApiKey(key)` (spends no tokens); pricing `PRICES`, `priceFor`, `costUsd`, `billedCall`; `AI_MODEL` |
| `ground.ts` | `groundItems(aiItems, opts)` → meal items with USDA numbers or labelled estimates (4 at a time, 6 s per item) |
| `confidence.ts` | `finalConfidence({model, items, hasUserWeight, hasScaleRef})`, `allItemsMatched` |
| `analyze.ts` | `runAnalysis(mealId)`, `useAnalysisRunning(id)`, `isAnalysisRunning`, `analysisInterrupted(meal)`, `aiErrorMessage`, `titleFromItems`, `NO_KEY_MESSAGE` |

Feature-side shared pieces: `features/nutrition/ui.tsx` (`Ring`, `MacroBar`, `MacroLine`, `SourceChip`,
`ConfidenceBadge`, `formatKcal`, `useMassUnit`, and `GramsSheet`, the one gram-entry sheet) and
`FoodSearchSheet.tsx` (`<FoodSearchSheet open onClose mode="add" | "change" initialQuery? title? onPick={(choice,
grams | null) => …} />`; `add` asks for grams, `change` returns the food at once).
