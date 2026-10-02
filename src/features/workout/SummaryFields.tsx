import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Camera, Flame, ImagePlus, Info, Pencil, X } from 'lucide-react';
import { Spinner, cx, prompt, toast } from '../../components/ui';
import { MAX_PHOTOS } from './prompts';
import type { CalorieEstimate } from '../../lib/calories';
import { saveImageFile, useMediaUrl } from '../../lib/media';
import { fromLocalInput, toLocalInput } from './logic';

/* Pieces shared by the "Save Workout" (finish) and "Edit Workout" screens. */

/** Summary tile (Duration / Volume / Sets / Records). Tappable when `onClick` is given. */
export function SummaryStat({
  label,
  value,
  onClick,
  accent,
}: {
  label: string;
  value: ReactNode;
  onClick?: () => void;
  accent?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-center gap-1 text-[12px] font-medium text-muted">
        {label}
        {onClick ? <Pencil className="h-3 w-3" /> : null}
      </div>
      <div className={cx('truncate text-[16px] font-semibold tabular-nums', accent && 'text-accent')}>{value}</div>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="min-w-0 rounded-xl px-2 py-1.5 text-left active:bg-surface-2">
      {body}
    </button>
  ) : (
    <div className="min-w-0 px-2 py-1.5">{body}</div>
  );
}

/** "When" — start date & time of the workout. */
export function StartTimeField({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-muted">When</span>
      <input
        type="datetime-local"
        value={toLocalInput(value)}
        max={toLocalInput(Date.now() + 60_000)}
        onChange={(e) => {
          const ms = fromLocalInput(e.target.value);
          // Not every browser enforces `max` (iOS ignores it): a workout can't start in the future.
          if (ms != null) onChange(Math.min(ms, Date.now()));
        }}
        className="h-11 w-full min-w-0 appearance-none rounded-xl border border-line bg-surface-2 px-3.5 text-fg outline-none focus:border-accent"
      />
    </label>
  );
}

/** Calories: the MET estimate, or a number the user typed (e.g. from a watch). */
export function CaloriesCard({
  estimate,
  manual,
  onManualChange,
}: {
  estimate: CalorieEstimate;
  /** null = using the estimate. */
  manual: number | null;
  onManualChange: (kcal: number | null) => void;
}) {
  const edit = async () => {
    const v = await prompt({
      title: 'Calories burned',
      message: 'Enter the number from your watch or fitness tracker.',
      initial: String(manual ?? estimate.total),
      inputMode: 'numeric',
      confirmLabel: 'Save',
      validate: (s) => {
        const n = Number(s.trim());
        if (!s.trim() || !Number.isFinite(n) || n < 0) return 'Enter a number of calories';
        if (n > 20000) return 'That seems too high';
        return null;
      },
    });
    if (v == null) return;
    onManualChange(Math.round(Number(v.trim())));
  };

  const shown = manual ?? estimate.total;
  return (
    <div className="rounded-2xl bg-surface p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-danger-soft">
          <Flame className="h-5 w-5 text-danger" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-muted">Calories</div>
          <div className="text-[22px] leading-tight font-bold tabular-nums">
            {shown.toLocaleString()} <span className="text-[15px] font-semibold text-muted">kcal</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void edit()}
          className="h-9 rounded-lg bg-surface-2 px-3 text-[14px] font-semibold text-accent active:bg-surface-3"
        >
          Edit
        </button>
      </div>
      {manual != null ? (
        <div className="mt-3 flex items-center justify-between gap-3 text-[13px]">
          <span className="text-muted">Entered manually · estimate {estimate.total.toLocaleString()} kcal</span>
          <button type="button" onClick={() => onManualChange(null)} className="shrink-0 font-semibold text-accent">
            Use estimate
          </button>
        </div>
      ) : (
        <>
          <p className="mt-3 flex items-start gap-1.5 text-[13px] leading-snug text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Estimated from your body weight, workout time and pace (MET method)
          </p>
          {estimate.assumedBodyweight ? (
            <Link
              to="/settings"
              className="mt-2 flex items-start gap-1.5 rounded-xl bg-warn-soft px-3 py-2 text-[13px] leading-snug font-medium"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
              <span>
                Set your body weight in Settings for accuracy <span className="text-accent">→ Settings</span>
              </span>
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Workout photos: pick from the library or take one with the camera (max 6). */
export function PhotoPicker({
  photoIds,
  onAdd,
  onRemove,
  onBusyChange,
  max = MAX_PHOTOS,
}: {
  photoIds: string[];
  onAdd: (ids: string[]) => void;
  onRemove: (id: string) => void;
  /** True while picked photos are still being processed (callers block Save so none are lost). */
  onBusyChange?: (busy: boolean) => void;
  max?: number;
}) {
  const [busy, setBusy] = useState(false);
  const busyCb = useRef(onBusyChange);
  busyCb.current = onBusyChange;
  useEffect(() => {
    busyCb.current?.(busy);
  }, [busy]);
  useEffect(() => () => busyCb.current?.(false), []);
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const room = max - photoIds.length;

  const handleFiles = async (files: FileList | null, input: HTMLInputElement | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/') || !f.type);
    if (input) input.value = '';
    if (!list.length) return;
    if (list.length > room) toast(`Only ${max} photos per workout`, 'info');
    setBusy(true);
    const ids: string[] = [];
    try {
      for (const f of list.slice(0, Math.max(0, room))) ids.push(await saveImageFile(f));
    } catch {
      toast('Could not add photo', 'error');
    } finally {
      setBusy(false);
      if (ids.length) onAdd(ids);
    }
  };

  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {photoIds.map((id) => (
          <PhotoThumb key={id} id={id} onRemove={() => onRemove(id)} />
        ))}
        {busy ? (
          <div className="flex aspect-square items-center justify-center rounded-xl bg-surface-2">
            <Spinner />
          </div>
        ) : null}
        {room > 0 && !busy ? (
          <>
            <button
              type="button"
              onClick={() => libraryRef.current?.click()}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line bg-surface-2 text-[13px] font-medium text-accent active:bg-surface-3"
            >
              <ImagePlus className="h-6 w-6" />
              Add Photo
            </button>
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line bg-surface-2 text-[13px] font-medium text-accent active:bg-surface-3"
            >
              <Camera className="h-6 w-6" />
              Camera
            </button>
          </>
        ) : null}
      </div>
      <p className="mt-2 text-[12px] text-faint">
        {photoIds.length}/{max} photos
      </p>
      <input
        ref={libraryRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files, e.currentTarget)}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files, e.currentTarget)}
      />
    </div>
  );
}

function PhotoThumb({ id, onRemove }: { id: string; onRemove: () => void }) {
  const url = useMediaUrl(id);
  return (
    <div className="relative aspect-square overflow-hidden rounded-xl bg-surface-2">
      {url ? <img src={url} alt="Workout photo" className="h-full w-full object-cover" /> : null}
      {/* The tile clips overflow, so the button itself is the 40px target; the small circle sits inside it. */}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove photo"
        className="group absolute top-0 right-0 flex h-10 w-10 items-center justify-center"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-backdrop text-white group-active:opacity-70">
          <X className="h-4 w-4" strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}
