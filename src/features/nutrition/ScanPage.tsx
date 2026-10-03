import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarDays, CloudOff, PackageSearch, ScanBarcode, Utensils } from 'lucide-react';
import { Button, EmptyState, Loading, Page, Spinner, TextField, toast, TopBar } from '../../components/ui';
import { decodeBarcodeFromImage, normalizeBarcode } from '../../lib/nutrition/barcode';
import { atForDay, dayKey } from '../../lib/nutrition/math';
import { lookupBarcode } from '../../lib/nutrition/off';
import { choiceFromFood, createMeal, foodByBarcode, itemFromChoice, MealBusyError, upsertFood, useMeal } from '../../lib/nutrition/store';
import type { FoodChoice, Meal } from '../../lib/nutrition/types';
import { FoodSearchSheet } from './FoodSearchSheet';
import { addProductToMeal } from './meal/actions';
import { barcodeCandidates, dayLabel, mealDisplayTitle, per100Line, quickAmounts } from './meal/format';
import { diaryPath, historyIdx, logPath, mealPath, validDay } from './meal/nav';
import { BackButton, Notice } from './meal/parts';
import { ProductCard } from './scan/ProductCard';
import { GramsSheet } from './ui';

type ScanState =
  | { kind: 'idle' }
  | { kind: 'decoding' }
  | { kind: 'looking'; code: string }
  | { kind: 'found'; code: string; food: FoodChoice }
  | { kind: 'not_found'; code: string }
  | { kind: 'unavailable'; code: string };

/** The banner over the scanner: what the product will be logged into. */
export function scanTargetBanner(target: Pick<Meal, 'status' | 'day' | 'photoIds' | 'title' | 'items' | 'input'> | null, day: string | null, today: string) {
  if (target && target.status !== 'draft') return { kind: 'adding' as const, text: `Adding to ${mealDisplayTitle(target)}` };
  // A capture draft ("Scan a barcode instead") becomes a new meal on its own day, keeping its photos.
  const on = target ? target.day : day;
  const n = target?.photoIds.length ?? 0;
  return {
    kind: 'new' as const,
    day: on && on !== today ? `Logging for ${dayLabel(on, today)}` : null,
    photos: n ? (n === 1 ? 'Your photo stays with this meal' : 'Your first photo stays with this meal') : null,
  };
}

/**
 * /nutrition/scan — a product's numbers straight from its label (Open Food Facts). No live viewfinder: an iOS
 * home-screen app re-asks for camera permission on every launch, so the barcode is read from a photo (which
 * is NOT saved) or typed. `?meal=<id>` adds the product to that meal (a capture DRAFT becomes the finished
 * meal, photos kept); otherwise it becomes a new meal on `?d`.
 */
