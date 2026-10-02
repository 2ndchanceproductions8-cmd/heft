import { registerSW } from 'virtual:pwa-register';
import { toast } from '../components/ui/dialogs';

/*
 * Service-worker updates without pulling chunks out from under a running page.
 *
 * registerType is 'prompt' (vite.config.ts): a new version installs in the background and WAITS. Until it
 * takes over, the old worker keeps serving the old precache — old lazy chunks included — so the running
 * page keeps working, offline too. The new version takes over when the user taps Reload on the update
 * toast, when the app is backgrounded on a tab page, or on the next cold launch.
 */

const CHUNK_RELOAD_KEY = 'heft:chunk-reload';
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Full-screen flows (logger, finish screen, editors): never reload under them without the user's say-so. */
const FULL_SCREEN_ROUTE =
  /^#\/(?:workout\/(?:active|finish)|routines\/new|routines\/[^/?]+\/edit|history\/[^/?]+\/edit|exercises\/new|exercises\/[^/?]+\/edit)(?:[/?]|$)/;

/**
 * Safety net: a lazy page chunk that fails to load (stale page, evicted cache) reloads the app once, which
 * fetches the current index.html and chunks. The active workout is persisted on every change and the hash
 * route survives the reload. The event is not cancelled, so the import still rejects: if the guard trips,
 * the route's error screen (with its Reload button) shows instead of a broken module.
 */
function reloadOnStaleChunk() {
  window.addEventListener('vite:preloadError', () => {
    try {
      const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0);
      if (Date.now() - last < 10_000) return; // already reloaded for this — avoid a reload loop
      sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    } catch {
      return; // no way to guard against a loop: leave it to the error screen
    }
    window.location.reload();
  });
}

export function setupPwa() {
  reloadOnStaleChunk();

  let updateReady = false;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateReady = true;
      toast(
        <span className="flex items-center gap-3">
          <span>A new version of Heft is ready.</span>
          <button
            type="button"
            onClick={() => void updateSW(true)}
            className="pointer-events-auto shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[14px] font-semibold text-on-accent active:brightness-90"
          >
            Reload
          </button>
        </span>,
        'info',
        20_000,
      );
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // Hash routing never navigates, so the browser only checks for a new version at launch. Check again
      // when the app comes back to the foreground after a while (iOS keeps home-screen apps alive for days).
      let lastCheck = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || Date.now() - lastCheck < UPDATE_CHECK_MS) return;
        lastCheck = Date.now();
        registration.update().catch(() => {
          /* offline */
        });
      });
    },
  });

  // Apply a waiting update while the app is in the background on a tab page: nothing is being typed there,
  // and the reload is done by the time the user comes back.
  document.addEventListener('visibilitychange', () => {
    if (updateReady && document.visibilityState === 'hidden' && !FULL_SCREEN_ROUTE.test(window.location.hash)) {
      updateReady = false;
      void updateSW(true);
    }
  });
}
