import { useSyncExternalStore } from 'react';

/*
 * API keys for the Food tab — DEVICE ONLY.
 *
 * Heft's repo and Pages site are PUBLIC, so a key can never be bundled (no VITE_ env var) or committed. The
 * user pastes their own keys in Food settings; they live in this browser's localStorage and nowhere else:
 * - NOT in the Settings row or any Dexie table: those go into the JSON backup (a file that gets shared), and
 *   restore / "Delete all data" clear the tables.
 * - The installed home-screen app has storage separate from Safari, so keys are entered inside the app.
 *
 * Every read/write is wrapped: storage can throw (private mode, blocked site data).
 */

const ANTHROPIC = 'heft-key:anthropic';
const FDC = 'heft-key:fdc';
const CHANGED = 'heft-keys-changed';

function read(k: string): string | null {
  try {
    const v = localStorage.getItem(k);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function write(k: string, v: string | null): void {
  try {
    if (v && v.trim()) localStorage.setItem(k, v.trim());
    else localStorage.removeItem(k);
  } catch {
    /* storage blocked: the key simply isn't remembered */
  }
  try {
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* non-browser (tests) */
  }
}

export const getAnthropicKey = () => read(ANTHROPIC);
export const setAnthropicKey = (v: string | null) => write(ANTHROPIC, v);
export const getFdcKey = () => read(FDC);
export const setFdcKey = (v: string | null) => write(FDC, v);

/** USDA's shared demo key (about 10–30 requests an hour per IP). Used only when the user hasn't added one. */
export const FDC_DEMO_KEY = 'DEMO_KEY';
/** The key to send to USDA: the user's own, else DEMO_KEY. */
export const fdcKeyOrDemo = () => getFdcKey() ?? FDC_DEMO_KEY;

/** Forget both keys (called by Settings → "Delete all data"). */
export function clearNutritionKeys(): void {
  write(ANTHROPIC, null);
  write(FDC, null);
}

/** "sk-ant-…a1B2" — never show a whole key. */
export function maskKey(key: string | null | undefined): string {
  if (!key) return '';
  const tail = key.slice(-4);
  const head = key.startsWith('sk-ant-') ? 'sk-ant-' : '';
  return `${head}…${tail}`;
}

/** Loose shape check before saving a pasted Anthropic key (catches pasting the wrong thing). */
export function looksLikeAnthropicKey(v: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v.trim());
}

function subscribe(cb: () => void): () => void {
  const on = () => cb();
  window.addEventListener(CHANGED, on);
  window.addEventListener('storage', on);
  return () => {
    window.removeEventListener(CHANGED, on);
    window.removeEventListener('storage', on);
  };
}

/** Live view of which keys are set (re-renders when they change). */
export function useNutritionKeys(): { anthropic: string | null; fdc: string | null } {
  const anthropic = useSyncExternalStore(subscribe, getAnthropicKey, () => null);
  const fdc = useSyncExternalStore(subscribe, getFdcKey, () => null);
  return { anthropic, fdc };
}
