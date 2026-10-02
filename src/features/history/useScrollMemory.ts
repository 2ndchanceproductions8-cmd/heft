import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/** Window scroll offsets per history entry (location.key), for this app session. */
const positions = new Map<string, number>();

/**
 * Puts the page back where it was when the user returns to it with Back (a POP navigation).
 *
 * React Router's <ScrollRestoration> restores in the same commit as the route change, but these pages
 * read IndexedDB through useLiveQuery, which always answers a tick later. At that moment only the
 * loading spinner is on screen, so the restore clamps to the top. This hook records the offset while
 * the page is live and re-applies it in the commit where the content first renders (before paint).
 *
 * `ready` = the page's content is rendered at full height.
 */
export function useScrollMemory(ready: boolean): void {
  const { key } = useLocation();
  const navType = useNavigationType();
  /** True once the page has settled (restored or not); only then are scroll offsets recorded. */
  const recording = useRef(false);

  useLayoutEffect(() => {
    if (!ready || recording.current) return;
    const y = navType === 'POP' ? positions.get(key) : undefined;
    if (y && y > 0) window.scrollTo(0, y);
    recording.current = true;
  }, [ready, key, navType]);

  useEffect(() => {
    const onScroll = () => {
      if (recording.current) positions.set(key, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [key]);

  // Stop recording synchronously on unmount: the next page's scroll-to-top fires scroll events before
  // this page's passive cleanup has necessarily removed the listener.
  useLayoutEffect(
    () => () => {
      recording.current = false;
    },
    [],
  );
}
