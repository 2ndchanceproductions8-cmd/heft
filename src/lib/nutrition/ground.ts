import type { AiItem } from './foodAi';
import { per100gFromEstimate } from './math';
import { clampWeightG } from './schema';
import { newItemId } from './store';
import { bestMatch, timeoutSignal } from './usda';
import type { LookupStatus, MealItem } from './types';

/*
 * Ground Claude's items in USDA: Claude supplies the name, portion, grams and a search phrase; USDA supplies
 * the per-100 g numbers. An item USDA can't match keeps Claude's own estimate (source 'estimate', shown as
 * "Est." in the UI) with the lookup outcome recorded per item, so a rate-limited DEMO_KEY is visible on the
 * rows it affected instead of silently passing estimates off as database values.
 */

export const GROUND_CONCURRENCY = 4;
/**
 * Per item: the time budget for the item's OWN USDA request(s). usda.ts starts it once the lookup may send,
 * after any wait on another item's dataType probe, so one slow probe can't use up every item's time (on weak
 * cellular, items 2-4 used to fall back to estimates while item 1 was still finding out about the filter).
 */
export const GROUND_ITEM_BUDGET_MS = 6000;
/**
 * Safety net only: no lookup holds the meal longer than this, whatever happens below. usda.ts's own worst case
 * is about 22 s (a probe's two filtered requests at its 8 s per-request cap, then the 6 s budget); a typical
 * item takes well under 2 s.
 */
export const GROUND_ITEM_CAP_MS = 30_000;

export interface GroundResult {
  items: MealItem[];
  /** At least one lookup hit USDA's rate limit (DEMO_KEY: ~10 requests an hour). */
  anyRateLimited: boolean;
  /** The lookups used the shared DEMO_KEY. */
  demoKey: boolean;
}

export interface GroundOptions {
  signal?: AbortSignal;
  /** Injected in tests. */
  bestMatch?: typeof bestMatch;
  /** Per-item budget passed to bestMatch (default GROUND_ITEM_BUDGET_MS). */
  budgetMs?: number;
  /** Hard per-item cap (default GROUND_ITEM_CAP_MS). */
  capMs?: number;
}

/** Run `fn` over `xs` with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

export async function groundItems(aiItems: AiItem[], opts: GroundOptions = {}): Promise<GroundResult> {
  const match = opts.bestMatch ?? bestMatch;
  const budgetMs = opts.budgetMs ?? GROUND_ITEM_BUDGET_MS;
  const capMs = opts.capMs ?? GROUND_ITEM_CAP_MS;
  let anyRateLimited = false;
  let demoKey = false;

  const items = await mapLimit(aiItems, GROUND_CONCURRENCY, async (ai): Promise<MealItem> => {
    const grams = clampWeightG(ai.weightG);
    const query = (ai.fdcQuery || ai.name || '').trim();
    let status: LookupStatus = 'skipped';
    let choice: Awaited<ReturnType<typeof bestMatch>>['choice'] = null;
    if (query) {
      const t = timeoutSignal(capMs, opts.signal);
      try {
        if (t.signal.aborted) throw new Error('aborted');
        // The budget is bestMatch's to enforce (it knows when the item may send); the cap and the caller's
        // abort win here even against a lookup that ignores its signal.
        const r = await Promise.race([
          match(query, t.signal, { budgetMs }),
          new Promise<never>((_res, rej) => {
            if (t.signal.aborted) rej(new Error('aborted'));
            t.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
          }),
        ]);
        status = r.status;
        choice = r.choice;
        demoKey ||= r.demoKey;
      } catch {
        status = 'failed';
      } finally {
        t.done();
      }
    }
    if (status === 'rate_limited') anyRateLimited = true;

    const base = {
      id: newItemId(),
      name: ai.name,
      portion: ai.portion,
      grams,
      baselineGrams: grams,
      fixed: null,
      fdcQuery: ai.fdcQuery || undefined,
    };
    if (status === 'ok' && choice) {
      return { ...base, per100g: choice.per100g, source: 'usda', matchedName: choice.name, fdcId: choice.fdcId, lookup: 'ok' };
    }
    return {
      ...base,
      per100g: per100gFromEstimate(ai.estimate, grams),
      source: 'estimate',
      lookup: status === 'ok' ? 'no_match' : status,
    };
  });

  return { items, anyRateLimited, demoKey };
}
