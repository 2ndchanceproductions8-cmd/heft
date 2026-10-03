import { clearBusy, markBusy } from '../busy';
import { useSyncExternalStore } from 'react';
import { db } from '../../db';
import { finalConfidence } from './confidence';
import { AiError, analyzeMeal, type AiErrorCode, type AnalyzeResult } from './foodAi';
import { groundItems } from './ground';
import { ImageLoadError, loadImagesForAi } from './images';
import { getAnthropicKey } from './keys';
import { finishMealPhotos } from './photos';
import { recordSpend, updateMeal } from './store';
import type { AiCall, Meal, MealItem } from './types';

/*
 * The whole photo/text → meal pipeline: status 'analyzing' (force) → Claude (recognition + portion) → USDA
 * grounding → confidence → 'done' (or 'failed' with a readable error; photos kept for Retry). Every billed
 * Claude call is appended to meal.aiCalls, failures included.
 *
 * Runs are tracked per meal id in THIS app session only: a meal left in 'analyzing' with no run here was
 * interrupted (iOS killed the app mid-call) — analysisInterrupted() tells the UI to offer Retry instead of a
 * spinner that never ends.
 */

export const NO_KEY_MESSAGE = 'Add your Claude key in Food settings to analyze photos.';
export const GENERIC_FAILURE = 'Something went wrong — try again.';

/** The user-facing sentence for each Claude failure. */
export function aiErrorMessage(e: Pick<AiError, 'code' | 'message'>): string {
  const detail = e.message?.trim();
  const MESSAGES: Record<AiErrorCode, string> = {
    no_key: NO_KEY_MESSAGE,
    key_rejected: 'Claude rejected your key — check it in Food settings.',
    forbidden: detail ? `Claude refused access: ${detail}` : 'Claude refused access for this key — check it in Food settings.',
    refused: 'Claude declined to analyze this meal. Try another photo, or enter it manually.',
    rate_limited: detail ? `Claude is limiting requests: ${detail}` : 'Claude is limiting requests right now — try again in a minute.',
    overloaded: 'Claude is overloaded right now — try again in a minute.',
    bad_request: detail ? `Claude couldn't use this request: ${detail}` : "Claude couldn't use this request.",
    network: "No connection. Retry when you're back online.",
    timeout: 'Claude took too long to answer — try again.',
    truncated: "Claude's answer was cut off — try again.",
    invalid_output: "Claude's answer couldn't be read — try again.",
    unknown: GENERIC_FAILURE,
  };
  return MESSAGES[e.code] ?? GENERIC_FAILURE;
}

// ------------------------------------------------------------------ in-flight tracking

const running = new Set<string>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** True while runAnalysis(mealId) is in flight in THIS app session. */
export function isAnalysisRunning(mealId: string): boolean {
  return running.has(mealId);
}

/**
 * A meal stuck in 'analyzing' with no run in this session was interrupted (iOS killed the app mid-call).
 * Callers show Retry for it instead of a spinner.
 */
export function analysisInterrupted(meal: { id: string; status: string }): boolean {
  return meal.status === 'analyzing' && !running.has(meal.id);
}

/** React hook: re-renders when any analysis starts/finishes; returns isAnalysisRunning(mealId). */
export function useAnalysisRunning(mealId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (mealId ? running.has(mealId) : false),
    () => false,
  );
}

// ------------------------------------------------------------------ the run

export interface AnalysisDeps {
  analyzeMeal?: typeof analyzeMeal;
  groundItems?: typeof groundItems;
  loadImages?: typeof loadImagesForAi;
  /** Default finishMealPhotos (photos.ts), the one shrink path. Injected in tests. */
  finishPhotos?: typeof finishMealPhotos;
  getApiKey?: () => string | null;
  now?: () => number;
}

