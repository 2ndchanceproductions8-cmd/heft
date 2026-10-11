import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { format } from 'date-fns';
import { Heart, ImagePlus, Trash2, X } from 'lucide-react';
import type { Measurement, Unit } from '../../../types';
import { db } from '../../../db';
import { Button, Field, Sheet, Spinner, TextArea, TextField, confirm, cx, toast } from '../../../components/ui';
import { deleteMedia, saveImageFile, useMediaUrl } from '../../../lib/media';
import { newestWeighIn, updateSettings } from '../../../lib/settings';
import { deleteMeasurement, editedMeasurement, healthSampleAt } from '../../../lib/measurements';
import { uid } from '../../../lib/ids';
import { kgToUnit, parseDecimal, round, unitToKg } from '../../../lib/units';
import { cmToLength, lengthToCm, lengthUnitFor } from '../format';

export const MAX_PHOTOS = 3;

type LengthKey = 'waistCm' | 'chestCm' | 'armCm' | 'thighCm' | 'hipsCm' | 'neckCm';
export const LENGTH_FIELDS: { key: LengthKey; label: string }[] = [
  { key: 'waistCm', label: 'Waist' },
  { key: 'chestCm', label: 'Chest' },
  { key: 'armCm', label: 'Arms' },
  { key: 'thighCm', label: 'Thighs' },
  { key: 'hipsCm', label: 'Hips' },
  { key: 'neckCm', label: 'Neck' },
];

type FormKey = 'weight' | 'bodyFat' | LengthKey;
type FormValues = Record<FormKey, string>;

const fmtInput = (n: number | null | undefined, dp = 1) => (n == null ? '' : String(round(n, dp)));

export function initialValues(m: Measurement | null, unit: Unit): FormValues {
  const lu = lengthUnitFor(unit);
  const v: FormValues = {
    weight: m?.bodyweightKg ? fmtInput(kgToUnit(m.bodyweightKg, unit), 1) : '',
    bodyFat: fmtInput(m?.bodyFatPct),
    waistCm: '',
    chestCm: '',
    armCm: '',
    thighCm: '',
    hipsCm: '',
    neckCm: '',
  };
  for (const f of LENGTH_FIELDS) {
    const cm = m?.[f.key];
    v[f.key] = cm ? fmtInput(cmToLength(cm, lu), 1) : '';
  }
  return v;
}

/** The sheet's form when Save is tapped. */
export interface MeasurementForm {
  initial: FormValues;
  values: FormValues;
  /** The form's values as numbers in its units (null = empty). */
  parsed: Partial<Record<FormKey, number | null>>;
  dateStr: string;
  /** dateStr as a time (resolveDate). */
  date: number;
  notes: string;
  photoIds: string[];
}

/**
 * The row Save writes. `entry` is the row the sheet opened with (null = new), `base` that row as stored at save time:
 * a field the user didn't touch keeps base's value exactly.
 */
export function measurementFromForm(
  entry: Measurement | null,
  base: Measurement | null,
  form: MeasurementForm,
  unit: Unit,
): Measurement {
  const { initial, values, parsed, dateStr, date, notes, photoIds } = form;
  const lu = lengthUnitFor(unit);
  // A field the user didn't touch keeps its stored value exactly (the form shows rounded, converted
  // numbers — re-converting them on every save would make e.g. 80.9 kg drift to 80.92 kg).
  const untouched = (key: FormKey) => !!base && values[key] === initial[key];
  const changes: Pick<Measurement, 'id' | 'date' | 'photoIds'> & Partial<Measurement> = {
    id: entry?.id ?? uid(),
    // An untouched day keeps the stored time (a weight joined on since may have moved it).
    date: base && dateStr === format(entry!.date, 'yyyy-MM-dd') ? base.date : date,
    bodyweightKg: untouched('weight')
      ? base!.bodyweightKg ?? null
      : parsed.weight != null
        ? unitToKg(parsed.weight, unit)
        : null,
    bodyFatPct: untouched('bodyFat') ? base!.bodyFatPct ?? null : parsed.bodyFat ?? null,
    photoIds,
    notes: notes.trim() || undefined,
  };
  for (const f of LENGTH_FIELDS) {
    const v = parsed[f.key];
    changes[f.key] = untouched(f.key) ? base![f.key] ?? null : v != null ? lengthToCm(v, lu) : null;
  }
  // Weight, body fat or the day: what the scale measured. Notes, photos and tape don't make it the user's own (imports
  // only write weight, body fat and the time, and keep the rest of the row).
  const valuesEdited =
    values.weight !== initial.weight ||
    values.bodyFat !== initial.bodyFat ||
    dateStr !== format(entry?.date ?? Date.now(), 'yyyy-MM-dd');
  // Start from the stored row so fields this form doesn't show (source, healthAt, …) survive; an old Apple Health row
  // whose values the user changed becomes theirs.
  return editedMeasurement(base, changes, valuesEdited);
}

