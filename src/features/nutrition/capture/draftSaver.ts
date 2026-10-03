import type { DraftText } from '../meal/actions';

/** Quiet time after the last keystroke before the typed text is written to the draft row. */
export const DRAFT_SAVE_DELAY_MS = 600;

export interface DraftSaver {
  /** The user typed: (re)start the quiet-time timer. */
  typed(): void;
  /** Write any unsaved typing NOW (before leaving the screen, on unmount). Never throws. */
  flush(): Promise<void>;
  /** Forget unsaved typing: it was written some other way (Analyze, a new draft row) or discarded. */
  clear(): void;
  readonly dirty: boolean;
}

/**
 * The capture screen's typed-text saver. Description / weight go into the draft row 600 ms after the last
 * keystroke, and right away on flush(): the screen flushes before every navigation and on unmount, so the
 * last keystrokes are never lost to a cancelled timer. `target()` names the row to write to (null = there is
 * no draft row yet; the typing stays unsaved until one exists or it is written another way).
 */
export function createDraftSaver(o: {
  target: () => { draftId: string; text: DraftText } | null;
  write: (draftId: string, text: DraftText) => Promise<unknown>;
  delayMs?: number;
}): DraftSaver {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const flush = async () => {
    stop();
    if (!dirty) return;
    const t = o.target();
    if (!t) return;
    dirty = false;
    try {
      await o.write(t.draftId, t.text);
    } catch {
      /* the row is gone or being analyzed: nothing to keep it in */
    }
  };
  return {
    typed() {
      dirty = true;
      stop();
      timer = setTimeout(() => void flush(), o.delayMs ?? DRAFT_SAVE_DELAY_MS);
    },
    flush,
    clear() {
      stop();
      dirty = false;
    },
    get dirty() {
      return dirty;
    },
  };
}
