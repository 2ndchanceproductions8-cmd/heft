import { useEffect } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from './ui/Button';
import { EmptyState } from './ui/controls';
import { Page } from './ui/Page';

const CHUNK_ERROR =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch|Unable to preload CSS/i;

/** True for a lazy page chunk that could not be loaded (usually a stale page after an app update). */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : '';
  return CHUNK_ERROR.test(msg);
}

function errorMessage(err: unknown): string {
  if (isRouteErrorResponse(err)) return `${err.status} ${err.statusText}`.trim();
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '';
}

/**
 * Route `errorElement`: replaces React Router's developer error page, which has no way back in an
 * installed (standalone) app. Self-contained on purpose — at the root it renders INSTEAD of RootLayout, so
 * it must not use ExerciseProvider, dialogs or any other RootLayout context.
 */
export function RouteError({ tabBar }: { tabBar?: boolean }) {
  const err = useRouteError();
  const stale = isChunkLoadError(err);
  useEffect(() => {
    console.error('[route error]', err);
  }, [err]);

  const reload = () => window.location.reload();
  // A lazy page that failed to load stays failed (React.lazy caches the rejection), so a stale chunk only
  // offers Reload. Hash navigation also works when this replaced the whole app.
  const onWorkoutHome = /^#\/workout\/?$/.test(window.location.hash);
  const goWorkout = () => {
    window.location.hash = '#/workout';
  };

  return (
    <Page tabBar={tabBar} className="flex flex-col justify-center pt-safe">
      <EmptyState
        icon={stale ? <RotateCw className="h-7 w-7" /> : <TriangleAlert className="h-7 w-7" />}
        title={stale ? 'Heft was updated' : 'Something went wrong'}
        message={
          <>
            {stale
              ? 'Reload to finish updating.'
              : errorMessage(err) || 'This screen could not be shown.'}{' '}
            A workout in progress is saved on this device.
          </>
        }
        action={
          <div className="flex w-56 flex-col gap-2">
            <Button block onClick={reload} icon={<RotateCw className="h-4 w-4" />}>
              Reload
            </Button>
            {!stale && !onWorkoutHome ? (
              <Button block variant="secondary" onClick={goWorkout}>
                Go to Workout
              </Button>
            ) : null}
          </div>
        }
      />
    </Page>
  );
}
