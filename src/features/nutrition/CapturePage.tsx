import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarDays, ScanBarcode, Search, Sparkles } from 'lucide-react';
import { Button, confirm, ListRow, Loading, Page, Spinner, toast, TopBar } from '../../components/ui';
import { deleteMedia } from '../../lib/media';
import { atForDay, dayKey } from '../../lib/nutrition/math';
import { PhotoError, saveMealPhoto } from '../../lib/nutrition/photos';
import { createMeal, deleteMeal, itemFromChoice, updateMeal, useMeal } from '../../lib/nutrition/store';
import { useNutritionKeys } from '../../lib/nutrition/keys';
import type { FoodChoice, Meal } from '../../lib/nutrition/types';
import { displayMass, massToG, parseDecimal, type MassUnit } from '../../lib/units';
import { DetailsPanel, ScaleTip } from './capture/DetailsPanel';
import { MAX_PHOTOS, ShotTray } from './capture/ShotTray';
import { FoodSearchSheet } from './FoodSearchSheet';
import { dayLabel } from './meal/format';
import { diaryPath, mealPath, scanPath, validDay } from './meal/nav';
import { HeaderButton } from './meal/parts';
import { useMassUnit } from './ui';

/** Grams from the weight field: null when empty, 'invalid' for junk / zero. */
export function parseWeightField(text: string, mu: MassUnit): number | null | 'invalid' {
  if (!text.trim()) return null;
  const v = parseDecimal(text);
  if (v == null || v <= 0) return 'invalid';
  return Math.round(massToG(v, mu) * 10) / 10;
}

/**
 * /nutrition/log — photograph a meal (up to 4 angles) and/or describe it, then Analyze. The first photo
 * saves a 'draft' meal right away (an iOS kill can't lose it; the Diary lists drafts), `?meal=<id>` resumes
 * one, `?d=<day>` logs on another day. Barcode and database search are the alternatives.
 */
export function CapturePage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const day = validDay(params.get('d'));
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

  const [description, setDescription] = useState('');
  const [weightText, setWeightText] = useState('');
  const [weightError, setWeightError] = useState<string | null>(null);
  const [mu, setMu] = useMassUnit();
  const [saving, setSaving] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [searching, setSearching] = useState(false);
  const dirty = useRef(false);
  const latest = useRef({ description, weightText, mu });
  latest.current = { description, weightText, mu };

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

  // Resuming a draft: bring back what was typed before.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !live || live.id !== resumeId.current) return;
    prefilled.current = true;
    if (live.input.description) setDescription(live.input.description);
    if (live.input.weightG) setWeightText(String(displayMass(live.input.weightG, latest.current.mu) ?? ''));
  }, [live]);

  // The unit flipped (toggle, or settings finished loading): convert the typed weight instead of reinterpreting it.
  const prevMu = useRef(mu);
  useEffect(() => {
    if (prevMu.current === mu) return;
    const v = parseDecimal(latest.current.weightText);
    if (v != null && v > 0) setWeightText(String(displayMass(massToG(v, prevMu.current), mu) ?? ''));
    prevMu.current = mu;
  }, [mu]);

  // Keep the draft's description / weight saved too (debounced) — only after the user typed something.
  useEffect(() => {
    if (!draftId || !dirty.current) return;
    const t = window.setTimeout(() => {
      if (draftRef.current?.id !== draftId || draftRef.current.status !== 'draft') return;
      const { description: desc, weightText: wt, mu: unit } = latest.current;
      const w = parseWeightField(wt, unit);
      void updateMeal(draftId, (m) =>
        m.status === 'draft' ? { input: { ...m.input, description: desc.trim() || undefined, weightG: w === 'invalid' ? null : w } } : {},
      ).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(t);
  }, [description, weightText, mu, draftId]);

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
              // The first photo creates the draft row immediately.
              const { description: desc, weightText: wt, mu: unit } = latest.current;
              const w = parseWeightField(wt, unit);
              saved = await createMeal({
                status: 'draft',
                input: { kind: 'photo', description: desc.trim() || undefined, weightG: w === 'invalid' ? null : w },
                at: atForDay(day, Date.now()),
                photoIds: [mediaId],
              });
              setDraftId(saved.id);
              setDraftParam(saved.id);
            }
            if (!saved.photoIds.includes(mediaId)) {
              await deleteMedia([mediaId]);
              skipped++;
            }
            draftRef.current = saved;
            setKnown(saved);
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
        if (saved && !saved.photoIds.length) {
          // No photos left: an empty draft would just clutter the Diary.
          await deleteMeal(saved.id);
          draftRef.current = null;
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

  const cancel = async () => {
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
    if (cur) {
      try {
        await deleteMeal(cur.id);
      } catch {
        toast("Couldn't discard the meal", 'error');
        return;
      }
    }
    nav(diaryPath(day), { replace: true });
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
        const m = await createMeal({ status: 'pending', input: { kind: 'text', description: desc, weightG: w }, at: atForDay(day, Date.now()) });
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
      const cur = draftRef.current;
      const item = itemFromChoice(c, grams);
      let id: string;
      if (cur && cur.photoIds.length) {
        // The photos already taken stay as this meal's picture.
        const saved = await updateMeal(cur.id, { status: 'done', input: { kind: 'search' }, title: c.name, items: [item], error: null });
        if (!saved) throw new Error('draft vanished');
        id = saved.id;
      } else {
        if (cur) await deleteMeal(cur.id);
        const m = await createMeal({ status: 'done', input: { kind: 'search' }, title: c.name, items: [item], at: atForDay(day, Date.now()) });
        id = m.id;
      }
      nav(mealPath(id), { replace: true });
    } catch {
      toast("Couldn't save the food", 'error');
      setSubmitting(false);
    }
  };

  const scanInstead = async () => {
    await queue.current;
    nav(scanPath({ d: day }), { replace: true });
  };

  if (draft && draft.status !== 'draft') return <Navigate to={mealPath(draft.id)} replace />;

  const resuming = !!resumeId.current && draftId === resumeId.current && live === undefined && !known;
  const photoIds = draft?.photoIds ?? [];
  const canAnalyze = (photoIds.length > 0 || description.trim().length > 0) && !saving && !submitting;
  const today = dayKey(Date.now());

  return (
    <Page>
      <TopBar title="Log food" left={<HeaderButton onClick={() => void cancel()}>Cancel</HeaderButton>} />
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
                dirty.current = true;
                setDescription(v);
              }}
              weightText={weightText}
              onWeightText={(v) => {
                dirty.current = true;
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
