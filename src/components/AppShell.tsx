import { useEffect } from 'react';
import { NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router-dom';
import { Dumbbell, History, Library, ChartColumn, Utensils, LayoutDashboard } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ExerciseProvider } from '../lib/ExerciseProvider';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { useWorkoutStore } from '../lib/workoutStore';
import { db, requestPersistentStorage } from '../db';
import { DialogHost, ToastHost } from './ui/dialogs';
import { cx } from './ui/Button';
import { MiniWorkoutBar } from '../features/workout/MiniWorkoutBar';
import { RestTimerWatcher } from '../features/workout/RestTimerWatcher';

/** localStorage hint read by the inline script in index.html so the first paint uses the saved theme. */
const THEME_KEY = 'heft.theme';

/**
 * Applies the theme setting to <html> (dark default), the browser chrome color and the iOS status bar.
 * Waits for the settings row: before IndexedDB answers it keeps what index.html applied, so a light-theme
 * user never sees the dark default flash in.
 */
function ThemeEffect() {
  // undefined while loading, null when no settings were ever saved (then the default applies).
  const row = useLiveQuery(() => db.settings.get('settings').then((s) => s ?? null), []);
  const theme = row === undefined ? undefined : (row?.theme ?? DEFAULT_SETTINGS.theme);
  useEffect(() => {
    if (!theme) return;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage blocked: the next launch starts dark */
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f2f7');
      // iOS reads this at launch (index.html sets it from the hint above); light needs dark status-bar glyphs.
      document
        .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
        ?.setAttribute('content', dark ? 'black-translucent' : 'default');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  return null;
}

/** App root: providers, hydration of the active workout, global dialogs. */
export function RootLayout() {
  const hydrate = useWorkoutStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    void requestPersistentStorage();
  }, [hydrate]);
  return (
    <ExerciseProvider>
      <ThemeEffect />
      <ScrollRestoration />
      <Outlet />
      <RestTimerWatcher />
      <DialogHost />
      <ToastHost />
    </ExerciseProvider>
  );
}

const TABS = [
  { to: '/today', label: 'Today', icon: LayoutDashboard, also: [] },
  { to: '/workout', label: 'Workout', icon: Dumbbell, also: ['/routines'] },
  { to: '/nutrition', label: 'Food', icon: Utensils, also: [] },
  { to: '/history', label: 'History', icon: History, also: [] },
  { to: '/exercises', label: 'Exercises', icon: Library, also: [] },
  { to: '/progress', label: 'Progress', icon: ChartColumn, also: ['/settings'] },
];

/** Pages with the bottom tab bar (and the "workout in progress" bar above it). */
export function TabLayout() {
  const { pathname } = useLocation();
  const isActive = (t: (typeof TABS)[number]) =>
    [t.to, ...t.also].some((p) => pathname === p || pathname.startsWith(p + '/'));
  return (
    <>
      <Outlet />
      <div className="fixed inset-x-0 bottom-0 z-40">
        {/* The Workout home already shows a big "Workout in progress" card. */}
        {pathname !== '/workout' ? <MiniWorkoutBar /> : null}
        <nav className="border-t border-line/70 bg-bg/90 pb-safe backdrop-blur-xl">
          <div className="mx-auto flex h-[56px] max-w-xl">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = isActive(t);
              return (
                <NavLink
                  key={t.to}
                  to={t.to}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
                    active ? 'text-accent' : 'text-faint',
                  )}
                >
                  <Icon className="h-[25px] w-[25px]" strokeWidth={1.9} />
                  {t.label}
                </NavLink>
              );
            })}
          </div>
        </nav>
      </div>
    </>
  );
}
