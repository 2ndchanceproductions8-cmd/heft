import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { DurationCell, NumberCell, cx } from '../../components/ui';
import type { TypeFields } from '../../lib/exerciseMeta';
import { anyToMeters, displayWeight, metersToAny, round, unitToKg, type AnyDistanceUnit } from '../../lib/units';
import type { RoutineSet, Unit } from '../../types';
import { SET_BADGE_CLASS, formatReps, normalizeRepsText, parseRepsInput } from './routineUtils';

// Same look as the foundation NumberCell so mixed rows line up.
const cellClass =
  'h-9 w-full min-w-0 rounded-lg bg-surface-2 px-1 text-center text-[16px] font-semibold tabular-nums text-fg outline-none placeholder:font-semibold placeholder:text-faint focus:bg-surface-3 focus:ring-2 focus:ring-accent/60';

/** Grid template shared by the set table header and its rows. */
export function setGridStyle(valueColumns: number) {
  return { gridTemplateColumns: `2.5rem repeat(${valueColumns}, minmax(0, 1fr))` };
}

/**
 * REPS cell that takes a single number ("10") or a range ("8-12"). Keeps the raw text while focused and
 * reports parsed { reps, repsMax } on every keystroke.
 *
 * inputMode is "decimal", not "numeric": the iPhone's numeric pad has digits ONLY (no "-", ".", "," or
 * space), so a range could not be typed at all. The decimal pad has a "." (or ",") key, which
 * normalizeRepsText shows as "-" immediately. Android's pads have "-" anyway.
 */
export function RepsCell({
  reps,
  repsMax,
  onChange,
  ariaLabel,
}: {
  reps: number | null | undefined;
  repsMax: number | null | undefined;
  onChange: (v: { reps: number | null; repsMax: number | null }) => void;
  ariaLabel?: string;
}) {
  const formatted = formatReps(reps, repsMax);
  const [text, setText] = useState(formatted);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(formatted);
  }, [formatted]);

  return (
    <input
      type="text"
      inputMode="decimal"
      enterKeyHint="done"
      autoComplete="off"
      aria-label={ariaLabel}
      value={text}
      placeholder="-"
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        setText(formatted);
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      onChange={(e) => {
        const t = normalizeRepsText(e.target.value);
        setText(t);
        onChange(parseRepsInput(t));
      }}
      className={cellClass}
    />
  );
}

const REVEAL = 84;
const DELETE_AT = 168;

/**
 * Swipe a row left to reveal "Delete"; a long swipe deletes straight away. Touch/pen only (mouse users
 * use the set menu). Vertical scrolling is left to the browser via touch-action: pan-y.
 */
