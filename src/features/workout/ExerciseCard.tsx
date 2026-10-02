import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpDown,
  Check,
  Link2,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Repeat2,
  Timer,
  Trash2,
  Unlink,
  Wrench,
} from 'lucide-react';
import type { WorkoutExercise } from '../../types';
import { ActionSheet, IconButton, confirm, cx, prompt, toast, type SheetAction } from '../../components/ui';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { useExercises } from '../../lib/ExerciseProvider';
import { typeFields } from '../../lib/exerciseMeta';
import { renameExercise, setExerciseNote, setExerciseRest } from '../../lib/exercises';
import { distanceUnitForType } from '../../lib/units';
import { targetFromValues } from '../../lib/workoutStore';
import { useLogger } from './LoggerContext';
import { SetRow } from './SetRow';
import { RestPickerSheet } from './RestPickerSheet';
import { VariantSheet } from './VariantSheet';
import {
  alignPreviousSets,
  effectiveRestSec,
  hasAnyValue,
  restOptionLabel,
  setBadges,
  setGridStyle,
  valueColumns,
} from './logic';

/** One exercise in the logger: header, notes, rest timer, set table and "+ Add Set". */
export function ExerciseCard({ we }: { we: WorkoutExercise }) {
  const ctx = useLogger();
  const { ops, settings, mode } = ctx;
  const index = useExercises();
  const navigate = useNavigate();
  const ex = index.get(we.exerciseId);
  const fields = typeFields(ex.type);
  const cols = valueColumns(fields, settings.showRpe);
  const prev = ctx.previousByInstance.get(we.id) ?? null;
  // Warm-ups line up with last time's warm-ups and working sets with working sets (not by position).
  const prevAligned = useMemo(() => alignPreviousSets(we.sets, prev), [we.sets, prev]);
  const color = we.supersetId ? ctx.supersetColors.get(we.supersetId) : undefined;
  const restSec = effectiveRestSec(we, ex, settings);
  const badges = setBadges(we.sets);

  const [menuOpen, setMenuOpen] = useState(false);
  const [restOpen, setRestOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);

  const rename = async () => {
    const name = await prompt({
      title: 'Rename Exercise',
      message: 'Renames it everywhere. Your history is kept.',
      initial: ex.name,
      placeholder: ex.originalName,
      confirmLabel: 'Rename',
      validate: (v) => (v.trim() ? null : 'Enter a name'),
    });
    if (name == null || name.trim() === ex.name) return;
    try {
      await renameExercise(ex.id, name);
      toast('Exercise renamed', 'success');
    } catch {
      toast('Could not rename exercise', 'error');
    }
  };

  const pinNote = async () => {
    const note = await prompt({
      title: ex.notes ? 'Edit Pinned Note' : 'Pin Note',
      message: 'Shown every time you do this exercise (e.g. seat height, grip). Leave empty to remove.',
      initial: ex.notes ?? '',
      placeholder: 'Seat on 4, pin at 7...',
      confirmLabel: 'Save',
    });
    if (note == null) return;
    try {
      await setExerciseNote(ex.id, note);
    } catch {
      toast('Could not save note', 'error');
    }
  };

  const removeExercise = async () => {
    const doneSets = we.sets.filter((s) => s.done).length;
    if (doneSets > 0) {
      const ok = await confirm({
        title: 'Remove exercise?',
        message: `${ex.name} has ${doneSets} completed ${doneSets === 1 ? 'set' : 'sets'}. They will be removed from this workout.`,
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) return;
    }
    ops.removeExercise(we.id);
  };

  const addSet = () => {
    const last = we.sets[we.sets.length - 1];
    // The new set's placeholders mirror the last set (what was typed, else its plan).
    const target = last ? (hasAnyValue(last) ? targetFromValues(last) : last.target ?? null) : null;
    ops.addSet(we.id, { target, ...(mode === 'edit' ? { done: true } : {}) });
  };

  const actions: SheetAction[] = [
    {
      label: 'Reorder Exercises',
      icon: <ArrowUpDown className="h-5 w-5" />,
      onClick: ctx.openReorder,
      disabled: ctx.exercises.length < 2,
    },
    { label: 'Replace Exercise', icon: <Repeat2 className="h-5 w-5" />, onClick: () => ctx.openReplace(we.id) },
    {
      label: 'Switch Machine / Brand Variant',
      hint: 'Same exercise on a different machine',
      icon: <Wrench className="h-5 w-5" />,
      onClick: () => setVariantOpen(true),
    },
    { label: 'Rename Exercise', icon: <Pencil className="h-5 w-5" />, onClick: () => void rename() },
    we.supersetId
      ? {
          label: 'Remove From Superset',
          icon: <Unlink className="h-5 w-5" />,
          onClick: () => ops.removeFromSuperset(we.id),
        }
      : {
          label: 'Add To Superset',
          icon: <Link2 className="h-5 w-5" />,
          onClick: () => ctx.openSuperset(we.id),
          disabled: ctx.exercises.length < 2,
        },
    { label: ex.notes ? 'Edit Pinned Note' : 'Pin Note', icon: <Pin className="h-5 w-5" />, onClick: () => void pinNote() },
    { label: 'Remove Exercise', icon: <Trash2 className="h-5 w-5" />, danger: true, onClick: () => void removeExercise() },
  ];

  const unitLabel = settings.unit.toUpperCase();
  const header: Record<string, string> = {
    weight: `${fields.weightSign}${unitLabel}`,
    reps: 'REPS',
    distance: distanceUnitForType(ex.type, settings.distanceUnit).toUpperCase(),
    duration: 'TIME',
    rpe: 'RPE',
  };

  return (
    <section id={`we-${we.id}`} className="relative scroll-mt-36 overflow-hidden rounded-2xl bg-surface">
      {color ? <div className={cx('absolute inset-y-0 left-0 z-10 w-1', color.bar)} aria-hidden /> : null}

      {/* Header */}
      <div className="flex items-center gap-3 py-2.5 pr-1.5 pl-3">
        <button
          type="button"
          onClick={() => navigate(`/exercises/${encodeURIComponent(ex.id)}`)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left active:opacity-70"
        >
          <ExerciseThumb exercise={ex} size={40} />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-[16px] leading-snug font-semibold text-accent">{ex.name}</span>
            {color || ex.brand ? (
              <span className="block truncate text-[12px]">
                {color ? <span className={cx('font-semibold', color.text)}>Superset</span> : null}
                {color && ex.brand ? <span className="text-muted"> · </span> : null}
                {ex.brand ? <span className="text-muted">{ex.brand}</span> : null}
              </span>
            ) : null}
          </span>
        </button>
        <IconButton label="Exercise options" tone="muted" onClick={() => setMenuOpen(true)}>
          <MoreHorizontal className="h-6 w-6" />
        </IconButton>
      </div>

      {/* Pinned (sticky) note */}
      {ex.notes ? (
        <button
          type="button"
          onClick={() => void pinNote()}
          className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-left text-[14px] leading-snug"
        >
          <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{ex.notes}</span>
        </button>
      ) : null}

      {/* Workout notes for this exercise */}
      <div className="px-3">
        <AutoTextarea
          value={we.notes ?? ''}
          onChange={(notes) => ops.updateExercise(we.id, { notes })}
          placeholder="Add notes here..."
        />
      </div>

      {/* Rest timer */}
      {mode === 'active' ? (
        <button
          type="button"
          onClick={() => setRestOpen(true)}
          className="mx-1.5 flex h-10 items-center gap-1.5 rounded-lg px-1.5 text-[14px] font-medium text-accent active:bg-surface-2"
        >
          <Timer className="h-4 w-4" />
          Rest Timer: {restOptionLabel(restSec)}
        </button>
      ) : null}

      {/* Set table */}
      <div className="mt-1 pb-1">
        <div
          className="grid items-center gap-1.5 px-3 pb-1 text-center text-[11px] font-semibold tracking-wide text-muted"
          style={setGridStyle(cols)}
        >
          <span>SET</span>
          <span>PREVIOUS</span>
          {cols.map((c) => (
            <span key={c} className="truncate">
              {header[c]}
            </span>
          ))}
          <span className="flex justify-center">
            <Check className="h-4 w-4" strokeWidth={3} />
          </span>
        </div>
        {we.sets.map((s, i) => (
          <SetRow
            key={s.id}
            we={we}
            set={s}
            exercise={ex}
            fields={fields}
            cols={cols}
            badge={badges[i]}
            prevSet={prevAligned[i] ?? null}
            aboveSet={i > 0 ? we.sets[i - 1] : null}
            restSec={restSec}
          />
        ))}
      </div>

      <div className="px-3 pt-1 pb-3">
        <button
          type="button"
          onClick={addSet}
          className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-surface-2 text-[14px] font-semibold text-fg active:bg-surface-3"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Add Set
        </button>
      </div>

      <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={ex.name} actions={actions} />
      <RestPickerSheet
        open={restOpen}
        onClose={() => setRestOpen(false)}
        exerciseName={ex.name}
        value={restSec}
        onPick={(sec, asDefault) => {
          ops.updateExercise(we.id, { restSec: sec });
          if (asDefault) {
            setExerciseRest(ex.id, sec).catch(() => toast('Could not save default rest', 'error'));
          }
        }}
      />
      <VariantSheet
        open={variantOpen}
        onClose={() => setVariantOpen(false)}
        exerciseId={we.exerciseId}
        onPick={(id) => ctx.switchVariant(we.id, id)}
      />
    </section>
  );
}

/** Borderless textarea that grows with its content (16px so iOS doesn't zoom). */
function AutoTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(28, el.scrollHeight)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="block w-full resize-none bg-transparent py-1 text-[16px] leading-snug text-fg outline-none placeholder:text-faint"
    />
  );
}
