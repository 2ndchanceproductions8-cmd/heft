import { useEffect, useState } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import { Button, Sheet, Spinner } from '../../components/ui';
import { choiceFromFood, upsertFood, useRecentFoods } from '../../lib/nutrition/store';
import { searchFoods } from '../../lib/nutrition/usda';
import type { FoodChoice } from '../../lib/nutrition/types';
import { GramsSheet, SourceChip } from './ui';
import { per100Line, quickAmounts } from './meal/format';
import { HeaderButton } from './meal/parts';

export interface FoodSearchSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * 'add': picking a food then asks for grams (GramsSheet) and calls onPick(choice, grams).
   * 'change': picking calls onPick(choice, null) immediately (the caller keeps the item's grams and name).
   */
  mode: 'add' | 'change';
  initialQuery?: string;
  title?: string;
  /** Called after the food has been saved to the recents library (upsertFood). The sheet closes itself. */
  onPick: (choice: FoodChoice, grams: number | null) => void;
}

/**
 * Full-height USDA search: recents when the query is empty, otherwise a debounced FoodData Central search.
 * Every response state (loading / no matches / rate limited / unreachable) has its own message.
 */
export function FoodSearchSheet({ open, onClose, mode, initialQuery, title, onPick }: FoodSearchSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="full"
      title={title ?? (mode === 'add' ? 'Add food' : 'Change food')}
      left={<HeaderButton onClick={onClose}>Cancel</HeaderButton>}
    >
      {/* Mounted only while open, so every opening starts fresh from initialQuery. */}
      <SearchBody mode={mode} initialQuery={initialQuery ?? ''} onPick={onPick} onClose={onClose} />
    </Sheet>
  );
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading'; q: string }
  | { kind: 'ok'; q: string; foods: FoodChoice[] }
  | { kind: 'rate_limited'; q: string; demoKey: boolean }
  | { kind: 'failed'; q: string };

const DEBOUNCE_MS = 350;