export function SwipeToDelete({ onDelete, children, className }: { onDelete: () => void; children: ReactNode; className?: string }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const g = useRef<{ x: number; y: number; base: number; axis: 'x' | 'y' | null; id: number } | null>(null);
  const dxRef = useRef(0);
  const setOffset = (v: number) => {
    dxRef.current = v;
    setDx(v);
  };

  const end = (cancelled: boolean) => {
    const s = g.current;
    g.current = null;
    if (!s || s.axis !== 'x') return;
    setDragging(false);
    const cur = dxRef.current;
    if (cancelled) setOffset(s.base);
    else if (cur <= -DELETE_AT) {
      setOffset(0);
      onDelete();
    } else setOffset(cur <= -REVEAL / 2 ? -REVEAL : 0);
  };

  return (
    <div className={cx('relative overflow-hidden rounded-lg', className)} style={{ touchAction: 'pan-y' }}>
      {dx < 0 ? (
        <button
          type="button"
          onClick={() => {
            setOffset(0);
            onDelete();
          }}
          className="absolute inset-y-0 right-0 flex items-center justify-center gap-1 bg-danger text-[14px] font-semibold text-white"
          style={{ width: Math.max(REVEAL, -dx) }}
          aria-label="Delete set"
        >
          <Trash2 className="h-4 w-4" />
          {-dx >= 60 ? 'Delete' : null}
        </button>
      ) : null}
      <div
        className="relative bg-surface"
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dragging ? 'none' : 'transform .2s ease-out' }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return;
          g.current = { x: e.clientX, y: e.clientY, base: dxRef.current, axis: null, id: e.pointerId };
        }}
        onPointerMove={(e) => {
          const s = g.current;
          if (!s || s.id !== e.pointerId) return;
          const mx = e.clientX - s.x;
          const my = e.clientY - s.y;
          if (!s.axis) {
            if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.2) {
              s.axis = 'x';
              setDragging(true);
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* ignore */
              }
              (document.activeElement as HTMLElement | null)?.blur?.();
            } else if (Math.abs(my) > 10) {
              s.axis = 'y';
            }
          }
          if (s.axis === 'x') {
            const raw = Math.min(0, s.base + mx);
            const limit = DELETE_AT + 40;
            setOffset(raw < -limit ? -limit + (raw + limit) * 0.25 : raw);
          }
        }}
        onPointerUp={() => end(false)}
        onPointerCancel={() => end(true)}
        onClickCapture={(e) => {
          // Tapping a revealed row closes it instead of acting on what was tapped.
          if (dxRef.current !== 0 && !g.current) {
            e.preventDefault();
            e.stopPropagation();
            setOffset(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** One planned set in the routine editor: badge | weight | reps (or range) | distance | time. */
export const RoutineSetRow = memo(function RoutineSetRow({
  set,
  index,
  badge,
  fields,
  unit,
  distanceUnit,
  onChange,
  onBadge,
  onDelete,
}: {
  set: RoutineSet;
  index: number;
  badge: string;
  fields: TypeFields;
  unit: Unit;
  /** The exercise's distance unit (distanceUnitForType): yd/m for carries and sleds, mi/km otherwise. */
  distanceUnit: AnyDistanceUnit;
  onChange: (setId: string, patch: Partial<RoutineSet>) => void;
  onBadge: (setId: string) => void;
  onDelete: (setId: string) => void;
}) {
  const cols = [fields.weight, fields.reps, fields.distance, fields.duration].filter(Boolean).length;
  const n = index + 1;
  return (
    <SwipeToDelete onDelete={() => onDelete(set.id)}>
      <div className={cx('grid items-center gap-2 px-0.5 py-1', index % 2 === 1 && 'bg-surface-2/50')} style={setGridStyle(cols)}>
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => onBadge(set.id)}
            aria-label={`Set ${n} options`}
            className={cx(
              'flex h-9 w-9 items-center justify-center rounded-lg text-[15px] font-bold tabular-nums transition-[filter] active:brightness-90',
              SET_BADGE_CLASS[set.type],
            )}
          >
            {badge}
          </button>
        </div>
        {fields.weight ? (
          <NumberCell
            ariaLabel={`Set ${n} weight (${unit})`}
            value={displayWeight(set.weightKg, unit)}
            placeholder="-"
            onChange={(v) => onChange(set.id, { weightKg: v == null ? null : unitToKg(v, unit) })}
          />
        ) : null}
        {fields.reps ? (
          <RepsCell
            ariaLabel={`Set ${n} reps`}
            reps={set.reps}
            repsMax={set.repsMax}
            onChange={(v) => onChange(set.id, v)}
          />
        ) : null}
        {fields.distance ? (
          <NumberCell
            ariaLabel={`Set ${n} distance (${distanceUnit})`}
            // Edited at 2 dp like the logger's cell (displayDistanceAny rounds yd/m to 1 dp for display only).
            value={set.distanceM == null ? null : round(metersToAny(set.distanceM, distanceUnit), 2)}
            placeholder="-"
            onChange={(v) => onChange(set.id, { distanceM: v == null ? null : anyToMeters(v, distanceUnit) })}
          />
        ) : null}
        {fields.duration ? (
          <DurationCell
            ariaLabel={`Set ${n} time`}
            value={set.durationSec}
            placeholder="0:00"
            onChange={(v) => onChange(set.id, { durationSec: v })}
          />
        ) : null}
      </div>
    </SwipeToDelete>
  );
});
