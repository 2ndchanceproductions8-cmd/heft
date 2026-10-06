import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarDays, ScanBarcode, Search, Sparkles } from 'lucide-react';
import { Button, confirm, ListRow, Loading, Page, Spinner, toast, TopBar } from '../../components/ui';
import { deleteMedia } from '../../lib/media';
import { atForDay, dayKey } from '../../lib/nutrition/math';
import { PhotoError, saveMealPhoto } from '../../lib/nutrition/photos';
import { createMeal, deleteMeal, updateMeal, useMeal } from '../../lib/nutrition/store';
import { useNutritionKeys } from '../../lib/nutrition/keys';
import type { FoodChoice, Meal } from '../../lib/nutrition/types';
import { displayMass, massToG, parseDecimal, type MassUnit } from '../../lib/units';
import { DetailsPanel, ScaleTip } from './capture/DetailsPanel';
import { createDraftSaver, type DraftSaver } from './capture/draftSaver';
import { MAX_PHOTOS, ShotTray } from './capture/ShotTray';
import { FoodSearchSheet } from './FoodSearchSheet';
import { keepCapture, logSearchFromCapture, writeDraftText, type DraftText } from './meal/actions';
import { dayLabel } from './meal/format';
import { diaryPath, historyIdx, mealPath, scanPath, validDay } from './meal/nav';
import { BackButton, HeaderButton } from './meal/parts';
import { convertMassText, useMassUnit } from './ui';

/** Grams from the weight field: null when empty, 'invalid' for junk / zero. */
export function parseWeightField(text: string, mu: MassUnit): number | null | 'invalid' {
  if (!text.trim()) return null;
  const v = parseDecimal(text);
  if (v == null || v <= 0) return 'invalid';
  return Math.round(massToG(v, mu) * 10) / 10;
}

/** The typed fields as the draft stores them (an invalid weight is stored as none). */
export function draftText(description: string, weightText: string, mu: MassUnit): DraftText {
  const w = parseWeightField(weightText, mu);
  return { description, weightG: w === 'invalid' ? null : w };
}

/**
 * The day a capture logs to: `?d=`, else a resumed draft's own day (a draft from yesterday opened from an old
 * link without `?d=` still logs on yesterday), else null = today.
 */
export function captureDay(dayParam: string | null, resumed: Pick<Meal, 'day'> | null, today: string): string | null {
  if (dayParam) return dayParam;
  return resumed && resumed.day && resumed.day !== today ? resumed.day : null;
}

/**
 * /nutrition/log — photograph a meal (up to 4 angles) and/or describe it, then Analyze. The first photo
 * saves a 'draft' meal right away (an iOS kill can't lose it; the Diary lists drafts), `?meal=<id>` resumes
 * one, `?d=<day>` logs on another day. Barcode and database search are the alternatives. The back chevron
 * ("Save for later") keeps the draft; "Discard" deletes it.
 */
