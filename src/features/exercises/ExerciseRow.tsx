import { memo, type ReactNode } from 'react';
import { Check, Ellipsis, EyeOff } from 'lucide-react';
import type { Exercise } from '../../types';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { cx } from '../../components/ui';
import { EQUIPMENT_LABEL, MUSCLE_LABEL } from '../../lib/exerciseMeta';
import { useLongPress } from './hooks';

/** "Lats · Cable" (+ brand for gym/brand variants). */
export function exerciseSubtitle(ex: Exercise): string {
  const parts = [MUSCLE_LABEL[ex.primary], EQUIPMENT_LABEL[ex.equipment]];
  if (ex.brand) parts.push(ex.brand);
  return parts.join(' · ');
}

export interface ExerciseRowProps {
  exercise: Exercise;
  onPress: (ex: Exercise) => void;
  /** "⋯" button + long press (500ms) open the exercise actions. */
  onMore?: (ex: Exercise) => void;
  /** Overrides the default "Muscle · Equipment" line. */
  subtitle?: ReactNode;
  /** Times performed — shown as "12x" when > 0. */
  count?: number;
  selected?: boolean;
  /** Extra content on the right (before the ⋯ button). */
  right?: ReactNode;
  className?: string;
}

/** One exercise in a list: thumbnail, name, muscle/equipment, times performed, selection state. */
export const ExerciseRow = memo(function ExerciseRow({
  exercise,
  onPress,
  onMore,
  subtitle,
  count,
  selected,
  right,
  className,
}: ExerciseRowProps) {
  const { handlers, consumeClick } = useLongPress(onMore ? () => onMore(exercise) : undefined);
  return (
    <div className={cx('relative flex items-center transition-colors', selected && 'bg-accent-soft', className)}>
      {selected ? <span className="absolute top-1.5 bottom-1.5 left-0 w-1 rounded-r-full bg-accent" aria-hidden /> : null}
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => {
          if (consumeClick()) return;
          onPress(exercise);
        }}
        {...handlers}
        style={{ WebkitTouchCallout: 'none' }}
        className={cx(
          'flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left transition-colors',
          onMore ? 'pr-1' : 'pr-4',
          !selected && 'active:bg-surface-2',
        )}
      >
        <ExerciseThumb exercise={exercise} size={44} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] leading-snug font-medium">{exercise.name}</span>
          <span className="flex items-center gap-1 truncate text-[13px] leading-snug text-muted">
            {exercise.hidden ? <EyeOff className="h-3.5 w-3.5 shrink-0 text-faint" aria-label="Hidden" /> : null}
            <span className="truncate">{subtitle ?? exerciseSubtitle(exercise)}</span>
          </span>
        </span>
        {count ? <span className="shrink-0 text-[13px] font-medium text-faint tabular-nums">{count}x</span> : null}
        {right}
        {selected ? (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">
            <Check className="h-4 w-4" strokeWidth={3} />
          </span>
        ) : null}
      </button>
      {onMore ? (
        <button
          type="button"
          aria-label={`More options for ${exercise.name}`}
          onClick={() => onMore(exercise)}
          className="mr-1 flex h-11 w-10 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-3"
        >
          <Ellipsis className="h-5 w-5" />
        </button>
      ) : null}
      <span className="pointer-events-none absolute right-0 bottom-0 left-[72px] h-px bg-line/70" aria-hidden />
    </div>
  );
});
