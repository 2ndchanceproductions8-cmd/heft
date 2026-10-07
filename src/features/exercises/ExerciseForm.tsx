import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Camera, ChevronRight, ImagePlus, X } from 'lucide-react';
import { db } from '../../db';
import type { CustomExercise, Equipment, Exercise, ExerciseType, Muscle } from '../../types';
import { EXERCISE_TYPES } from '../../types';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { Sheet, Spinner, TextArea, TextField, Toggle, confirm, cx, toast } from '../../components/ui';
import { useExercises } from '../../lib/ExerciseProvider';
import {
  EQUIPMENT_FILTERS,
  EQUIPMENT_LABEL,
  EXERCISE_TYPE_EXAMPLE,
  EXERCISE_TYPE_LABEL,
  MUSCLE_FILTERS,
  MUSCLE_LABEL,
} from '../../lib/exerciseMeta';
import { createCustomExercise, setExercisePerSide, updateCustomExercise, variantName } from '../../lib/exercises';
import { defaultPerSide } from '../../lib/sides';
import { deleteMedia, saveImageFile, useMediaUrls } from '../../lib/media';
import { refreshHistoryAfterTypeChange } from './mutations';
import { VARIANT_EXPLAINER } from './ExerciseActions';
import { MUSCLE_OPTIONS, OptionSheet } from './FilterSheets';
import { HeaderButton, SectionLabel } from './parts';

export const MAX_PHOTOS = 3;

export interface ExerciseFormValues {
  name: string;
  equipment: Equipment | null;
  primary: Muscle | null;
  secondary: Muscle[];
  type: ExerciseType;
  /** Machine brand / gym label (variants). */
  brand: string;
  /** One step per line. */
  instructions: string;
  photoIds: string[];
  /** Log left and right separately (iso-lateral / single-arm / single-leg). Saved as ExerciseOverride.perSide. */
  perSide: boolean;
}

type FieldKey = 'name' | 'equipment' | 'primary';

export interface ExerciseFormOptions {
  /** Edit an existing custom exercise. */
  editId?: string | null;
  /** Create a gym/brand variant of this exercise. */
  variantOfId?: string | null;
  /** Prefill the name (e.g. from the picker's search text). */
  initialName?: string;
}

/**
 * State + save logic for creating / editing custom exercises and gym/brand variants. Shared by the
 * full-page form (/exercises/new, /exercises/:id/edit) and the picker's nested "Create" sheet.
 */
