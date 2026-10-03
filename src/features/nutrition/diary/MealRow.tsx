import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { Camera, MessageSquareText, ScanBarcode, Search, TriangleAlert, Zap } from 'lucide-react';
import { Button, Spinner } from '../../../components/ui';
import { useMediaUrl } from '../../../lib/media';
import { analysisInterrupted, useAnalysisRunning } from '../../../lib/nutrition/analyze';
import { getAnthropicKey } from '../../../lib/nutrition/keys';
import { dayKey } from '../../../lib/nutrition/math';
import type { Meal, MealInput } from '../../../lib/nutrition/types';
import { retryMeal } from '../meal/actions';
import { logPath, mealPath } from '../meal/nav';
import { ConfidenceBadge, formatKcal, MacroLine } from '../ui';

/** What a Diary row shows. An 'analyzing' meal whose run died with the app (iOS kill) shows as failed. */
export type RowState = 'done' | 'draft' | 'pending' | 'analyzing' | 'failed';

export function rowState(meal: Pick<Meal, 'status'>, interrupted: boolean): RowState {
  if (meal.status === 'analyzing') return interrupted ? 'failed' : 'analyzing';
  return meal.status;
}

/**
 * Where tapping a row goes: drafts resume the capture screen (with `&d=` for a draft from another day, so it
 * keeps logging there), everything else opens the meal.
 */
export function mealHref(meal: Pick<Meal, 'id' | 'status' | 'day'>, today: string = dayKey(Date.now())): string {
  if (meal.status !== 'draft') return mealPath(meal.id);
  return logPath({ meal: meal.id, d: meal.day && meal.day !== today ? meal.day : null });
}

/** The button on an unfinished row: Continue (draft), Analyze (waiting), Retry (failed or interrupted). */
export function rowActionLabel(state: RowState): string | null {
  return state === 'draft' ? 'Continue' : state === 'pending' ? 'Analyze' : state === 'failed' ? 'Retry' : null;
}

/**
 * What a row's button does. Retry with a Claude key starts the analysis right away (not awaited) and opens the
 * meal, which shows it running; without a key it only opens the meal, which offers "Add Claude key". Analyze
 * opens the meal, which starts a waiting meal itself when a key is saved. Continue resumes the capture.
 */
export function runRowAction(
  meal: Pick<Meal, 'id' | 'status' | 'day'>,
  state: RowState,
  navigate: (to: string) => void,
  o: { hasKey?: boolean; today?: string } = {},
): void {
  if (state === 'failed') retryMeal(meal.id, o.hasKey ?? !!getAnthropicKey(), navigate);
  else navigate(mealHref(meal, o.today));
}

const KIND_ICON: Record<MealInput['kind'], ReactNode> = {
  photo: <Camera className="h-5 w-5" />,
  text: <MessageSquareText className="h-5 w-5" />,
  barcode: <ScanBarcode className="h-5 w-5" />,
  search: <Search className="h-5 w-5" />,
  quick: <Zap className="h-5 w-5" />,
};

/** Presentational row (plain props, so it renders in tests without the analysis engine). */
export function MealRowView({
  meal,
  thumbUrl,
  state,
  onOpen,
  onAction,
}: {
  meal: Meal;
  thumbUrl: string | null;
  state: RowState;
  onOpen: () => void;
  /** Analyze (pending) / Retry (failed or interrupted): see runRowAction. */
  onAction: () => void;
}) {
  // A meal not analyzed yet has no title: what the user typed names it best.
  const title = meal.title.trim() || meal.input.description?.trim() || 'Untitled meal';
  const time = format(meal.at, 'h:mm a');
  // A draft row is tapped as a whole ("tap to continue"), so it has no separate button here.
  const action = state === 'draft' ? null : rowActionLabel(state);
  const error = meal.error?.trim() || (meal.status === 'analyzing' ? 'The analysis was interrupted.' : 'The analysis failed.');

  return (
    <div className="flex items-center">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-3 pl-4 text-left transition-colors active:bg-surface-2"
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-muted">
          {thumbUrl ? <img src={thumbUrl} alt="" className="h-full w-full object-cover" /> : KIND_ICON[meal.input.kind]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">{title}</span>
            <span className="shrink-0 text-[13px] text-muted tabular-nums">{time}</span>
          </span>
          {state === 'done' ? (
            <>
              <span className="mt-0.5 flex items-baseline gap-2 text-[13px]">
                <span className="shrink-0 font-semibold text-fg tabular-nums">{formatKcal(meal.totals.kcal)} kcal</span>
                <MacroLine className="truncate" proteinG={meal.totals.proteinG} carbsG={meal.totals.carbsG} fatG={meal.totals.fatG} />
              </span>
              {meal.confidence ? <ConfidenceBadge className="mt-1.5" confidence={meal.confidence} /> : null}
            </>
          ) : state === 'draft' ? (
            <span className="mt-0.5 block text-[13px] font-medium text-warn">Unfinished — tap to continue</span>
          ) : state === 'pending' ? (
            <span className="mt-0.5 block text-[13px] text-muted">Waiting to analyze</span>
          ) : state === 'analyzing' ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
              <Spinner className="h-4 w-4" />
              Analyzing…
            </span>
          ) : (
            <span className="mt-0.5 flex items-start gap-1.5 text-[13px] leading-snug text-danger">
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="line-clamp-2">{error}</span>
            </span>
          )}
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

/** A Diary row wired to the photo store and the analysis engine. */
export function MealRow({ meal }: { meal: Meal }) {
  const navigate = useNavigate();
  const thumbUrl = useMediaUrl(meal.photoIds[0]);
  const running = useAnalysisRunning(meal.id);
  const interrupted = meal.status === 'analyzing' && !running && analysisInterrupted(meal);
  const state = rowState(meal, interrupted);
  return (
    <MealRowView
      meal={meal}
      thumbUrl={thumbUrl}
      state={state}
      onOpen={() => navigate(mealHref(meal))}
      onAction={() => runRowAction(meal, state, navigate)}
    />
  );
}
