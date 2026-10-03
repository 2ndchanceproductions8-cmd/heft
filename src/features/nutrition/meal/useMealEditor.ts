import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../../components/ui';
import { recomputeMeal } from '../../../lib/nutrition/math';
import { MealBusyError, updateMeal } from '../../../lib/nutrition/store';
import type { Meal } from '../../../lib/nutrition/types';

export type MealPatch = Partial<Pick<Meal, 'title' | 'at' | 'serves' | 'items'>>;

const DEBOUNCE_MS = 350;

/**
 * Optimistic editing of a finished meal. Edits show immediately (local state, totals recomputed with the same
 * recomputeMeal the store uses) and are written with ONE debounced updateMeal 350 ms after the last change.
 * `flush()` writes now (call it before navigating); unmounting flushes too. A MealBusyError (an analysis
 * started on this meal) drops the local edits with a toast.
 */
export function useMealEditor(meal: Meal) {
  const id = meal.id;
  const [local, setLocal] = useState<MealPatch | null>(null);
  // The row updateMeal returned: shown until the live query catches up, so a save never flickers back.
  const [saved, setSaved] = useState<Meal | null>(null);
  const pending = useRef<MealPatch | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const base = saved && saved.id === id && saved.updatedAt > meal.updatedAt ? saved : meal;
  // Same day rule as store.updateMeal: the day follows the eaten time only when `at` was edited.
  const view = local ? recomputeMeal({ ...base, ...local }, { rederiveDay: local.at !== undefined && local.at !== base.at }) : base;
  // The newest working copy, also between an edit and its re-render (two quick edits must stack).
  const working = useRef(view);
  working.current = view;

  const flush = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return true;
    pending.current = null;
    try {
      const next = await updateMeal(id, p);
      if (next) setSaved(next);
      if (!pending.current) setLocal(null);
      return true;
    } catch (e) {
      if (!pending.current) setLocal(null);
      toast(e instanceof MealBusyError ? e.message : "Couldn't save that change", 'error');
      return false;
    }
  }, [id]);

  const edit = useCallback(
    (fn: (m: Meal) => MealPatch, opts: { now?: boolean } = {}) => {
      const patch = fn(working.current);
      working.current = recomputeMeal({ ...working.current, ...patch }, { rederiveDay: patch.at !== undefined && patch.at !== working.current.at });
      pending.current = { ...pending.current, ...patch };
      setLocal((prev) => ({ ...prev, ...patch }));
      window.clearTimeout(timer.current);
      if (opts.now) void flush();
      else timer.current = window.setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush],
  );

  /** Forget unsaved edits (e.g. right before deleting the meal). */
  const discard = useCallback(() => {
    window.clearTimeout(timer.current);
    pending.current = null;
    setLocal(null);
  }, []);

  // Leaving the page (or the meal switching away from 'done') writes whatever is still pending.
  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  return { view, edit, flush, discard, working };
}