function SearchBody({
  mode,
  initialQuery,
  onPick,
  onClose,
}: {
  mode: 'add' | 'change';
  initialQuery: string;
  onPick: FoodSearchSheetProps['onPick'];
  onClose: () => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [amountFor, setAmountFor] = useState<FoodChoice | null>(null);
  const recents = useRecentFoods();
  const term = q.trim();

  useEffect(() => {
    if (!term) {
      setState({ kind: 'idle' });
      return;
    }
    setState({ kind: 'loading', q: term });
    // One controller per query: a newer keystroke aborts the older request, and a late answer to an
    // aborted request is ignored, so results can never arrive out of order.
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      searchFoods(term, { signal: ctrl.signal })
        .then((r) => {
          if (ctrl.signal.aborted) return;
          if (r.status === 'ok') setState({ kind: 'ok', q: term, foods: r.foods });
          else if (r.status === 'rate_limited') setState({ kind: 'rate_limited', q: term, demoKey: r.demoKey });
          else setState({ kind: 'failed', q: term });
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setState({ kind: 'failed', q: term });
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [term, nonce]);

  const pick = async (c: FoodChoice) => {
    if (busyId) return;
    setBusyId(c.id);
    try {
      await upsertFood(c);
    } catch {
      // The recents library is a convenience; the pick itself still goes through.
    }
    setBusyId(null);
    if (mode === 'change') {
      onPick(c, null);
      onClose();
    } else {
      setAmountFor(c);
    }
  };

  let body;
  if (!term) {
    if (recents === undefined) body = <SearchMessage kind="loading" />;
    else if (!recents.length) body = <SearchMessage kind="start" />;
    else
      body = (
        <>
          <div className="pb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">Recent</div>
          <FoodList foods={recents.map(choiceFromFood)} busyId={busyId} onPick={(c) => void pick(c)} />
        </>
      );
  } else if (state.kind === 'ok') {
    body = state.foods.length ? (
      <FoodList foods={state.foods} busyId={busyId} onPick={(c) => void pick(c)} />
    ) : (
      <SearchMessage kind="no_matches" query={state.q} />
    );
  } else if (state.kind === 'rate_limited') {
    body = <SearchMessage kind="rate_limited" demoKey={state.demoKey} onRetry={() => setNonce((n) => n + 1)} />;
  } else if (state.kind === 'failed') {
    body = <SearchMessage kind="failed" onRetry={() => setNonce((n) => n + 1)} />;
  } else {
    body = <SearchMessage kind="loading" />;
  }

  return (
    <>
      <div className="sticky top-0 z-10 bg-surface px-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-faint" />
          <input
            autoFocus
            type="text"
            inputMode="search"
            enterKeyHint="search"
            aria-label="Search foods"
            placeholder="Search foods, e.g. white rice"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            className="h-11 w-full rounded-xl border border-line bg-surface-2 pr-11 pl-10 text-[16px] text-fg outline-none placeholder:text-faint focus:border-accent"
          />
          {q ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQ('')}
              className="absolute top-0 right-0 flex h-11 w-11 items-center justify-center text-faint active:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="px-4 pb-6">{body}</div>
      <GramsSheet
        open={!!amountFor}
        onClose={() => setAmountFor(null)}
        title={amountFor?.name ?? ''}
        subtitle={amountFor ? `Per 100 g: ${per100Line(amountFor.per100g)}` : undefined}
        initialGrams={amountFor?.servingG ?? 100}
        quick={quickAmounts(amountFor?.servingG)}
        onSave={(g) => {
          if (!amountFor) return;
          onPick(amountFor, g);
          onClose();
        }}
      />
    </>
  );
}

function FoodList({ foods, busyId, onPick }: { foods: FoodChoice[]; busyId: string | null; onPick: (c: FoodChoice) => void }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface-2">
      {foods.map((f) => (
        <FoodRow key={f.id} food={f} busy={busyId === f.id} disabled={!!busyId} onPick={() => onPick(f)} />
      ))}
    </div>
  );
}

/** One search hit / recent food: name, brand or USDA data type, and its per-100 g numbers. */
export function FoodRow({ food, onPick, busy, disabled }: { food: FoodChoice; onPick: () => void; busy?: boolean; disabled?: boolean }) {
  const sub = food.brand || food.dataType || (food.source === 'off' ? 'Open Food Facts' : 'USDA');
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className="flex min-h-14 w-full items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-surface-3 disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[15px] leading-snug font-medium text-fg">{food.name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
          <SourceChip source={food.source} className="shrink-0" />
          <span className="truncate">{sub}</span>
        </span>
        <span className="mt-0.5 block text-[12px] text-faint tabular-nums">per 100 g: {per100Line(food.per100g)}</span>
      </span>
      {busy ? <Spinner className="h-5 w-5" /> : <ChevronRight className="h-5 w-5 shrink-0 text-faint" />}
    </button>
  );
}

export type SearchMessageKind = 'loading' | 'start' | 'no_matches' | 'rate_limited' | 'failed';

/** The non-result states of the search sheet, each with its own message. */
export function SearchMessage({
  kind,
  query,
  demoKey,
  onRetry,
}: {
  kind: SearchMessageKind;
  query?: string;
  demoKey?: boolean;
  onRetry?: () => void;
}) {
  if (kind === 'loading') {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-[14px] text-muted" role="status">
        <Spinner />
        Searching…
      </div>
    );
  }
  let title: string;
  let message: string;
  if (kind === 'start') {
    title = 'Search USDA FoodData Central';
    message = 'Type a food, e.g. "greek yogurt" or "banana". Foods you pick show up here next time.';
  } else if (kind === 'no_matches') {
    title = query ? `No matches for “${query}”` : 'No matches';
    message = 'Try fewer or more general words, e.g. "rice" instead of "jasmine rice bowl".';
  } else if (kind === 'rate_limited') {
    title = 'USDA is busy';
    message = demoKey
      ? "USDA's shared demo key is busy — add your free key in Food settings."
      : 'USDA rate limit — try again in a minute.';
  } else {
    title = 'No connection';
    message = "Couldn't reach USDA. Check your connection.";
  }
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center" role={kind === 'start' ? undefined : 'status'}>
      <div className="text-[16px] font-semibold">{title}</div>
      <div className="mt-1 max-w-xs text-[14px] leading-snug text-muted">{message}</div>
      {onRetry && (kind === 'failed' || kind === 'rate_limited') ? (
        <Button variant="secondary" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