export function ScanPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const mealId = params.get('meal');
  const day = validDay(params.get('d'));
  const target = useMeal(mealId);
  const isDraft = target?.status === 'draft';
  const [code, setCode] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const [gramsOpen, setGramsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  useEffect(() => () => ctrlRef.current?.abort(), []);

  const back = () => {
    // A capture draft goes back to its capture screen (the capture page replaced itself with this one).
    if (mealId && isDraft) nav(logPath({ meal: mealId, d: day }), { replace: true });
    else if (historyIdx() > 0) nav(-1);
    else nav(mealId ? mealPath(mealId) : diaryPath(day), { replace: true });
  };

  const lookup = async (raw: string) => {
    let norm: string | null = null;
    try {
      norm = normalizeBarcode(raw);
    } catch {
      norm = null;
    }
    if (!norm) {
      setInputError("That doesn't look like a product barcode — they have 8, 12 or 13 digits.");
      return;
    }
    setInputError(null);
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState({ kind: 'looking', code: norm });

    // Scanned before? The cached label works offline.
    try {
      for (const c of barcodeCandidates(norm)) {
        const cached = await foodByBarcode(c);
        if (cached) {
          if (ctrl.signal.aborted) return;
          setState({ kind: 'found', code: norm, food: choiceFromFood(cached) });
          setGramsOpen(true);
          return;
        }
      }
    } catch {
      // A cache read failing just means asking Open Food Facts.
    }

    try {
      const r = await lookupBarcode(norm, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (r.status === 'ok' && r.food) {
        setState({ kind: 'found', code: norm, food: r.food });
        setGramsOpen(true);
      } else if (r.status === 'not_found') {
        setState({ kind: 'not_found', code: norm });
      } else {
        setState({ kind: 'unavailable', code: norm });
      }
    } catch {
      if (!ctrl.signal.aborted) setState({ kind: 'unavailable', code: norm });
    }
  };

  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    ctrlRef.current?.abort();
    setGramsOpen(false);
    setState({ kind: 'decoding' });
    let read: string | null;
    try {
      read = await decodeBarcodeFromImage(file);
    } catch {
      setState({ kind: 'idle' });
      toast("Couldn't read that photo — type the digits instead", 'error');
      return;
    }
    if (!read) {
      setState({ kind: 'idle' });
      toast('No barcode found — fill the frame with it, in good light', 'error');
      return;
    }
    setCode(read);
    await lookup(read);
  };

  const commit = async (food: FoodChoice, grams: number, via: 'barcode' | 'search') => {
    if (saving) return;
    setSaving(true);
    try {
      if (via === 'barcode') {
        try {
          await upsertFood(food);
        } catch {
          // Caching the product is a convenience; logging it still goes through.
        }
      }
      if (mealId) {
        // A draft from the capture screen becomes this finished meal (photos shrunk to one); any other meal
        // just gets the item.
        const saved = await addProductToMeal(mealId, food, grams, via);
        if (!saved) {
          toast('That meal no longer exists', 'error');
          setSaving(false);
          return;
        }
        nav(mealPath(mealId), { replace: true });
      } else {
        const item = itemFromChoice(food, grams);
        const m = await createMeal({
          input: { kind: via },
          status: 'done',
          at: atForDay(day, Date.now()),
          title: food.name,
          items: [item],
          confidence: via === 'barcode' ? 'high' : null,
        });
        nav(mealPath(m.id), { replace: true });
      }
    } catch (err) {
      toast(err instanceof MealBusyError ? err.message : "Couldn't save the food", 'error');
      setSaving(false);
    }
  };

  const reset = () => {
    ctrlRef.current?.abort();
    setGramsOpen(false);
    setState({ kind: 'idle' });
    setCode('');
    setInputError(null);
  };

  const header = <TopBar left={<BackButton onClick={back} />} title="Scan barcode" />;
  if (mealId && target === undefined) {
    return (
      <Page>
        {header}
        <Loading />
      </Page>
    );
  }
  if (mealId && target === null) {
    return (
      <Page>
        {header}
        <EmptyState
          icon={<Utensils className="h-7 w-7" />}
          title="Meal not found"
          message="The meal you were adding to was deleted."
          action={<Button onClick={() => nav(diaryPath(day), { replace: true })}>Back to Food</Button>}
        />
      </Page>
    );
  }

  const busy = state.kind === 'decoding' || state.kind === 'looking' || saving;
  const today = dayKey(Date.now());
  const found = state.kind === 'found' ? state : null;
  const banner = scanTargetBanner(target ?? null, day, today);

  return (
    <Page>
      {header}
      <div className="space-y-3 px-4 pt-4">
        {banner.kind === 'adding' ? (
          <div className="truncate rounded-xl bg-accent-soft px-3 py-2 text-[14px] font-medium text-accent">{banner.text}</div>
        ) : banner.day || banner.photos ? (
          <div className="space-y-0.5 rounded-xl bg-accent-soft px-3 py-2 text-[14px] font-medium text-accent">
            {banner.day ? (
              <div className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                {banner.day}
              </div>
            ) : null}
            {banner.photos ? <div>{banner.photos}</div> : null}
          </div>
        ) : null}

        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="flex h-36 w-full flex-col items-center justify-center gap-2 rounded-2xl bg-accent px-4 text-on-accent active:brightness-90 disabled:opacity-60"
        >
          {state.kind === 'decoding' ? (
            <>
              <Spinner className="h-8 w-8 text-on-accent" />
              <span className="text-[16px] font-semibold">Reading the barcode…</span>
            </>
          ) : (
            <>
              <ScanBarcode className="h-10 w-10" />
              <span className="text-[17px] font-semibold">Take a photo of the barcode</span>
              <span className="text-[13px] opacity-80">Fill the frame with it, in good light</span>
            </>
          )}
        </button>

        <form
          className="rounded-2xl bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            (document.activeElement as HTMLElement | null)?.blur?.();
            void lookup(code);
          }}
        >
          <label htmlFor="barcode-digits" className="mb-1.5 block text-[13px] font-medium text-muted">
            Or type the number under the bars
          </label>
          <div className="flex gap-2">
            <TextField
              id="barcode-digits"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              enterKeyHint="search"
              maxLength={14}
              placeholder="e.g. 3017620422003"
              value={code}
              aria-invalid={!!inputError}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, ''));
                setInputError(null);
              }}
              className="min-w-0 flex-1 text-[16px] tabular-nums"
            />
            <Button type="submit" disabled={!code || busy} className="shrink-0">
              Look up
            </Button>
          </div>
          {inputError ? <p className="mt-1.5 text-[13px] text-danger">{inputError}</p> : null}
        </form>

        {state.kind === 'looking' ? (
          <div className="flex items-center justify-center gap-3 rounded-2xl bg-surface p-5 text-[15px] text-muted" role="status">
            <Spinner className="h-5 w-5" />
            <span className="tabular-nums">Looking up {state.code}…</span>
          </div>
        ) : null}

        {found ? (
          <>
            <ProductCard food={found.food} code={found.code} />
            <Button block size="lg" disabled={saving} onClick={() => setGramsOpen(true)}>
              {saving ? <Spinner className="h-5 w-5 text-on-accent" /> : null}
              Choose amount
            </Button>
            <Button block variant="secondary" disabled={saving} onClick={reset}>
              Scan another
            </Button>
          </>
        ) : null}

        {state.kind === 'not_found' ? (
          <Notice
            tone="warn"
            icon={<PackageSearch className="h-5 w-5" />}
            title="Not in Open Food Facts"
            actions={
              <Button block variant="secondary" onClick={() => setSearchOpen(true)}>
                Search foods instead
              </Button>
            }
          >
            Nobody has added {state.code} to the open database yet.
          </Notice>
        ) : null}

        {state.kind === 'unavailable' ? (
          <Notice
            tone="danger"
            icon={<CloudOff className="h-5 w-5" />}
            title="Couldn't reach Open Food Facts"
            actions={
              <Button block variant="secondary" onClick={() => void lookup(state.code)}>
                Retry
              </Button>
            }
          >
            Check your connection and try again.
          </Notice>
        ) : null}

        {state.kind === 'idle' ? (
          <p className="px-2 text-center text-[13px] text-faint">Products you log are saved on this phone, so scanning them again works offline.</p>
        ) : null}
      </div>

      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onPhoto(e)} />
      <GramsSheet
        open={gramsOpen && !!found}
        onClose={() => setGramsOpen(false)}
        title={found?.food.name ?? ''}
        subtitle={found ? `Per 100 g: ${per100Line(found.food.per100g)}` : undefined}
        initialGrams={found?.food.servingG ?? null}
        quick={quickAmounts(found?.food.servingG)}
        saveLabel={mealId && !isDraft ? 'Add to meal' : 'Log it'}
        onSave={(g) => {
          if (found) void commit(found.food, g, 'barcode');
        }}
      />
      <FoodSearchSheet
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        mode="add"
        title="Search foods"
        onPick={(c, g) => {
          if (g != null) void commit(c, g, 'search');
        }}
      />
    </Page>
  );
}
