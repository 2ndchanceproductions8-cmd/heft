import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { confirm, prompt, toast } from '../../components/ui';
import { beginWorkout } from '../../lib/startWorkout';
import { createFolderLast, deleteFolder, deleteRoutine, duplicateRoutineLast, renameFolder } from '../../lib/routines';
import type { Routine, RoutineFolder } from '../../types';

/** Run a DB write, toasting a friendly error instead of failing silently. Resolves to undefined on error. */
export async function attempt<T>(fn: () => Promise<T>, errorMessage: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.error(errorMessage, e);
    toast(errorMessage, 'error');
    return undefined;
  }
}

const folderNameRule = (v: string) => (v.trim() ? null : 'Enter a folder name');

/** Ask for a name and create a folder. Resolves to the new folder id (null when cancelled). */
export async function promptNewFolder(): Promise<string | null> {
  const name = await prompt({
    title: 'New Folder',
    placeholder: 'e.g. Upper / Lower',
    confirmLabel: 'Create',
    validate: folderNameRule,
  });
  if (name == null) return null;
  const id = await attempt(() => createFolderLast(name.trim()), 'Could not create the folder');
  if (id) toast(`Folder “${name.trim()}” created`, 'success');
  return id ?? null;
}

export async function promptRenameFolder(folder: RoutineFolder): Promise<void> {
  const name = await prompt({ title: 'Rename Folder', initial: folder.name, confirmLabel: 'Save', validate: folderNameRule });
  if (name == null || name.trim() === folder.name) return;
  await attempt(() => renameFolder(folder.id, name), 'Could not rename the folder');
}

export async function confirmDeleteFolder(folder: RoutineFolder, routineCount: number): Promise<void> {
  const ok = await confirm({
    title: `Delete “${folder.name}”?`,
    message:
      routineCount > 0
        ? `The ${routineCount === 1 ? 'routine' : `${routineCount} routines`} inside will move to My Routines.`
        : 'This folder is empty.',
    confirmLabel: 'Delete Folder',
    danger: true,
  });
  if (!ok) return;
  const done = await attempt(() => deleteFolder(folder.id).then(() => true), 'Could not delete the folder');
  if (done) toast('Folder deleted', 'success');
}

/** Confirm + delete a routine. Resolves true when deleted. `beforeDelete` runs after confirming (e.g. navigate away). */
export async function confirmDeleteRoutine(routine: Routine, beforeDelete?: () => void): Promise<boolean> {
  const ok = await confirm({
    title: 'Delete routine?',
    message: `“${routine.name}” will be deleted. Workouts you already logged with it stay in your history.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return false;
  beforeDelete?.();
  const done = await attempt(() => deleteRoutine(routine.id).then(() => true), 'Could not delete the routine');
  if (done) toast('Routine deleted', 'success');
  return !!done;
}

export async function duplicateWithToast(routine: Routine): Promise<string | null> {
  const id = await attempt(() => duplicateRoutineLast(routine.id), 'Could not duplicate the routine');
  if (id) toast('Routine duplicated', 'success');
  return id ?? null;
}

/** Start a routine (guards against double taps while the "workout in progress" dialog is open). */
export function useStartRoutine() {
  const nav = useNavigate();
  const busy = useRef(false);
  return useCallback(
    async (routine: Routine) => {
      if (busy.current) return;
      busy.current = true;
      try {
        await beginWorkout({ type: 'routine', routine }, nav);
      } catch (e) {
        console.error(e);
        toast('Could not start the workout', 'error');
      } finally {
        busy.current = false;
      }
    },
    [nav],
  );
}

/** Back navigation that falls back to `fallback` when there is no in-app history (deep link / fresh PWA launch). */
export function useGoBack(fallback: string) {
  const nav = useNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav(fallback, { replace: true });
  }, [nav, fallback]);
}

/** Current time, re-rendering every `intervalMs` while `enabled`. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}

/** Boolean persisted in localStorage (per device). Falls back to memory when storage is unavailable. */
export function useLocalFlag(key: string, initial = false): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : raw === '1';
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      try {
        localStorage.setItem(key, v ? '1' : '0');
      } catch {
        /* private mode etc. */
      }
    },
    [key],
  );
  return [value, set];
}
