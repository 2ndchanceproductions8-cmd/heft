import { lazy, Suspense, type ComponentType } from 'react';
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom';
import { RootLayout, TabLayout } from './components/AppShell';
import { RouteError } from './components/RouteError';
import { WorkoutHomePage } from './features/routines/WorkoutHomePage';
import { RoutineDetailPage } from './features/routines/RoutineDetailPage';
import { RoutineEditorPage } from './features/routines/RoutineEditorPage';
import { ActiveWorkoutPage } from './features/workout/ActiveWorkoutPage';
import { FinishWorkoutPage } from './features/workout/FinishWorkoutPage';
import { EditWorkoutPage } from './features/workout/EditWorkoutPage';
import { HistoryPage } from './features/history/HistoryPage';
import { WorkoutDetailPage } from './features/history/WorkoutDetailPage';
import { ExerciseLibraryPage } from './features/exercises/ExerciseLibraryPage';
import { ExerciseFormPage } from './features/exercises/ExerciseFormPage';
import { SettingsPage } from './features/progress/SettingsPage';
import { AppleHealthPage } from './features/progress/AppleHealthPage';
import { Loading } from './components/ui';

// Chart pages pull in Recharts (~400 KB) — load them on demand (the service worker precaches the chunks).
function lazyPage(load: () => Promise<ComponentType>) {
  const C = lazy(() => load().then((c) => ({ default: c })));
  return function LazyPage() {
    return (
      <Suspense fallback={<Loading />}>
        <C />
      </Suspense>
    );
  };
}
const ExerciseDetailPage = lazyPage(() => import('./features/exercises/ExerciseDetailPage').then((m) => m.ExerciseDetailPage));
const ProgressPage = lazyPage(() => import('./features/progress/ProgressPage').then((m) => m.ProgressPage));
const MeasurementsPage = lazyPage(() => import('./features/progress/MeasurementsPage').then((m) => m.MeasurementsPage));

// Hash routing works on any static host (no SPA rewrite rules needed) and inside the installed PWA.
// Error boundaries (RouteError) at three levels so a render throw or a lazy chunk that fails to load never
// strands the standalone app on React Router's default error page: per tab page (keeps the tab bar; a tab
// switch resets it), per full-screen flow (keeps RootLayout, dialogs and the rest timer), and the root.
const router = createHashRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/workout" replace /> },
      {
        element: <TabLayout />,
        children: [
          {
            errorElement: <RouteError tabBar />,
            children: [
              { path: '/workout', element: <WorkoutHomePage /> },
              { path: '/routines/:id', element: <RoutineDetailPage /> },
              { path: '/history', element: <HistoryPage /> },
              { path: '/history/:id', element: <WorkoutDetailPage /> },
              { path: '/exercises', element: <ExerciseLibraryPage /> },
              { path: '/exercises/:id', element: <ExerciseDetailPage /> },
              { path: '/progress', element: <ProgressPage /> },
              { path: '/progress/measurements', element: <MeasurementsPage /> },
              { path: '/settings', element: <SettingsPage /> },
              { path: '/settings/apple-health', element: <AppleHealthPage /> },
            ],
          },
        ],
      },
      // Full-screen flows (no tab bar)
      {
        errorElement: <RouteError />,
        children: [
          { path: '/workout/active', element: <ActiveWorkoutPage /> },
          { path: '/workout/finish', element: <FinishWorkoutPage /> },
          { path: '/routines/new', element: <RoutineEditorPage /> },
          { path: '/routines/:id/edit', element: <RoutineEditorPage /> },
          { path: '/history/:id/edit', element: <EditWorkoutPage /> },
          { path: '/exercises/new', element: <ExerciseFormPage /> },
          { path: '/exercises/:id/edit', element: <ExerciseFormPage /> },
        ],
      },
      { path: '*', element: <Navigate to="/workout" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