export function useExerciseForm({ editId, variantOfId, initialName }: ExerciseFormOptions) {
  const index = useExercises();
  const mode: 'create' | 'edit' | 'variant' = editId ? 'edit' : variantOfId ? 'variant' : 'create';

  // Variant of an exercise that is already resolvable (always true for catalog bases): prefill right away
  // instead of flashing a spinner while an effect does it.
  const initialBase = mode === 'variant' && variantOfId ? index.byId.get(variantOfId) : undefined;
  const [values, setValues] = useState<ExerciseFormValues>(() => ({
    name: initialName?.trim() ?? '',
    equipment: initialBase?.equipment ?? null,
    primary: initialBase?.primary ?? null,
    secondary: initialBase ? [...initialBase.secondary] : [],
    type: initialBase?.type ?? 'weight_reps',
    brand: '',
    instructions: '',
    photoIds: [],
    perSide: initialBase ? initialBase.perSide : defaultPerSide(initialName ?? ''),
  }));
  const variantInit = useRef(!!initialBase);
  // Until the user flips the switch, a new exercise's per-side follows its name ("Iso-Lateral Row" turns it on).
  const [perSideTouched, setPerSideTouched] = useState(mode !== 'create');
  const [record, setRecord] = useState<CustomExercise | null>(null);
  const [editMissing, setEditMissing] = useState(false);
  const [nameEdited, setNameEdited] = useState(mode !== 'variant');
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  // Snapshot of the values the form started from (after loading / prefilling) — `dirty` compares against it.
  const baseline = useRef<string | null>(null);
  if (baseline.current === null) baseline.current = JSON.stringify(values);

  // Media created during this session (deleted if the form is abandoned) and pre-existing media the user
  // removed (deleted only once the edit is saved).
  const added = useRef<string[]>([]);
  const removed = useRef<string[]>([]);
  const saved = useRef(false);
  /** Edit mode: the per-side value the form loaded (the override is written only when the user changes it). */
  const loadedPerSide = useRef<boolean | null>(null);

  // ---- load the record being edited (once)
  useEffect(() => {
    if (!editId) return;
    let alive = true;
    Promise.all([db.customExercises.get(editId), db.overrides.get(editId)])
      .then(([rec, override]) => {
        if (!alive) return;
        if (!rec) {
          setEditMissing(true);
          return;
        }
        // Its own setting from the database (the exercise list may still be loading); else a variant's base decides.
        const perSide = override?.perSide ?? (rec.variantOf ? index.byId.get(rec.variantOf)?.perSide ?? false : false);
        loadedPerSide.current = perSide;
        const loaded: ExerciseFormValues = {
          name: rec.name,
          equipment: rec.equipment,
          primary: rec.primary,
          secondary: rec.secondary ?? [],
          type: rec.type,
          brand: rec.brand ?? '',
          instructions: (rec.instructions ?? []).join('\n'),
          photoIds: rec.photoIds ?? [],
          perSide,
        };
        baseline.current = JSON.stringify(loaded);
        setRecord(rec);
        setValues(loaded);
      })
      .catch(() => alive && setEditMissing(true));
    return () => {
      alive = false;
    };
  }, [editId]);

  // ---- the base exercise of a variant (new variant, or editing one)
  const baseId = mode === 'variant' ? variantOfId : record?.variantOf;
  const base: Exercise | undefined = baseId ? index.byId.get(baseId) : undefined;
  // A custom base may not be in the provider yet — check the DB to tell "loading" from "gone".
  const baseRecord = useLiveQuery(
    async () => (mode === 'variant' && variantOfId?.startsWith('c_') ? (await db.customExercises.get(variantOfId)) ?? null : null),
    [mode, variantOfId],
  );

  useEffect(() => {
    if (mode !== 'variant' || variantInit.current || !base) return;
    variantInit.current = true;
    setValues((v) => {
      const next = {
        ...v,
        equipment: base.equipment,
        primary: base.primary,
        secondary: [...base.secondary],
        type: base.type,
        perSide: base.perSide,
      };
      baseline.current = JSON.stringify(next); // idempotent, so safe if React replays the updater
      return next;
    });
  }, [mode, base]);

  // Abandoned form → drop photos that were only stored for it.
  useEffect(
    () => () => {
      if (!saved.current && added.current.length) void deleteMedia(added.current);
    },
    [],
  );

  let status: 'loading' | 'ready' | 'notfound' = 'ready';
  if (mode === 'edit') status = editMissing ? 'notfound' : record ? 'ready' : 'loading';
  else if (mode === 'variant') {
    if (base && !base.missing) status = values.equipment ? 'ready' : 'loading';
    else if (!variantOfId?.startsWith('c_') || baseRecord === null) status = 'notfound';
    else status = 'loading';
  }

  const isVariant = mode === 'variant' || !!record?.variantOf;
  /** True once the user changed anything (used to confirm before discarding). */
  const dirty = status === 'ready' && JSON.stringify(values) !== baseline.current;

  const duplicate = useMemo(() => {
    const n = values.name.trim().toLowerCase();
    if (!n) return null;
    return index.list.find((e) => e.id !== editId && e.name.trim().toLowerCase() === n) ?? null;
  }, [values.name, index.list, editId]);

  const set = <K extends keyof ExerciseFormValues>(key: K, value: ExerciseFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const setName = (name: string) => {
    setNameEdited(true);
    setValues((v) => ({ ...v, name, perSide: perSideTouched ? v.perSide : defaultPerSide(name) }));
    if ('name' in errors) setErrors((e) => ({ ...e, name: undefined }));
  };

  const setPerSide = (perSide: boolean) => {
    setPerSideTouched(true);
    set('perSide', perSide);
  };

  const setBrand = (brand: string) => {
    setValues((v) => ({
      ...v,
      brand,
      name: nameEdited || !base ? v.name : brand.trim() ? variantName(base.name, brand) : '',
    }));
    setErrors((e) => ({ ...e, name: undefined }));
  };

  const setPrimary = (m: Muscle | null) => {
    setValues((v) => ({ ...v, primary: m, secondary: v.secondary.filter((s) => s !== m) }));
    setErrors((e) => ({ ...e, primary: undefined }));
  };

  const toggleSecondary = (m: Muscle) =>
    setValues((v) => ({
      ...v,
      secondary: v.secondary.includes(m) ? v.secondary.filter((s) => s !== m) : [...v.secondary, m],
    }));

  const addPhoto = async (file: File) => {
    if (values.photoIds.length >= MAX_PHOTOS) {
      toast(`Up to ${MAX_PHOTOS} photos`, 'info');
      return;
    }
    setPhotoBusy(true);
    try {
      const id = await saveImageFile(file);
      added.current.push(id);
      setValues((v) => ({ ...v, photoIds: [...v.photoIds, id].slice(0, MAX_PHOTOS) }));
    } catch {
      toast('Could not add the photo', 'error');
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = (id: string) => {
    setValues((v) => ({ ...v, photoIds: v.photoIds.filter((p) => p !== id) }));
    if (added.current.includes(id)) {
      added.current = added.current.filter((p) => p !== id);
      void deleteMedia([id]);
    } else {
      removed.current.push(id);
    }
  };

  /** Validates and saves. Returns the exercise id, or null when invalid / cancelled / failed. */
  const save = async (): Promise<string | null> => {
    if (savingRef.current) return null;
    const name = values.name.trim();
    const errs: Partial<Record<FieldKey, string>> = {};
    if (!name) errs.name = isVariant ? 'Enter the machine brand or a name' : 'Enter a name';
    if (!values.equipment) errs.equipment = 'Pick the equipment';
    if (!values.primary) errs.primary = 'Pick the primary muscle';
    setErrors(errs);
    const first = Object.values(errs)[0];
    if (first) {
      toast(first, 'error');
      return null;
    }
    const instructions = values.instructions
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const secondary = values.secondary.filter((m) => m !== values.primary);
    savingRef.current = true;
    setSaving(true);
    try {
      if (mode === 'edit') {
        if (!record) return null;
        const typeChanged = record.type !== values.type;
        if (typeChanged) {
          const used = await db.workouts.where('exerciseIds').equals(record.id).count();
          if (
            used &&
            !(await confirm({
              title: 'Change exercise type?',
              message: `You have logged this exercise in ${used} workout${used === 1 ? '' : 's'}. Values that don't fit the new type (e.g. weight or distance) will be hidden and records recalculated.`,
              confirmLabel: 'Change Type',
            }))
          ) {
            return null;
          }
        }
        await updateCustomExercise(record.id, {
          name,
          equipment: values.equipment!,
          primary: values.primary!,
          secondary,
          type: values.type,
          instructions,
          photoIds: values.photoIds,
          brand: isVariant ? values.brand.trim() || undefined : record.brand,
        });
        if (values.perSide !== loadedPerSide.current) await setExercisePerSide(record.id, values.perSide);
        saved.current = true;
        if (removed.current.length) await deleteMedia(removed.current);
        removed.current = [];
        if (typeChanged) await refreshHistoryAfterTypeChange(record.id);
        return record.id;
      }
      const id = await createCustomExercise({
        name,
        equipment: values.equipment!,
        primary: values.primary!,
        secondary,
        type: values.type,
        photoIds: values.photoIds,
        instructions: instructions.length ? instructions : undefined,
        variantOf: mode === 'variant' ? base?.id ?? null : null,
        brand: mode === 'variant' ? values.brand.trim() || undefined : undefined,
      });
      // A new custom exercise logs both sides together unless switched on here; a variant follows its base.
      const inherited = mode === 'variant' ? base?.perSide ?? false : false;
      if (values.perSide !== inherited) await setExercisePerSide(id, values.perSide);
      saved.current = true;
      return id;
    } catch {
      toast('Could not save the exercise', 'error');
      return null;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return {
    mode,
    status,
    dirty,
    values,
    errors,
    saving,
    photoBusy,
    isVariant,
    base,
    duplicate,
    set,
    setName,
    setPerSide,
    setBrand,
    setPrimary,
    toggleSecondary,
    addPhoto,
    removePhoto,
    save,
  };
}

export type ExerciseFormState = ReturnType<typeof useExerciseForm>;

// ---------------------------------------------------------------------------------------------- fields

function PhotoTile({ id, url, onRemove }: { id: string; url: string | undefined; onRemove: (id: string) => void }) {
  return (
    <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl bg-surface-3">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} /> : null}
      {/* 40px hit area in the corner; the visible 28px badge sits where it always did (4px in). */}
      <button
        type="button"
        aria-label="Remove photo"
        onClick={() => onRemove(id)}
        className="group absolute top-0 right-0 flex h-10 w-10 items-start justify-end p-1"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-backdrop text-white group-active:opacity-70">
          <X className="h-4 w-4" strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}

function AddPhotoTile({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line bg-surface-2 text-[13px] font-semibold text-accent transition-colors active:bg-surface-3 disabled:opacity-40"
    >
      {icon}
      {label}
    </button>
  );
}

function PhotoField({ form }: { form: ExerciseFormState }) {
  const { values, base, photoBusy } = form;
  const urls = useMediaUrls(values.photoIds);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    void (async () => {
      for (const f of files.slice(0, MAX_PHOTOS - values.photoIds.length)) await form.addPhoto(f);
    })();
  };
  const full = values.photoIds.length >= MAX_PHOTOS;
  return (
    <div>
      <SectionLabel right={<span className="text-[12px] text-faint tabular-nums">{values.photoIds.length}/{MAX_PHOTOS}</span>}>
        Photo
      </SectionLabel>
      <div className="no-scrollbar -mx-4 flex gap-2.5 overflow-x-auto px-4">
        {values.photoIds.map((id, i) => (
          <PhotoTile key={id} id={id} url={urls[i]} onRemove={form.removePhoto} />
        ))}
        {photoBusy ? (
          <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-2xl bg-surface-2">
            <Spinner />
          </div>
        ) : null}
        {!full ? (
          <>
            <AddPhotoTile icon={<Camera className="h-6 w-6" />} label="Take Photo" onClick={() => cameraRef.current?.click()} disabled={photoBusy} />
            <AddPhotoTile icon={<ImagePlus className="h-6 w-6" />} label="Choose" onClick={() => libraryRef.current?.click()} disabled={photoBusy} />
          </>
        ) : null}
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      <input ref={libraryRef} type="file" accept="image/*" multiple hidden onChange={onFile} />
      {!values.photoIds.length && base ? (
        <div className="mt-2.5 flex items-center gap-2.5 text-[13px] leading-snug text-muted">
          <ExerciseThumb exercise={base} size={32} />
          <span>Uses the pictures from {base.name} until you add your own.</span>
        </div>
      ) : (
        <p className="mt-2 text-[12px] leading-snug text-faint">Snap the actual machine at your gym so you can spot it fast.</p>
      )}
    </div>
  );
}

function ChoiceButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'flex min-h-10 items-center justify-center rounded-xl px-2 py-1.5 text-center text-[14px] leading-tight font-medium transition-colors',
        active ? 'bg-accent text-on-accent' : 'bg-surface-2 text-fg active:bg-surface-3',
      )}
    >
      {children}
    </button>
  );
}

function FieldError({ children }: { children?: string }) {
  if (!children) return null;
  return <p className="mt-1.5 text-[13px] text-danger">{children}</p>;
}

/** All inputs of the exercise form. `inSheet` adapts surfaces for use inside a bottom sheet. */
export function ExerciseFormFields({ form, inSheet }: { form: ExerciseFormState; inSheet?: boolean }) {
  const { values, errors, duplicate, isVariant, base } = form;
  const [muscleSheet, setMuscleSheet] = useState(false);
  const listBg = inSheet ? 'bg-surface-2' : 'bg-surface';

  return (
    <div className="space-y-7 px-4 pt-4 pb-8">
      <PhotoField form={form} />

      <div>
        <SectionLabel>Exercise Name</SectionLabel>
        <TextField
          value={values.name}
          onChange={(e) => form.setName(e.target.value)}
          placeholder={isVariant && base ? variantName(base.name, 'Brand') : 'e.g. Lat Pulldown (Hammer Strength)'}
          autoCapitalize="words"
          enterKeyHint="done"
          maxLength={80}
          aria-invalid={!!errors.name}
          className={cx(errors.name && 'border-danger!')}
        />
        <FieldError>{errors.name}</FieldError>
        {duplicate && !errors.name ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-[13px] leading-snug text-warn">
            <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
            <span>
              “{duplicate.name}” already exists ({EQUIPMENT_LABEL[duplicate.equipment]}). You can still save — a different
              name makes them easier to tell apart.
            </span>
          </p>
        ) : null}
      </div>

      {isVariant ? (
        <div>
          <SectionLabel>Machine Brand / Gym Label</SectionLabel>
          <TextField
            value={values.brand}
            onChange={(e) => form.setBrand(e.target.value)}
            placeholder="e.g. Hammer Strength"
            autoCapitalize="words"
            enterKeyHint="done"
            maxLength={40}
          />
          <p className="mt-1.5 text-[13px] leading-snug text-muted">
            {VARIANT_EXPLAINER}
            {base ? <span className="text-faint"> Variant of {base.name}.</span> : null}
          </p>
        </div>
      ) : null}

      <div>
        <SectionLabel>Equipment</SectionLabel>
        <div className="grid grid-cols-3 gap-2">
          {EQUIPMENT_FILTERS.map((e) => (
            <ChoiceButton key={e} active={values.equipment === e} onClick={() => form.set('equipment', e)}>
              {EQUIPMENT_LABEL[e]}
            </ChoiceButton>
          ))}
        </div>
        <FieldError>{errors.equipment}</FieldError>
      </div>

      <div>
        <SectionLabel>Primary Muscle</SectionLabel>
        <button
          type="button"
          onClick={() => setMuscleSheet(true)}
          className={cx(
            'flex h-11 w-full items-center rounded-xl border px-3.5 text-left transition-colors active:bg-surface-3',
            'bg-surface-2',
            errors.primary ? 'border-danger' : 'border-line',
          )}
        >
          <span className={cx('flex-1 text-[16px]', values.primary ? 'text-fg' : 'text-faint')}>
            {values.primary ? MUSCLE_LABEL[values.primary] : 'Select primary muscle'}
          </span>
          <ChevronRight className="h-5 w-5 text-faint" />
        </button>
        <FieldError>{errors.primary}</FieldError>
        <OptionSheet
          open={muscleSheet}
          onClose={() => setMuscleSheet(false)}
          title="Primary Muscle"
          options={MUSCLE_OPTIONS}
          value={values.primary}
          onSelect={form.setPrimary}
        />
      </div>

      <div>
        <SectionLabel right={values.secondary.length ? <span className="text-[12px] text-faint">{values.secondary.length} selected</span> : null}>
          Other Muscles
        </SectionLabel>
        <div className="flex flex-wrap gap-2">
          {MUSCLE_FILTERS.filter((m) => m !== values.primary).map((m) => {
            const on = values.secondary.includes(m);
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                onClick={() => form.toggleSecondary(m)}
                className={cx(
                  'h-9 rounded-full px-3.5 text-[14px] font-medium transition-colors',
                  on ? 'bg-accent-soft text-accent ring-1 ring-accent/50' : 'bg-surface-2 text-fg active:bg-surface-3',
                )}
              >
                {MUSCLE_LABEL[m]}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <SectionLabel>Exercise Type</SectionLabel>
        <div className={cx('divide-y divide-line overflow-hidden rounded-2xl', listBg)} role="radiogroup" aria-label="Exercise type">
          {EXERCISE_TYPES.map((t) => {
            const on = values.type === t;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => form.set('type', t)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-surface-3"
              >
                <span className="min-w-0 flex-1">
                  <span className={cx('block text-[16px] font-medium', on && 'text-accent')}>{EXERCISE_TYPE_LABEL[t]}</span>
                  <span className="block truncate text-[13px] text-muted">{EXERCISE_TYPE_EXAMPLE[t]}</span>
                </span>
                <span
                  className={cx(
                    'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2',
                    on ? 'border-accent' : 'border-faint',
                  )}
                >
                  {on ? <span className="h-3 w-3 rounded-full bg-accent" /> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <SectionLabel>Sides</SectionLabel>
        <div className={cx('flex items-center gap-3 rounded-2xl px-4 py-3', listBg)}>
          <span className="min-w-0 flex-1">
            <span className="block text-[16px] font-medium">Log left &amp; right separately</span>
            <span className="block text-[13px] leading-snug text-muted">
              Iso-lateral machines, single-arm or single-leg work: each side gets its own weight and reps, so you can
              compare them
            </span>
          </span>
          <Toggle checked={values.perSide} onChange={form.setPerSide} label="Log left and right separately" />
        </div>
      </div>

      <div>
        <SectionLabel>
          Instructions <span className="font-normal tracking-normal normal-case text-faint">(optional)</span>
        </SectionLabel>
        <TextArea
          value={values.instructions}
          onChange={(e) => form.set('instructions', e.target.value)}
          rows={5}
          placeholder={'One step per line, e.g.\nSet the thigh pad snug.\nPull the bar to your upper chest.'}
        />
        {isVariant && base?.instructions.length ? (
          <p className="mt-1.5 text-[12px] text-faint">Leave empty to use the steps from {base.name}.</p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- sheet

/** Nested "Create exercise" sheet used by the picker. Calls `onCreated(id)` after saving. */
export function ExerciseCreateSheet({
  open,
  onClose,
  onCreated,
  initialName,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
  initialName?: string;
}) {
  if (!open) return null;
  return <CreateSheetBody onClose={onClose} onCreated={onCreated} initialName={initialName} />;
}

function CreateSheetBody({
  onClose,
  onCreated,
  initialName,
}: {
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
  initialName?: string;
}) {
  const form = useExerciseForm({ initialName });
  const submit = async () => {
    const id = await form.save();
    if (id) {
      toast('Exercise created', 'success');
      onCreated(id, form.values.name.trim());
    }
  };
  // A stray backdrop tap / swipe-down must not silently throw away what was typed (or photographed).
  const closing = useRef(false);
  // The Sheet keeps its drag offset until it closes; remount it when a swipe-down dismiss is refused.
  const [sheetKey, setSheetKey] = useState(0);
  const requestClose = async (fromSheet: boolean) => {
    if (closing.current || form.saving) return;
    if (form.dirty) {
      closing.current = true;
      const ok = await confirm({
        title: 'Discard this exercise?',
        message: 'It has not been saved.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep Editing',
        danger: true,
      });
      closing.current = false;
      if (!ok) {
        if (fromSheet) setSheetKey((k) => k + 1);
        return;
      }
    }
    onClose();
  };
  return (
    <Sheet
      key={sheetKey}
      open
      onClose={() => void requestClose(true)}
      size="full"
      title="New Exercise"
      left={<HeaderButton onClick={() => void requestClose(false)}>Cancel</HeaderButton>}
      right={
        <HeaderButton bold onClick={() => void submit()} disabled={form.saving || form.photoBusy}>
          {form.saving ? 'Saving…' : 'Save'}
        </HeaderButton>
      }
    >
      <ExerciseFormFields form={form} inSheet />
    </Sheet>
  );
}