export function CapturePage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const resumeId = useRef(params.get('meal'));
  const keys = useNutritionKeys();

  const [draftId, setDraftId] = useState<string | null>(resumeId.current);
  const live = useMeal(draftId);
  // The row our own last write returned, shown while the live query for a new id is still loading.
  const [known, setKnown] = useState<Meal | null>(null);
  const draft: Meal | null = live === undefined ? (known && known.id === draftId ? known : null) : live;
  const draftRef = useRef<Meal | null>(null);
  useEffect(() => {
    if (live !== undefined) draftRef.current = live;
  }, [live]);
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  const liveRef = useRef(live);
  liveRef.current = live;

  const today = dayKey(Date.now());
  const resumed = draft && draft.id === resumeId.current ? draft : null;
  const day = captureDay(validDay(params.get('d')), resumed, today);
  const dayRef = useRef(day);
  dayRef.current = day;

  const [description, setDescription] = useState('');
  const [weightText, setWeightText] = useState('');
  const [weightError, setWeightError] = useState<string | null>(null);
  const [mu, setMu] = useMassUnit();
  const [saving, setSaving] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [searching, setSearching] = useState(false);
  const latest = useRef({ description, weightText, mu });
  latest.current = { description, weightText, mu };
  const typedNow = () => draftText(latest.current.description, latest.current.weightText, latest.current.mu);
  // Typed text → the draft row: 600 ms after the last keystroke, and at once before leaving / on unmount.
  const saverRef = useRef<DraftSaver | null>(null);
  if (!saverRef.current) {
    saverRef.current = createDraftSaver({
      target: () => {
        const cur = draftRef.current;
        return cur && cur.id === draftIdRef.current && cur.status === 'draft' ? { draftId: cur.id, text: typedNow() } : null;
      },
      write: writeDraftText,
    });
  }
  const saver = saverRef.current;

  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  // Photo saves / removals run one at a time so a burst of picks can't race on the draft row.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (job: () => Promise<void>) => {
    const run = queue.current.then(job).catch(() => undefined);
    queue.current = run;
    return run;
  };

  const setDraftParam = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('meal', id);
        else next.delete('meal');
        return next;
      },
      { replace: true },
    );

  // Resuming a draft: bring back what was typed before, and pin its day in the URL (?d=) so the banner, the
  // exit and any meal created from here stay on that day even if the draft row goes away (last photo removed).
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !live || live.id !== resumeId.current) return;
    prefilled.current = true;
    if (live.input.description) setDescription(live.input.description);
    if (live.input.weightG) setWeightText(String(displayMass(live.input.weightG, latest.current.mu) ?? ''));
    const pinned = captureDay(null, live, dayKey(Date.now()));
    if (pinned) {
      setParams(
        (prev) => {
          if (validDay(prev.get('d'))) return prev;
          const next = new URLSearchParams(prev);
          next.set('d', pinned);
          return next;
        },
        { replace: true },
      );
    }
    // setParams is stable enough for a run-once effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // The unit flipped (toggle, or settings finished loading): convert the typed weight instead of reinterpreting it.
  const prevMu = useRef(mu);
  useEffect(() => {
    if (prevMu.current === mu) return;
    setWeightText(convertMassText(latest.current.weightText, prevMu.current, mu));
    prevMu.current = mu;
  }, [mu]);

  // Leaving the screen any way at all (tab switch, browser back) still writes the last keystrokes.
  useEffect(
    () => () => {
      void saver.flush();
    },
    [saver],
  );

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    setSaving((s) => s + 1);
    void enqueue(async () => {
      let skipped = 0;
      try {
        for (const file of files) {
          const cur = draftRef.current;
          if ((cur?.photoIds.length ?? 0) >= MAX_PHOTOS) {
            skipped++;
            continue;
          }
          let mediaId: string;
          try {
            mediaId = await saveMealPhoto(file);
          } catch (e) {
            toast(e instanceof PhotoError ? e.message : "Couldn't read that photo", 'error');
            continue;
          }
          try {
            let saved: Meal | null = null;
            if (cur) {
              saved = await updateMeal(cur.id, (m) => (m.photoIds.length >= MAX_PHOTOS ? {} : { photoIds: [...m.photoIds, mediaId] }));
            }
            if (!saved) {
              // The first photo creates the draft row immediately, with whatever is typed so far.
              saver.clear();
              const t = typedNow();
              saved = await createMeal({
                status: 'draft',
                input: { kind: 'photo', description: t.description.trim() || undefined, weightG: t.weightG },
                at: atForDay(dayRef.current, Date.now()),
                photoIds: [mediaId],
              });
              draftIdRef.current = saved.id;
              setDraftId(saved.id);
              setDraftParam(saved.id);
            }
            if (!saved.photoIds.includes(mediaId)) {
              await deleteMedia([mediaId]);
              skipped++;
            }
            draftRef.current = saved;
            setKnown(saved);
            // Typed while the row was being created: it has somewhere to go now.
            if (saver.dirty) void saver.flush();
          } catch {
            await deleteMedia([mediaId]).catch(() => undefined);
            toast("Couldn't save the photo", 'error');
          }
        }
      } finally {
        setSaving((s) => s - 1);
        if (skipped) toast(`Up to ${MAX_PHOTOS} photos per meal`, 'info');
      }
    });
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    addFiles(files);
  };

  const removePhoto = (mediaId: string) =>
    void enqueue(async () => {
      const cur = draftRef.current;
      if (!cur) return;
      try {
        const saved = await updateMeal(cur.id, (m) => ({ photoIds: m.photoIds.filter((x) => x !== mediaId) }));
        await deleteMedia([mediaId]);
        const text = typedNow();
        const hasText = !!text.description.trim() || !!text.weightG || !!saved?.input.description?.trim() || !!saved?.input.weightG;
        if (saved && !saved.photoIds.length && hasText) {
          // Last photo gone but there's typing (a text draft the user saved for later): keep it as a text draft.
          saver.clear();
          const kept = await updateMeal(saved.id, (m) => ({
            input: {
              ...m.input,
              kind: 'text',
              description: text.description.trim() ? text.description : m.input.description,
              weightG: text.weightG ?? m.input.weightG ?? null,
            },
          }));
          if (kept) {
            draftRef.current = kept;
            setKnown(kept);
          }
        } else if (saved && !saved.photoIds.length) {
          // No photos and nothing typed: an empty draft would just clutter the Diary.
          await deleteMeal(saved.id);
          draftRef.current = null;
          draftIdRef.current = null;
          setKnown(null);
          setDraftId(null);
          setDraftParam(null);
        } else if (saved) {
          draftRef.current = saved;
          setKnown(saved);
        }
      } catch {
        toast("Couldn't remove the photo", 'error');
      }
    });

  /** Destructive: delete the draft (and its photos) after a confirm, then back (to the Diary when there's no history). */
  const discard = async () => {
    if (submitting) return;
    await queue.current;
    const cur = draftRef.current;
    const n = cur?.photoIds.length ?? 0;
    const typed = !!latest.current.description.trim() || !!latest.current.weightText.trim();
    if (n || typed) {
      const ok = await confirm({
        title: 'Discard this meal?',
        message: n ? (n === 1 ? 'The photo will be deleted.' : `The ${n} photos will be deleted.`) : 'What you typed will be lost.',
        danger: true,
        confirmLabel: 'Discard',
      });
      if (!ok) return;
    }
    saver.clear();
    if (cur) {
      try {
        await deleteMeal(cur.id);
      } catch {
        toast("Couldn't discard the meal", 'error');
        return;
      }
    }
    // Nothing is left in the Diary to show: go back where the owner came from.
    if (historyIdx() > 0) nav(-1);
    else nav(diaryPath(dayRef.current), { replace: true });
  };

  /**
   * Keep whatever is here as a draft (see keepCapture) and return its id. Waits for photo saves first. While
   * a resumed draft is still loading nothing is touched.
   */
  const keep = async (): Promise<string | null> => {
    await queue.current;
    if (draftIdRef.current && !draftRef.current && liveRef.current === undefined) return null; // still loading
    saver.clear(); // keepCapture writes the typed text itself
    return keepCapture({ draft: draftRef.current, text: typedNow(), atIfNew: atForDay(dayRef.current, Date.now()) });
  };

  // One exit at a time: a double tap on "Save for later" / "Scan" must not create two draft rows.
  const leaving = useRef(false);

  /** Non-destructive exit ("Save for later" / back): the draft stays in the Diary, on its day. */
  const exit = async () => {
    if (submitting || leaving.current) return;
    leaving.current = true;
    let id: string | null = null;
    try {
      id = await keep();
    } catch {
      leaving.current = false;
      toast("Couldn't save the meal for later", 'error');
      return;
    }
    // Nothing was kept: go back where the owner came from (Today or the Diary). A saved draft goes to the Diary so they see where it went.
    if (!id && historyIdx() > 0) nav(-1);
    else nav(diaryPath(dayRef.current), { replace: true });
  };

  const analyze = async () => {
    if (submitting) return;
    const desc = description.trim();
    const w = parseWeightField(weightText, mu);
    if (w === 'invalid') {
      setWeightError('Enter a weight above 0, or leave it empty.');
      return;
    }
    setSubmitting(true);
    try {
      await queue.current;
      const cur = draftRef.current;
      saver.clear(); // the input is written right here
      let id: string;
      if (cur && cur.photoIds.length) {
        const saved = await updateMeal(cur.id, {
          input: { kind: 'photo', description: desc || undefined, weightG: w },
          status: 'pending',
          error: null,
        });
        if (!saved) throw new Error('draft vanished');
        id = saved.id;
      } else {
        if (!desc) {
          setSubmitting(false);
          return;
        }
        if (cur) await deleteMeal(cur.id);
        const m = await createMeal({ status: 'pending', input: { kind: 'text', description: desc, weightG: w }, at: atForDay(dayRef.current, Date.now()) });
        id = m.id;
      }
      nav(mealPath(id), { replace: true });
    } catch {
      toast("Couldn't save the meal", 'error');
      setSubmitting(false);
    }
  };

  const addFromSearch = async (c: FoodChoice, grams: number | null) => {
    if (grams == null) return;
    setSubmitting(true);
    try {
      await queue.current;
      await saver.flush(); // saved first, in case logging the food fails
      // A draft with photos becomes this meal (its photos shrink to one); otherwise a new meal is logged.
      const id = await logSearchFromCapture({ draft: draftRef.current, food: c, grams, atIfNew: atForDay(dayRef.current, Date.now()) });
      nav(mealPath(id), { replace: true });
    } catch {
      toast("Couldn't save the food", 'error');
      setSubmitting(false);
    }
  };

  /** The barcode screen, carrying the draft along (?meal=): the scanned product finishes it, photos included. */
  const scanInstead = async () => {
    if (submitting || leaving.current) return;
    leaving.current = true;
    let id: string | null;
    try {
      id = await keep();
    } catch {
      leaving.current = false;
      toast("Couldn't save the meal", 'error');
      return;
    }
    nav(scanPath({ meal: id, d: dayRef.current }), { replace: true });
  };

  if (draft && draft.status !== 'draft') return <Navigate to={mealPath(draft.id)} replace />;

  const resuming = !!resumeId.current && draftId === resumeId.current && live === undefined && !known;
  const photoIds = draft?.photoIds ?? [];
  const canAnalyze = (photoIds.length > 0 || description.trim().length > 0) && !saving && !submitting;
  const hasContent = !resuming && (photoIds.length > 0 || !!description.trim() || !!weightText.trim());

  return (
    <Page>
      <TopBar
        title="Log food"
        left={
          <BackButton
            text={hasContent ? 'Save for later' : undefined}
            disabled={submitting}
            onClick={() => void exit()}
          />
        }
        right={
          hasContent ? (
            <HeaderButton tone="danger" disabled={submitting} onClick={() => void discard()}>
              Discard
            </HeaderButton>
          ) : null
        }
      />
      {resuming ? (
        <Loading />
      ) : (
        <>
          <div className="space-y-3 px-4 pt-4">
            {day && day !== today ? (
              <div className="flex items-center gap-2 rounded-xl bg-accent-soft px-3 py-2 text-[14px] font-medium text-accent">
                <CalendarDays className="h-4 w-4" />
                Logging for {dayLabel(day, today)}
              </div>
            ) : null}
            <ShotTray
              photoIds={photoIds}
              saving={saving > 0}
              onCamera={() => cameraRef.current?.click()}
              onLibrary={() => libraryRef.current?.click()}
              onRemove={removePhoto}
            />
            <ScaleTip />
            <DetailsPanel
              description={description}
              onDescription={(v) => {
                saver.typed();
                setDescription(v);
              }}
              weightText={weightText}
              onWeightText={(v) => {
                saver.typed();
                setWeightError(null);
                setWeightText(v);
              }}
              mu={mu}
              onMu={setMu}
              weightError={weightError}
            />
            <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface">
              <ListRow icon={<ScanBarcode className="h-5 w-5" />} title="Scan a barcode instead" chevron onClick={() => void scanInstead()} />
              <ListRow icon={<Search className="h-5 w-5" />} title="Search foods" chevron onClick={() => setSearching(true)} />
            </div>
          </div>
          <div className="sticky bottom-0 z-20 mt-4 border-t border-line/60 bg-bg/90 px-4 pt-3 pb-safe backdrop-blur-xl">
            <Button
              block
              size="lg"
              disabled={!canAnalyze}
              onClick={() => void analyze()}
              icon={submitting ? <Spinner className="h-5 w-5 text-on-accent" /> : <Sparkles className="h-5 w-5" />}
            >
              Analyze
            </Button>
            <p className="py-2 text-center text-[12px] text-faint">
              {!keys.anthropic
                ? 'No Claude key yet — Analyze saves the meal; it runs once you add a key in Food settings.'
                : photoIds.length || description.trim()
                  ? 'Claude names the foods and portions; USDA supplies the numbers.'
                  : 'Add a photo or a description to analyze.'}
            </p>
          </div>
        </>
      )}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
      <input ref={libraryRef} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
      <FoodSearchSheet open={searching} onClose={() => setSearching(false)} mode="add" title="Search foods" onPick={(c, g) => void addFromSearch(c, g)} />
    </Page>
  );
}
