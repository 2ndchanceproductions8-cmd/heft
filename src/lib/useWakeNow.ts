import { useEffect, useState } from 'react';

/**
 * Date.now(), refreshed whenever the app returns to the foreground (installed PWAs can sit suspended for days,
 * so "today", "this month" and the week streak must not be frozen at the time the screen first rendered).
 */
export function useWakeNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake); // also covers a page restored from the back-forward cache
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
    };
  }, []);
  return now;
}
