import { confirm as uiConfirm } from '../../../components/ui';
import { isAnalysisRunning, runAnalysis } from '../../../lib/nutrition/analyze';
import { finishMealPhotos } from '../../../lib/nutrition/photos';
import { createMeal, deleteMeal, itemFromChoice, updateMeal } from '../../../lib/nutrition/store';
import type { FoodChoice, Meal } from '../../../lib/nutrition/types';
import { diaryPath, mealPath } from './nav';

/*
 * The Food screens' multi-step writes, kept out of the components so they run (and are tested) against the
 * real store. One rule runs through them: when a meal with photos becomes 'done' WITHOUT an analysis (a
 * search, a barcode, "Enter manually"), finishMealPhotos() keeps one small photo, as the analysis does, so no
 * path leaves full-size photos in every backup.
 */

/** What the capture screen has typed, as stored on the draft row. */
export interface DraftText {
  description: string;
  /** Grams, or null for an empty / invalid weight field. */
  weightG: number | null;
}

const hasText = (t: DraftText) => !!t.description.trim() || t.weightG != null;

/** Write the capture screen's typed fields into its draft row (no-op once the row is no longer a draft). */
export function writeDraftText(draftId: string, t: DraftText): Promise<Meal | null> {
  return updateMeal(draftId, (m) =>
    m.status === 'draft' ? { input: { ...m.input, description: t.description.trim() || undefined, weightG: t.weightG } } : {},
  );
}

/**
 * Leave the capture screen WITHOUT losing anything ("Save for later", "Scan a barcode instead"). Returns the
 * id of the draft that now holds the capture, or null when there was nothing to keep:
 * - a draft row is updated with what was typed (the debounced write may not have run yet);
 * - a draft row with no photos and nothing typed is deleted quietly (it would only clutter the Diary);
 * - typed text with no row yet becomes a text draft, so the Diary offers to continue it.
 * `draft` is the LOADED row (null while a resumed draft is still loading or gone: no row is touched then).
 */
export async function keepCapture(o: { draft: Meal | null; text: DraftText; atIfNew: number }): Promise<string | null> {
  const { draft, text } = o;
  if (draft && draft.status === 'draft') {
    if (!draft.photoIds.length && !hasText(text)) {
      await deleteMeal(draft.id);
      return null;
    }
    await writeDraftText(draft.id, text);
    return draft.id;
  }
  if (draft) return null; // already past the draft stage (sent to analysis meanwhile): not ours to touch
  if (!hasText(text)) return null;
  const m = await createMeal({
    status: 'draft',
    input: { kind: 'text', description: text.description.trim() || undefined, weightG: text.weightG },
    at: o.atIfNew,
  });
  return m.id;
}

/**
 * A food picked from search on the capture screen. A draft WITH photos becomes this finished meal (the photos
 * stay as its picture, shrunk to one); otherwise any draft is dropped and a new meal is logged. Returns its id.
 */
export async function logSearchFromCapture(o: { draft: Meal | null; food: FoodChoice; grams: number; atIfNew: number }): Promise<string> {
  const { draft, food } = o;
  const item = itemFromChoice(food, o.grams);
  if (draft && draft.photoIds.length) {
    const saved = await updateMeal(draft.id, { status: 'done', input: { kind: 'search' }, title: food.name, items: [item], error: null });
    if (!saved) throw new Error('draft vanished');
    await finishMealPhotos(saved.id);
    return saved.id;
  }
  if (draft) await deleteMeal(draft.id);
  const m = await createMeal({ status: 'done', input: { kind: 'search' }, title: food.name, items: [item], at: o.atIfNew });
  return m.id;
}

/**
 * The barcode screen's "Log it" / "Add to meal" for `?meal=<id>`. A capture DRAFT (the user tapped "Scan a
 * barcode instead") becomes this finished meal: the product is its item, its title when it has none, and its
 * photos shrink to one. Any other meal just gets the item, as before. Returns the saved meal (null = gone).
 */
export async function addProductToMeal(mealId: string, food: FoodChoice, grams: number, via: 'barcode' | 'search'): Promise<Meal | null> {
  const item = itemFromChoice(food, grams);
  let folded = false;
  const saved = await updateMeal(mealId, (m) => {
    folded = m.status === 'draft';
    if (!folded) return { items: [...m.items, item] };
    return {
      items: [...m.items, item],
      status: 'done',
      error: null,
      input: { kind: via },
      title: m.title.trim() || food.name,
      confidence: via === 'barcode' ? 'high' : null,
    };
  });
  if (saved && folded) await finishMealPhotos(saved.id);
  return saved;
}

/**
 * "Enter manually instead" on a meal that couldn't be analyzed: add the food and finish the meal (photos
 * shrink to one). `force` clears an interrupted run's leftover 'analyzing' status.
 */
export async function enterMealManually(mealId: string, food: FoodChoice, grams: number, force: boolean): Promise<Meal | null> {
  const item = itemFromChoice(food, grams);
  const saved = await updateMeal(mealId, (m) => ({ items: [...m.items, item], status: 'done', error: null, title: m.title || food.name }), { force });
  if (saved) await finishMealPhotos(saved.id);
  return saved;
}

/**
 * "Delete meal" on a meal that isn't done (waiting, failed, interrupted). Never while its analysis runs here.
 * Asks first; returns the Diary path for the meal's day once deleted, or null when nothing was deleted.
 */
export async function deleteUnfinishedMeal(meal: Pick<Meal, 'id' | 'day' | 'photoIds'>, ask: typeof uiConfirm = uiConfirm): Promise<string | null> {
  if (isAnalysisRunning(meal.id)) return null;
  const ok = await ask({
    title: 'Delete this meal?',
    message: meal.photoIds.length ? 'Its photos are deleted too. This can’t be undone.' : 'This can’t be undone.',
    danger: true,
    confirmLabel: 'Delete',
  });
  // A Retry could have started while the dialog was up.
  if (!ok || isAnalysisRunning(meal.id)) return null;
  await deleteMeal(meal.id);
  return diaryPath(meal.day);
}

/**
 * The Diary's "Retry" on a failed / interrupted meal: with a Claude key the analysis starts right away (not
 * awaited; the meal page shows it running), then the meal opens. Without a key it only opens the meal, which
 * offers "Add Claude key".
 */
export function retryMeal(mealId: string, hasKey: boolean, navigate: (to: string) => void, run: (id: string) => Promise<void> = runAnalysis): void {
  if (hasKey) void run(mealId);
  navigate(mealPath(mealId));
}
