import { lazy, Suspense, type ComponentType } from 'react';
import type { RouteObject } from 'react-router-dom';
import { Loading } from '../../components/ui';

/*
 * Food tab routes, spread into src/App.tsx. Every page is lazy: the Food tab (and the Anthropic SDK / barcode
 * decoder it pulls in on demand) stays out of the main bundle; the service worker precaches the chunks.
 *
 * Tab pages:  /nutrition (Diary, ?d=yyyy-MM-dd for another day), /nutrition/settings
 * Full-screen: /nutrition/log (?meal=<id> resumes a draft), /nutrition/meal/:id, /nutrition/scan (?meal=<id> adds
 *              the product to that meal instead of a new one). lib/pwa.tsx never reloads under these.
 */

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

const DiaryPage = lazyPage(() => import('./DiaryPage').then((m) => m.DiaryPage));
const NutritionSettingsPage = lazyPage(() => import('./NutritionSettingsPage').then((m) => m.NutritionSettingsPage));
const CapturePage = lazyPage(() => import('./CapturePage').then((m) => m.CapturePage));
const MealPage = lazyPage(() => import('./MealPage').then((m) => m.MealPage));
const ScanPage = lazyPage(() => import('./ScanPage').then((m) => m.ScanPage));

export const nutritionTabRoutes: RouteObject[] = [
  { path: '/nutrition', element: <DiaryPage /> },
  { path: '/nutrition/settings', element: <NutritionSettingsPage /> },
];

export const nutritionFullRoutes: RouteObject[] = [
  { path: '/nutrition/log', element: <CapturePage /> },
  { path: '/nutrition/meal/:id', element: <MealPage /> },
  { path: '/nutrition/scan', element: <ScanPage /> },
];