/** "Rice, Chicken & Broccoli" from the first 1–3 item names. */
export function titleFromItems(items: Pick<MealItem, 'name'>[]): string {
  const names = items
    .map((i) => i.name.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

function stampCalls(calls: AnalyzeResult['calls'], at: number): AiCall[] {
  return calls.map((c) => ({ at, ...c }));
}

async function run(mealId: string, deps: AnalysisDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const meal = await db.meals.get(mealId);
  if (!meal) return;

  const apiKey = (deps.getApiKey ?? getAnthropicKey)();
  if (!apiKey) {
    await updateMeal(mealId, { status: 'pending', error: NO_KEY_MESSAGE }, { force: true });
    return;
  }

  // Writes that carry billed calls: if the meal row vanished meanwhile (restore / delete-all mid-call), the
  // calls still go to the spend ledger.
  const withCalls = async (calls: AnalyzeResult['calls'], write: (stamped: AiCall[]) => Promise<Meal | null>) => {
    const stamped = stampCalls(calls, now());
    const saved = await write(stamped);
    if (!saved && stamped.length) await recordSpend(mealId, stamped);
    return saved;
  };
  const fail = (error: string, calls: AnalyzeResult['calls'] = []) =>
    withCalls(calls, (stamped) => updateMeal(mealId, (m) => ({ status: 'failed', error, aiCalls: [...m.aiCalls, ...stamped] }), { force: true }));

  // Claude calls that are billed but not yet written to the meal (so an unexpected failure still records them).
  let unrecorded: AnalyzeResult['calls'] = [];
  try {
    await updateMeal(mealId, { status: 'analyzing', error: null }, { force: true });

    let images: Awaited<ReturnType<typeof loadImagesForAi>>;
    try {
      images = await (deps.loadImages ?? loadImagesForAi)(meal.photoIds);
    } catch (e) {
      await fail(e instanceof ImageLoadError ? e.message : GENERIC_FAILURE);
      return;
    }
    const description = meal.input.description?.trim() || undefined;
    const weightG = meal.input.weightG != null && meal.input.weightG > 0 ? meal.input.weightG : null;
    if (!images.length && !description) {
      await fail(meal.photoIds.length ? 'The photos for this meal are missing — add a photo or describe it.' : 'Add a photo or describe what you ate.');
      return;
    }

    let result: AnalyzeResult;
    try {
      result = await (deps.analyzeMeal ?? analyzeMeal)({ images, description, weightG }, { apiKey });
    } catch (e) {
      if (e instanceof AiError) {
        if (e.code === 'no_key') {
          await withCalls(e.calls, (stamped) =>
            updateMeal(mealId, (m) => ({ status: 'pending', error: NO_KEY_MESSAGE, aiCalls: [...m.aiCalls, ...stamped] }), { force: true }),
          );
        } else {
          await fail(aiErrorMessage(e), e.calls);
        }
        return;
      }
      throw e;
    }
    unrecorded = result.calls;

    if (!result.isFood || !result.items.length) {
      await fail(`That doesn't look like food. ${result.notes}`.trim(), result.calls);
      return;
    }

    const grounded = await (deps.groundItems ?? groundItems)(result.items, {});
    const confidence = finalConfidence({
      model: result.confidence,
      items: grounded.items,
      hasUserWeight: weightG != null,
      hasScaleRef: !!result.scaleReference,
    });
    const saved = await withCalls(result.calls, (stamped) =>
      updateMeal(
        mealId,
        (m) => ({
          items: grounded.items,
          confidence,
          scaleReference: result.scaleReference,
          notes: result.notes,
          angles: images.length,
          aiCalls: [...m.aiCalls, ...stamped],
          title: m.title.trim() || titleFromItems(grounded.items),
          status: 'done',
          error: null,
        }),
        { force: true },
      ),
    );
    unrecorded = [];

    // Keep one small photo (JSON backups stay small) through THE shrink path every finished photo meal uses.
    // finishMealPhotos never throws; the guard is for an injected one, because the meal is final whatever
    // happens here and must never be marked failed by a thumbnail.
    if (saved && saved.photoIds.length) {
      try {
        await (deps.finishPhotos ?? finishMealPhotos)(mealId);
      } catch {
        /* keep the photos as they are */
      }
    }
  } catch {
    try {
      await fail(GENERIC_FAILURE, unrecorded);
    } catch {
      /* the database itself is failing; nothing more we can do */
    }
  }
}

/**
 * Analyze a meal end to end: status → 'analyzing' (force) → Claude → USDA grounding → items/totals/confidence
 * → 'done' (or 'failed' with a readable error; photos kept). Safe to call twice: a second call for the same
 * id while one is running returns the same promise. Resolves when finished; never throws.
 */
export function runAnalysis(mealId: string, deps: AnalysisDeps = {}): Promise<void> {
  const cur = inflight.get(mealId);
  if (cur) return cur;
  running.add(mealId);
  markBusy('analysis:' + mealId); // lib/pwa.tsx won't reload the app under a billed call
  const p = run(mealId, deps)
    .catch(() => undefined)
    .finally(() => {
      running.delete(mealId);
      clearBusy('analysis:' + mealId);
      inflight.delete(mealId);
      emit();
    });
  inflight.set(mealId, p);
  emit();
  return p;
}
