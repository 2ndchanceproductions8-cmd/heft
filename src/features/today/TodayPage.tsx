import { useMemo } from 'react';
import { format } from 'date-fns';
import { Page, TopBar } from '../../components/ui';
import { dayStart } from '../../lib/nutrition/math';
import { useWakeNow } from '../../lib/useWakeNow';
import { useTodayKey } from '../nutrition/diary/day';
import { CardBoundary } from './CardBoundary';
import { BodyCard } from './BodyCard';
import { FuelCard } from './FuelCard';
import { TrainingCard } from './TrainingCard';
import { WeekCard } from './WeekCard';

/*
 * Today (/today, the app's landing tab): body, food and training on one screen. The Hume scale's weigh-ins
 * (Apple Health → Measurements), the Food tab's meals and saved workouts, each one tap from its own tab, plus the
 * last 7 days lined up so the three can be read together. Recharts-free (plain SVG) so the landing page doesn't
 * wait for the chart chunk.
 */
export function TodayPage() {
  const today = useTodayKey();
  const wakeNow = useWakeNow();
  // Moves on when the app wakes or the day rolls over; stable between other renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [today, wakeNow]);

  return (
    <Page tabBar>
      <TopBar title="Today" large />
      <p className="px-4 pt-1 text-[15px] font-medium text-muted">{format(dayStart(today), 'EEEE, MMMM d')}</p>
      <div className="space-y-3 px-4 pt-3">
        <CardBoundary title="Body">
          <BodyCard today={today} now={now} />
        </CardBoundary>
        <CardBoundary title="Food">
          <FuelCard today={today} now={now} />
        </CardBoundary>
        <CardBoundary title="Training">
          <TrainingCard today={today} now={now} />
        </CardBoundary>
        <CardBoundary title="Last 7 days">
          <WeekCard today={today} now={now} />
        </CardBoundary>
      </div>
    </Page>
  );
}
