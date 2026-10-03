import { useNavigate } from 'react-router-dom';
import { Camera, MessageSquareText, TriangleAlert } from 'lucide-react';
import { Button, ListGroup, SectionHeader, Spinner } from '../../../components/ui';
import { analysisInterrupted, useAnalysisRunning } from '../../../lib/nutrition/analyze';
import type { Meal } from '../../../lib/nutrition/types';
import { dayLabel } from './day';
import { mealHref, rowActionLabel, rowState, runRowAction, type RowState } from './MealRow';

/*
 * Unfinished meals from OTHER days than the one shown: a draft saved yesterday, a meal waiting for a Claude
 * key, a failed analysis. They never count toward a day until they're done, so without this they would sit
 * unseen on a past day.
 */

/** At most this many rows; the rest are counted underneath (finishing or deleting one shows the next). */
export const UNFINISHED_MAX = 5;

/** The unfinished meals (from useUnfinishedMeals) that belong to a day other than `day`. */
export function otherDayUnfinished(meals: Meal[] | undefined, day: string): Meal[] {
  return (meals ?? []).filter((m) => m.day !== day && m.status !== 'done');
}

const STATUS_TEXT: Record<RowState, string> = {
  draft: 'Unfinished',
  pending: 'Not analyzed',
  analyzing: 'Analyzing…',
  failed: "Couldn't analyze",
  done: '',
};

/** One compact row: what, which day, what's wrong, and the one button that moves it on. */
export function UnfinishedRowView({
  meal,
  state,
  today,
  onOpen,
  onAction,
}: {
  meal: Meal;
  state: RowState;
  today: string;
  onOpen: () => void;
  onAction: () => void;
}) {
  const title = meal.title.trim() || meal.input.description?.trim() || 'Untitled meal';
  const action = rowActionLabel(state);
  const Icon = state === 'failed' ? TriangleAlert : meal.photoIds.length ? Camera : MessageSquareText;
  return (
    <div className="flex items-center">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-3 pl-4 text-left active:bg-surface-2">
        <span
          className={
            state === 'failed'
              ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger'
              : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warn-soft text-warn'
          }
        >
          {state === 'analyzing' ? <Spinner className="h-4 w-4" /> : <Icon className="h-[18px] w-[18px]" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{title}</span>
          <span className="block truncate text-[13px] text-muted">
            {dayLabel(meal.day, today)} · {STATUS_TEXT[state]}
          </span>
        </span>
      </button>
      {action ? (
        <div className="shrink-0 pr-3">
          <Button variant="soft" onClick={onAction}>
            {action}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function UnfinishedRow({ meal, today }: { meal: Meal; today: string }) {
  const navigate = useNavigate();
  const running = useAnalysisRunning(meal.id);
  const state = rowState(meal, meal.status === 'analyzing' && !running && analysisInterrupted(meal));
  return (
    <UnfinishedRowView
      meal={meal}
      state={state}
      today={today}
      onOpen={() => navigate(mealHref(meal, today))}
      onAction={() => runRowAction(meal, state, navigate, { today })}
    />
  );
}

/** "Unfinished" section for meals on other days (renders nothing when there are none). */
export function UnfinishedMeals({ meals, today }: { meals: Meal[]; today: string }) {
  if (!meals.length) return null;
  const shown = meals.slice(0, UNFINISHED_MAX);
  const more = meals.length - shown.length;
  return (
    <>
      <SectionHeader>Unfinished on other days</SectionHeader>
      <ListGroup>
        {shown.map((m) => (
          <UnfinishedRow key={m.id} meal={m} today={today} />
        ))}
      </ListGroup>
      {more > 0 ? (
        <p className="px-5 pt-2 text-[12px] text-faint">
          {more} more unfinished {more === 1 ? 'meal' : 'meals'} — finish or delete these to see them.
        </p>
      ) : null}
    </>
  );
}
