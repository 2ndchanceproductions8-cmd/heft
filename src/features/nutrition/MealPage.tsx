import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Utensils } from 'lucide-react';
import { Button, EmptyState, Loading, Page, toast, TopBar } from '../../components/ui';
import { useMediaUrls } from '../../lib/media';
import { analysisInterrupted, runAnalysis, useAnalysisRunning } from '../../lib/nutrition/analyze';
import { useNutritionKeys } from '../../lib/nutrition/keys';
import { itemFromChoice, MealBusyError, updateMeal, useMeal } from '../../lib/nutrition/store';
import type { FoodChoice, Meal } from '../../lib/nutrition/types';
import { FoodSearchSheet } from './FoodSearchSheet';
import { MealDoneView } from './meal/MealDoneView';
import { AnalyzingView, DescriptionCard, MealPhotos, MealProblem } from './meal/MealStates';
import { diaryPath, logPath, SETTINGS_PATH } from './meal/nav';
import { BackButton } from './meal/parts';

/**
 * /nutrition/meal/:id — one meal through its whole life: analyzing (spinner), no key / failed (Retry or
 * manual entry), and done (the editor). A draft belongs to the capture screen and is sent back there.
 */
export function MealPage() {
  const { id = '' } = useParams();
  // Keyed so the run-once guard and local edits never leak from one meal to the next.
  return <MealScreen key={id} id={id} />;
}

const INTERRUPTED_MSG = 'The analysis was interrupted — Heft was closed before Claude answered.';

function MealScreen({ id }: { id: string }) {
  const nav = useNavigate();
  const meal = useMeal(id);
  const running = useAnalysisRunning(id);
  const keys = useNutritionKeys();
  const photoUrls = useMediaUrls(meal && meal.status !== 'done' ? meal.photoIds : null);
  const started = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [manual, setManual] = useState(false);
  const status = meal?.status;

  // A pending meal starts analyzing as soon as it's opened with a key — once per mount.
  useEffect(() => {
    if (status !== 'pending' || !keys.anthropic || started.current) return;
    started.current = true;
    runAnalysis(id).catch((e: unknown) => setStartError(e instanceof Error ? e.message : 'The analysis could not start.'));
  }, [status, keys.anthropic, id]);

  if (meal === undefined) {
    return (
      <Page>
        <TopBar title="Meal" />
        <Loading />
      </Page>
    );
  }
  if (meal === null) {
    return (
      <Page>
        <TopBar left={<BackButton onClick={() => nav(diaryPath(), { replace: true })} />} title="Meal" />
        <EmptyState
          icon={<Utensils className="h-7 w-7" />}
          title="Meal not found"
          message="It may have been deleted."
          action={<Button onClick={() => nav(diaryPath(), { replace: true })}>Back to Food</Button>}
        />
      </Page>
    );
  }
  if (meal.status === 'draft') return <Navigate to={logPath({ meal: meal.id })} replace />;
  if (meal.status === 'done') {
    return (
      <Page>
        <MealDoneView meal={meal} />
      </Page>
    );
  }

  const interrupted = meal.status === 'analyzing' && !running && analysisInterrupted(meal);
  let variant: 'analyzing' | 'failed' | 'no_key' = 'analyzing';
  let error: string | null = null;
  if (meal.status === 'failed') {
    variant = 'failed';
    error = meal.error;
  } else if (interrupted) {
    variant = 'failed';
    error = meal.error || INTERRUPTED_MSG;
  } else if (meal.status === 'pending' && startError) {
    variant = 'failed';
    error = startError;
  } else if (meal.status === 'pending' && !keys.anthropic) {
    variant = 'no_key';
  }

  const retry = async () => {
    setRetrying(true);
    setStartError(null);
    try {
      await runAnalysis(meal.id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'The analysis could not start.');
    } finally {
      setRetrying(false);
    }
  };

  const enterManually = async (c: FoodChoice, grams: number | null) => {
    if (grams == null) return;
    const item = itemFromChoice(c, grams);
    try {
      // An interrupted analysis left the row 'analyzing' with nothing running: only a forced write clears it.
      await updateMeal(
        meal.id,
        (m: Meal) => ({ items: [...m.items, item], status: 'done', error: null, title: m.title || c.name }),
        { force: interrupted },
      );
    } catch (e) {
      toast(e instanceof MealBusyError ? e.message : "Couldn't save that food", 'error');
    }
  };

  const description = meal.input.description?.trim() || undefined;
  return (
    <Page>
      <TopBar left={<BackButton onClick={() => nav(diaryPath(meal.day), { replace: true })} />} title="Meal" />
      {variant === 'analyzing' ? (
        <AnalyzingView photoUrls={photoUrls} photoCount={meal.photoIds.length} description={description} />
      ) : (
        <div className="space-y-3 px-4 pt-4">
          {meal.photoIds.length ? <MealPhotos urls={photoUrls} kind={meal.input.kind} /> : null}
          {description ? <DescriptionCard text={description} /> : null}
          <MealProblem
            variant={variant}
            error={error}
            hasKey={!!keys.anthropic}
            photosKept={meal.photoIds.length > 0}
            retrying={retrying}
            onRetry={() => void retry()}
            onAddKey={() => nav(SETTINGS_PATH)}
            onManual={() => setManual(true)}
          />
        </div>
      )}
      <FoodSearchSheet open={manual} onClose={() => setManual(false)} mode="add" title="Add food" onPick={(c, g) => void enterManually(c, g)} />
    </Page>
  );
}