/** Same calendar day keeps the original time; another day keeps the time-of-day of `base`. */
function resolveDate(dateStr: string, base: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const b = new Date(base);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), b.getHours(), b.getMinutes(), b.getSeconds());
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

interface Props {
  open: boolean;
  /** null = new entry. */
  entry: Measurement | null;
  unit: Unit;
  onClose: () => void;
}

/** Create / edit one body measurement entry. Mount with a `key` per entry so state resets. */
export function MeasurementSheet({ open, entry, unit, onClose }: Props) {
  const lu = lengthUnitFor(unit);
  const [initial] = useState(() => initialValues(entry, unit));
  const [values, setValues] = useState<FormValues>(initial);
  const [dateStr, setDateStr] = useState(() => format(entry?.date ?? Date.now(), 'yyyy-MM-dd'));
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [photoIds, setPhotoIds] = useState<string[]>(entry?.photoIds ?? []);
  const added = useRef<string[]>([]); // photos uploaded in this session (deleted again on cancel)
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  // Bumped to remount the Sheet when a close is cancelled (resets a drag-to-dismiss offset).
  const [sheetKey, setSheetKey] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const confirming = useRef(false); // a "Discard changes?" dialog is already showing
  const today = format(Date.now(), 'yyyy-MM-dd');

  // ---------------------------------------------------------------- validation
  const errors: Partial<Record<FormKey | 'date', string>> = {};
  const parsed: Partial<Record<FormKey, number | null>> = {};
  const check = (key: FormKey, min: number, max: number, suffix: string) => {
    const raw = values[key].trim();
    if (!raw) {
      parsed[key] = null;
      return;
    }
    const n = parseDecimal(raw);
    if (n == null || n < min || n > max) errors[key] = `Must be ${min}–${max}${suffix === '%' ? '' : ' '}${suffix}`;
    else parsed[key] = n;
  };
  const weightMax = unit === 'lb' ? 900 : 400;
  check('weight', unit === 'lb' ? 40 : 20, weightMax, unit);
  check('bodyFat', 1, 75, '%');
  for (const f of LENGTH_FIELDS) check(f.key, lu === 'in' ? 2 : 5, lu === 'in' ? 120 : 300, lu);
  const date = resolveDate(dateStr, entry && format(entry.date, 'yyyy-MM-dd') === dateStr ? entry.date : Date.now());
  if (date == null) errors.date = 'Pick a date';
  else if (dateStr > today) errors.date = "Date can't be in the future";

  const hasData =
    Object.values(parsed).some((v) => v != null) || photoIds.length > 0 || notes.trim().length > 0;
  const valid = Object.keys(errors).length === 0 && hasData;

  const dirty =
    (Object.keys(values) as FormKey[]).some((k) => values[k] !== initial[k]) ||
    notes !== (entry?.notes ?? '') ||
    photoIds.join() !== (entry?.photoIds ?? []).join() ||
    dateStr !== format(entry?.date ?? Date.now(), 'yyyy-MM-dd');

  // ---------------------------------------------------------------- actions
  const cleanupAdded = () => {
    const orphans = added.current;
    added.current = [];
    if (orphans.length) void deleteMedia(orphans);
  };

  /** `fromSheet`: the close came from a drag/backdrop/Escape on the Sheet (which may be left shifted down). */
  const requestClose = async (fromSheet: boolean) => {
    if (saving || confirming.current) return;
    if (dirty) {
      confirming.current = true;
      const discard = await confirm({ title: 'Discard changes?', message: 'Your edits to this entry will be lost.', confirmLabel: 'Discard', danger: true });
      confirming.current = false;
      if (!discard) {
        // Remount the Sheet to reset a drag-to-dismiss offset (not needed for the Cancel button).
        if (fromSheet) setSheetKey((k) => k + 1);
        return;
      }
    }
    cleanupAdded();
    onClose();
  };

  // If the sheet unmounts without saving (e.g. navigation), don't leave orphaned photos behind.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanupAdded();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_PHOTOS - photoIds.length;
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) toast(`Up to ${MAX_PHOTOS} photos per entry`, 'info');
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const id = await saveImageFile(file);
        if (!mounted.current) {
          // The sheet was closed while this photo was still being processed.
          void deleteMedia([id]);
          continue;
        }
        added.current.push(id);
        setPhotoIds((ids) => [...ids, id]);
      } catch {
        toast("Couldn't read that photo", 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const removePhoto = (id: string) => setPhotoIds((ids) => ids.filter((x) => x !== id));

  const save = async () => {
    if (!valid || date == null || saving) return;
    setSaving(true);
    try {
      // The row as stored now, not the snapshot the sheet opened with.
      const base = entry ? ((await db.measurements.get(entry.id)) ?? entry) : null;
      const rec = measurementFromForm(entry, base, { initial, values, parsed, dateStr, date, notes, photoIds }, unit);
      const newestBefore = await newestWeighIn();
      await db.measurements.put(rec);
      // Photos removed from an existing entry are deleted only once the change is saved.
      const removed = (entry?.photoIds ?? []).filter((id) => !photoIds.includes(id));
      const unusedNew = added.current.filter((id) => !photoIds.includes(id));
      added.current = [];
      await deleteMedia([...removed, ...unusedNew]);
      // The newest weigh-in is the body weight used for calories — mirror it into the profile when this
      // entry is (or was, before its weight/date changed) the newest one.
      const newestAfter = await newestWeighIn();
      if (newestAfter?.bodyweightKg && (newestAfter.id === rec.id || newestBefore?.id === rec.id)) {
        await updateSettings({ bodyweightKg: newestAfter.bodyweightKg });
      }
      toast(entry ? 'Measurement updated' : 'Measurement saved', 'success');
      onClose();
    } catch (e) {
      console.error(e);
      toast("Couldn't save the measurement", 'error');
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!entry) return;
    // From Apple Health (imported before the sync was removed): there can be several a day, so name the time too.
    const fromHealth = healthSampleAt(entry) != null;
    const when = format(entry.date, fromHealth ? "MMM d, yyyy 'at' h:mm a" : 'MMM d, yyyy');
    const ok = await confirm({
      title: 'Delete measurement?',
      message: `The entry from ${when}${entry.photoIds.length ? ' and its photos' : ''} will be deleted.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      const wasNewest = (await newestWeighIn())?.id === entry.id;
      // THE delete: the row and its stored photos.
      await deleteMeasurement(entry);
      // Photos uploaded in this session and not saved yet aren't in the stored row.
      const unsaved = added.current.filter((id) => !entry.photoIds.includes(id));
      added.current = [];
      await deleteMedia(unsaved);
      if (wasNewest) {
        const next = await newestWeighIn();
        if (next?.bodyweightKg) await updateSettings({ bodyweightKg: next.bodyweightKg });
      }
      toast('Measurement deleted', 'success');
      onClose();
    } catch (e) {
      console.error(e);
      toast("Couldn't delete the measurement", 'error');
    }
  };

  const set = (key: FormKey) => (e: ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value.replace(/[^\d.,]/g, '') }));

  return (
    <>
      <Sheet
        key={sheetKey}
        open={open}
        onClose={() => void requestClose(true)}
        size="full"
        title={entry ? 'Edit Measurement' : 'New Measurement'}
        left={
          <button type="button" onClick={() => void requestClose(false)} className="h-10 px-1 text-[17px] text-accent active:opacity-60">
            Cancel
          </button>
        }
        right={
          <button
            type="button"
            disabled={!valid || saving || uploading > 0}
            onClick={() => void save()}
            className="h-10 px-1 text-[17px] font-semibold text-accent active:opacity-60 disabled:text-faint"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        }
      >
        <div className="space-y-5 px-4 pt-1 pb-8">
          {entry?.source === 'health' ? (
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] leading-snug text-muted">
              <Heart className="mt-0.5 h-4 w-4 shrink-0 text-danger" fill="currentColor" />
              <span>
                Imported from Apple Health. If you change its weight, body fat or date, it becomes your own entry. If the
                scale got it wrong, delete it.
              </span>
            </p>
          ) : null}
          <Field label="Date">
            <TextField
              type="date"
              value={dateStr}
              max={today}
              onChange={(e) => setDateStr(e.target.value)}
              className="appearance-none text-left [&::-webkit-date-and-time-value]:text-left"
            />
            {errors.date ? <FieldError>{errors.date}</FieldError> : null}
          </Field>

          <section>
            <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">Body</h3>
            <div className="grid grid-cols-2 gap-3">
              <NumberInput label="Weight" suffix={unit} value={values.weight} onChange={set('weight')} error={errors.weight} />
              <NumberInput label="Body fat" suffix="%" value={values.bodyFat} onChange={set('bodyFat')} error={errors.bodyFat} />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">
              Measurements ({lu === 'in' ? 'inches' : 'cm'})
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {LENGTH_FIELDS.map((f) => (
                <NumberInput key={f.key} label={f.label} suffix={lu} value={values[f.key]} onChange={set(f.key)} error={errors[f.key]} />
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">
              Progress photos <span className="font-normal normal-case">· up to {MAX_PHOTOS}</span>
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {photoIds.map((id) => (
                <PhotoTile key={id} id={id} onRemove={() => removePhoto(id)} onOpen={setViewing} />
              ))}
              {Array.from({ length: uploading }, (_, i) => (
                <div key={'u' + i} className="flex aspect-[3/4] items-center justify-center rounded-xl bg-surface-2">
                  <Spinner />
                </div>
              ))}
              {photoIds.length + uploading < MAX_PHOTOS ? (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex aspect-[3/4] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line bg-surface-2 text-[13px] font-medium text-accent active:bg-surface-3"
                >
                  <ImagePlus className="h-6 w-6" />
                  Add photo
                </button>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void addPhotos(e.target.files);
                e.target.value = '';
              }}
            />
          </section>

          <Field label="Notes">
            <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Morning, fasted…" rows={3} />
          </Field>

          {!hasData ? (
            <p className="text-center text-[13px] text-muted">Enter at least one value or add a photo to save.</p>
          ) : null}

          {entry ? (
            <Button variant="danger" block icon={<Trash2 className="h-4 w-4" />} onClick={() => void remove()}>
              Delete Measurement
            </Button>
          ) : null}
        </div>
      </Sheet>
      <PhotoViewer id={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return <span className="mt-1 block text-[12px] text-danger">{children}</span>;
}

function NumberInput({
  label,
  suffix,
  value,
  onChange,
  error,
}: {
  label: string;
  suffix: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  error?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>
      <span className="relative block">
        <TextField
          type="text"
          inputMode="decimal"
          enterKeyHint="next"
          placeholder="–"
          value={value}
          onChange={onChange}
          className={cx('pr-10 tabular-nums', error && 'border-danger!')}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[14px] text-faint">{suffix}</span>
      </span>
      {error ? <FieldError>{error}</FieldError> : null}
    </label>
  );
}

function PhotoTile({ id, onRemove, onOpen }: { id: string; onRemove: () => void; onOpen: (id: string) => void }) {
  const url = useMediaUrl(id);
  return (
    <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-surface-2">
      {url ? (
        <button type="button" onClick={() => onOpen(id)} className="block h-full w-full" aria-label="View photo">
          <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
        </button>
      ) : (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      )}
      {/* 40px hit area in the corner; the visible 28px badge sits where it always did (6px in). */}
      <button
        type="button"
        aria-label="Remove photo"
        onClick={onRemove}
        className="group absolute top-0 right-0 flex h-10 w-10 items-start justify-end p-1.5"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur group-active:bg-black/80">
          <X className="h-4 w-4" />
        </span>
      </button>
    </div>
  );
}

/** Full-screen view of a stored photo. */
export function PhotoViewer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const url = useMediaUrl(id);
  return (
    <Sheet open={!!id} onClose={onClose} size="full" title="Photo" right={
      <button type="button" onClick={onClose} className="h-10 px-1 text-[17px] font-semibold text-accent">
        Done
      </button>
    }>
      <div className="flex h-full items-center justify-center bg-bg p-2">
        {url ? <img src={url} alt="Progress photo" className="max-h-full max-w-full rounded-lg object-contain" /> : <Spinner />}
      </div>
    </Sheet>
  );
}

/** The weigh-in used for calories: one rule, kept in lib/settings (re-exported for older imports). */
export { newestWeighIn } from '../../../lib/settings';
