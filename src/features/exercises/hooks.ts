import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import { computeUsage, type ExerciseUsage } from './stats';

/** Times performed + recently performed exercises, from the whole workout history (undefined while loading). */
export function useExerciseUsage(): ExerciseUsage | undefined {
  return useLiveQuery(async () => computeUsage(await db.workouts.orderBy('startedAt').reverse().toArray()), []);
}

/** Nearest scrolling ancestor (the Sheet body inside pickers), or null for the page viewport. */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p && p !== document.body && p !== document.documentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * Incremental rendering for long lists (~800 exercises): renders `initial` rows, then grows by `step`
 * whenever the sentinel element nears the bottom of the scroll container. Resets when `resetKey` changes.
 */
export function useIncremental(
  total: number,
  resetKey: string,
  { initial = 60, step = 80, startAt }: { initial?: number; step?: number; startAt?: number } = {},
) {
  const [count, setCount] = useState(() => Math.max(initial, startAt ?? 0));
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) {
    setKey(resetKey);
    setCount(initial);
  }
  const shown = Math.min(count, total);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || shown >= total || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount((c) => Math.max(c, shown) + step);
      },
      { root: scrollParent(el), rootMargin: '0px 0px 900px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, total, step]);

  return { shown, hasMore: shown < total, sentinelRef, count, setCount };
}

/**
 * Long-press (default 500ms) for touch + mouse. Returns handlers to spread on the pressable element and
 * `consumeClick()` which returns true (and resets) when the click that follows a long press should be ignored.
 */
export function useLongPress(onLongPress: (() => void) | undefined, ms = 500) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const handlers = onLongPress
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.button !== 0) return;
          fired.current = false;
          origin.current = { x: e.clientX, y: e.clientY };
          if (timer.current != null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            timer.current = null;
            fired.current = true;
            try {
              navigator.vibrate?.(12);
            } catch {
              /* not supported */
            }
            onLongPress();
          }, ms);
        },
        onPointerMove: (e: React.PointerEvent) => {
          const o = origin.current;
          if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) clear();
        },
        onPointerUp: clear,
        onPointerCancel: clear,
        onPointerLeave: clear,
        onContextMenu: (e: React.MouseEvent) => {
          // Desktop right-click / Android long-press context menu → our menu instead.
          e.preventDefault();
          if (!fired.current) {
            clear();
            fired.current = true;
            onLongPress();
          }
        },
      }
    : {};

  const consumeClick = () => {
    if (fired.current) {
      fired.current = false;
      return true;
    }
    return false;
  };

  return { handlers, consumeClick };
}

/** Go back if there is in-app history, otherwise to `fallback` (deep links / reloads). */
export function useGoBack(fallback: string) {
  const nav = useNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav(fallback, { replace: true });
  }, [nav, fallback]);
}

/** True on devices with a precise pointer (desktop) — used to autofocus search only where no keyboard pops up. */
export function hasFinePointer(): boolean {
  try {
    return window.matchMedia('(pointer: fine)').matches;
  } catch {
    return false;
  }
}
