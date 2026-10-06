import type { ReactNode } from 'react';
import { format } from 'date-fns';
import { ChevronRight, Dumbbell, Utensils, Weight } from 'lucide-react';
import type { Unit, Workout } from '../../../types';
import { Button, cx } from '../../../components/ui';
import { remaining } from '../../../lib/nutrition/math';
import { formatDuration } from '../../../lib/units';
import type { WeekDay } from '../../../lib/today';
import { formatKcal } from '../../nutrition/ui';
import { bodyFatText, bodyWeightText, diaryHref } from './model';

/*
 * One day of the week card, in a sheet: food (kcal, protein, vs target) with a way into that day's Diary, each
 * workout (to its history page) and the weigh-in (to Measurements). Pure: navigation goes through `onGo`.
 * The target comparison is food only: workout burn is never part of the budget.
 */

function Section({ icon, title, children, name }: { icon: ReactNode; title: string; children: ReactNode; name: string }) {
  return (
    <section className="rounded-2xl bg-surface-2 p-3" data-section={name}>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-muted">
        <span className="text-accent [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DayDetail({
  day,
  today,
  unit,
  targetKcal,
  targetProteinG,
  workouts,
  onGo,
}: {
  day: WeekDay;
  today: string;
  unit: Unit;
  targetKcal: number | null;
  targetProteinG: number | null;
  /** That day's saved workouts, oldest first. */
  workouts: readonly Workout[];
  onGo: (to: string) => void;
}) {
  const isToday = day.day === today;
  const { intake, weighIn } = day;

  let balance: ReactNode = null;
  if (intake.logged && targetKcal != null) {
    const left = remaining(targetKcal, intake.kcal);
    const over = left < 0;
    const amount = `${formatKcal(Math.abs(left))} kcal`;
    balance = (
      <div className={cx('mt-0.5 text-[13px] font-medium tabular-nums', over ? 'text-danger' : 'text-muted')}>
        {isToday ? `${amount} ${over ? 'over' : 'left'}` : `${amount} ${over ? 'over' : 'under'} target`}
      </div>
    );
  }

  return (
    <div className="space-y-3 px-4 pb-4">
      <Section name="food" icon={<Utensils />} title="Food">
        {intake.logged ? (
          <>
            <div className="flex items-baseline gap-1.5 tabular-nums">
              <span className="text-[24px] leading-tight font-bold">{formatKcal(intake.kcal)}</span>
              <span className="text-[14px] text-muted">
                {targetKcal != null ? `/ ${formatKcal(targetKcal)} kcal` : 'kcal'}
                {isToday ? ' so far' : ''}
              </span>
            </div>
            <div className="mt-0.5 text-[13px] text-muted tabular-nums">
              {Math.round(intake.proteinG)}
              {targetProteinG != null ? ` / ${Math.round(targetProteinG)}` : ''} g protein · {plural(intake.meals, 'meal', 'meals')}
            </div>
            {balance}
          </>
        ) : (
          <div className="text-[15px] text-muted">{isToday ? 'Nothing logged yet' : 'Nothing logged'}</div>
        )}
        <Button variant="soft" block className="mt-3" onClick={() => onGo(diaryHref(day.day, today))}>
          Open food diary
        </Button>
      </Section>

      <Section name="training" icon={<Dumbbell />} title="Training">
        {workouts.length ? (
          <div className="-mx-1.5">
            {workouts.map((w) => (
              <button
                key={w.id}
                type="button"
                data-workout={w.id}
                onClick={() => onGo(`/history/${w.id}`)}
                className="flex min-h-11 w-full items-center gap-2 rounded-xl px-1.5 py-1.5 text-left transition-colors active:bg-surface-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-accent">{w.name || 'Workout'}</span>
                  <span className="block truncate text-[13px] text-muted tabular-nums">
                    {format(w.startedAt, 'h:mm a')} · {formatDuration(w.durationSec)}
                    {w.prs?.length ? ` · ${plural(w.prs.length, 'PR', 'PRs')}` : ''}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
              </button>
            ))}
          </div>
        ) : (
          <div className="text-[15px] text-muted">{isToday ? 'No workout yet' : 'Rest day'}</div>
        )}
      </Section>

      <Section name="weight" icon={<Weight />} title="Weight">
        {weighIn ? (
          <div className="-mx-1.5">
            <button
              type="button"
              data-weighin-link
              onClick={() => onGo('/progress/measurements')}
              className="flex min-h-11 w-full items-center gap-2 rounded-xl px-1.5 py-1 text-left transition-colors active:bg-surface-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[20px] leading-tight font-bold tabular-nums">{bodyWeightText(weighIn.kg, unit)}</span>
                <span className="block truncate text-[13px] text-muted tabular-nums">
                  {[
                    weighIn.bodyFatPct != null ? `${bodyFatText(weighIn.bodyFatPct)} body fat` : null,
                    weighIn.source === 'health' ? 'Apple Health' : 'Typed in',
                    format(weighIn.at, 'h:mm a'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
            </button>
          </div>
        ) : (
          <div className="text-[15px] text-muted">No weigh-in</div>
        )}
        {day.trendKg != null ? (
          <div className="mt-1 text-[13px] text-muted tabular-nums">
            Trend <span className="font-semibold text-fg">{bodyWeightText(day.trendKg, unit)}</span>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
