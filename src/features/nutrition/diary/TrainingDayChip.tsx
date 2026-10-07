import { Dumbbell, Moon } from 'lucide-react';
import { cx, toast } from '../../../components/ui';
import { setTrainingDay, type TrainingDayInfo } from '../../../lib/nutrition/store';
import { RECOMP_REST_OFFSET } from '../../../lib/nutrition/targets';
import type { RecompTargets } from '../../../lib/nutrition/types';
import { formatKcal } from '../ui';

const SOURCE_TEXT: Record<TrainingDayInfo['source'], string> = {
  logged: 'workout logged',
  running: 'workout in progress',
  marked: 'set by you',
  none: 'no workout yet',
};

/**
 * Maintain · Recomp: what kind of day `day` is ("Training day · maintenance" / "Rest day · −400") and why, as one
 * button that flips it. A tap stores a mark for that day (lib/nutrition/store.ts setTrainingDay), so the morning of a
 * training day can already eat like one; a logged or running workout makes it a training day by itself.
 */
export function TrainingDayChipView({
  training,
  recomp,
  onToggle,
  className,
}: {
  training: TrainingDayInfo;
  recomp: RecompTargets;
  onToggle: () => void;
  className?: string;
}) {
  const on = training.training;
  const Icon = on ? Dumbbell : Moon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={`${on ? 'Training day' : 'Rest day'}, ${SOURCE_TEXT[training.source]}. Switch to ${on ? 'rest day' : 'training day'}`}
      className={cx(
        'flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors active:opacity-70',
        on ? 'bg-accent-soft' : 'bg-surface-2',
        className,
      )}
    >
      <Icon className={cx('h-[18px] w-[18px] shrink-0', on ? 'text-accent' : 'text-muted')} />
      <span className="min-w-0 flex-1">
        <span className={cx('block text-[14px] font-semibold', on && 'text-accent')}>
          {on ? 'Training day' : 'Rest day'}
          <span className="font-medium text-muted tabular-nums">
            {' · '}
            {on ? 'maintenance' : `${RECOMP_REST_OFFSET.toLocaleString().replace('-', '−')} kcal`}
          </span>
        </span>
        <span className="block truncate text-[12px] text-muted">
          Recomp · {SOURCE_TEXT[training.source]}
        </span>
      </span>
      <span className="shrink-0 text-right text-[12px] leading-tight">
        <span className="block font-semibold text-accent">Change</span>
        <span className="block text-faint tabular-nums">
          {on ? `rest ${formatKcal(recomp.restKcal)}` : `train ${formatKcal(recomp.trainingKcal)}`}
        </span>
      </span>
    </button>
  );
}

/** The live chip: flips `day` between training and rest. */
export function TrainingDayChip({ day, training, recomp, className }: { day: string; training: TrainingDayInfo; recomp: RecompTargets; className?: string }) {
  const toggle = () => {
    const next = !training.training;
    setTrainingDay(day, next)
      .then(() => toast(next ? 'Training day: eat at maintenance' : 'Rest day: 400 kcal under maintenance', 'success'))
      .catch(() => toast("Couldn't change the day", 'error'));
  };
  return <TrainingDayChipView training={training} recomp={recomp} onToggle={toggle} className={className} />;
}
