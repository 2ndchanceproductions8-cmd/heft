import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { DurationCell, NumberCell, cx } from '../../components/ui';
import type { TypeFields } from '../../lib/exerciseMeta';
import { patchSide, SIDE_LABEL, SIDE_LETTER, sideOf } from '../../lib/sides';
import { anyToMeters, displayWeight, metersToAny, round, unitToKg, type AnyDistanceUnit } from '../../lib/units';
import type { ExerciseType, RoutineSet, Side, SideValues, Unit } from '../../types';
import { SET_BADGE_CLASS, formatReps, normalizeRepsText, parseRepsInput } from './routineUtils';

// Same look as the foundation NumberCell so mixed rows line up.
const cellClass =
  'h-9 w-full min-w-0 rounded-lg bg-surface-2 px-1 text-center text-[16px] font-semibold tabular-nums text-fg outline-none placeholder:font-semibold placeholder:text-faint focus:bg-surface-3 focus:ring-2 focus:ring-accent/60';

/** Grid template shared by the set table header and its rows (per-side tables add a narrow L / R column). */
export function setGridStyle(valueColumns: number, perSide = false) {
  return { gridTemplateColumns: `2.5rem ${perSide ? '0.75rem ' : ''}repeat(${valueColumns}, minmax(0, 1fr))` };
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

/**
 * One planned set in the routine editor: badge | weight | reps (or range) | distance | time. A per-side exercise
 * (or a set that already plans both sides) gets two lines, L and R, each with its own values; the badge spans both.
 * A plain set shows its values on both lines and splits the first time one side is edited (lib/sides.ts patchSide).
 */
export const RoutineSetRow = memo(function RoutineSetRow({
  set,
  index,
  badge,
  fields,
  unit,
  distanceUnit,
  perSide = false,
  exerciseType,
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
  /** Plan left and right separately (the whole table: the exercise is per-side or a set already has sides). */
  perSide?: boolean;
  /** For picking the better side that the set's top-level values mirror. */
  exerciseType?: ExerciseType;
  onChange: (setId: string, patch: Partial<RoutineSet>) => void;
  onBadge: (setId: string) => void;
  onDelete: (setId: string) => void;
}) {
  const cols = [fields.weight, fields.reps, fields.distance, fields.duration].filter(Boolean).length;
  const n = index + 1;

  /** Write one line's values: a side (splitting a plain set first, then re-syncing the mirror), else the set. */
  const change = (side: Side | null, patch: SideValues) => {
    if (!side) {
      onChange(set.id, patch);
      return;
    }
    const next = patchSide(set, side, patch, exerciseType);
    onChange(set.id, {
      sides: next.sides,
      weightKg: next.weightKg ?? null,
      reps: next.reps ?? null,
      repsMax: next.repsMax ?? null,
      durationSec: next.durationSec ?? null,
      distanceM: next.distanceM ?? null,
    });
  };

  const line = (side: Side | null) => {
    const v = (side ? sideOf(set, side) : set) ?? {};
    const what = side ? `Set ${n} ${SIDE_LABEL[side].toLowerCase()}` : `Set ${n}`;
    return (
      <Fragment key={side ?? 'set'}>
        {side ? (
          <span aria-hidden className="text-center text-[12px] font-bold text-muted">
            {SIDE_LETTER[side]}
          </span>
        ) : null}
        {fields.weight ? (
          <NumberCell
            ariaLabel={`${what} weight (${unit})`}
            value={displayWeight(v.weightKg, unit)}
            placeholder="-"
            onChange={(x) => change(side, { weightKg: x == null ? null : unitToKg(x, unit) })}
          />
        ) : null}
        {fields.reps ? <RepsCell ariaLabel={`${what} reps`} reps={v.reps} repsMax={v.repsMax} onChange={(x) => change(side, x)} /> : null}
        {fields.distance ? (
          <NumberCell
            ariaLabel={`${what} distance (${distanceUnit})`}
            // Edited at 2 dp like the logger's cell (displayDistanceAny rounds yd/m to 1 dp for display only).
            value={v.distanceM == null ? null : round(metersToAny(v.distanceM, distanceUnit), 2)}
            placeholder="-"
            onChange={(x) => change(side, { distanceM: x == null ? null : anyToMeters(x, distanceUnit) })}
          />
        ) : null}
        {fields.duration ? (
          <DurationCell ariaLabel={`${what} time`} value={v.durationSec} placeholder="0:00" onChange={(x) => change(side, { durationSec: x })} />
        ) : null}
      </Fragment>
    );
  };

  return (
    <SwipeToDelete onDelete={() => onDelete(set.id)}>
      <div
        className={cx('grid items-center gap-x-2 px-0.5', perSide ? 'gap-y-1 py-1.5' : 'py-1', index % 2 === 1 && 'bg-surface-2/50')}
        style={setGridStyle(cols, perSide)}
      >
        <div className="flex h-full justify-center" style={perSide ? { gridRow: 'span 2' } : undefined}>
          <button
            type="button"
            onClick={() => onBadge(set.id)}
            aria-label={`Set ${n} options`}
            className={cx(
              'flex w-9 items-center justify-center rounded-lg text-[15px] font-bold tabular-nums transition-[filter] active:brightness-90',
              perSide ? 'h-full min-h-9' : 'h-9',
              SET_BADGE_CLASS[set.type],
            )}
          >
            {badge}
          </button>
        </div>
        {perSide ? (
          <>
            {line('left')}
            {line('right')}
          </>
        ) : (
          line(null)
        )}
      </div>
    </SwipeToDelete>
  );
});
