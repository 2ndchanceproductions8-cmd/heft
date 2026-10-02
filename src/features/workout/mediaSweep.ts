import { db } from '../../db';

/*
 * Photos are written to db.media as soon as they are picked (Save Workout, Edit Workout, measurements, the
 * exercise form) and only referenced once the form is saved. If the app is killed in between (iOS often
 * terminates a backgrounded PWA, e.g. while the user reads calories off the Fitness app), the blob stays in
 * IndexedDB with nothing pointing at it — forever, and copied into every JSON backup. This sweep removes them.
 */

/** Photos picked less than this long before the app launched are left alone (another tab may hold them). */
export const MEDIA_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const BOOT_AT = Date.now();

/** Every string anywhere in a stored record (photo ids included), whatever field holds it. */
function collectStrings(v: unknown, out: Set<string>, depth = 0): void {
  if (v == null || depth > 12) return;
  if (typeof v === 'string') {
    out.add(v);
    return;
  }
  if (typeof v !== 'object') return;
  if ((typeof Blob !== 'undefined' && v instanceof Blob) || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return;
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, depth + 1);
    return;
  }
  for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out, depth + 1);
}

/**
 * Delete media rows that nothing refers to any more. Deliberately conservative:
 * - a row counts as referenced when its id appears ANYWHERE in any other table (workout, measurement,
 *   custom exercise and override photos, the active workout's Save Workout draft, and whatever a future
 *   table adds), not just in the fields known today;
 * - only rows created before `before` are considered (default: a day before this launch), so a photo held
 *   by a form that is still open — in this tab or another — is never touched;
 * - rows without a creation time are kept.
 * Runs in one read-write transaction so nothing can start referencing a row between the check and the delete.
 * Returns the number of rows deleted.
 */
export async function sweepOrphanMedia(opts: { before?: number } = {}): Promise<number> {
  const before = opts.before ?? BOOT_AT - MEDIA_SWEEP_GRACE_MS;
  const others = db.tables.filter((t) => t.name !== db.media.name);
  return db.transaction('rw', [db.media, ...others], async () => {
    const old = (await db.media
      .filter((m) => typeof m.createdAt === 'number' && m.createdAt < before)
      .primaryKeys()) as string[];
    if (!old.length) return 0;
    const referenced = new Set<string>();
    for (const t of others) await t.each((row: unknown) => collectStrings(row, referenced));
    const orphans = old.filter((id) => !referenced.has(id));
    if (orphans.length) await db.media.bulkDelete(orphans);
    return orphans.length;
  });
}

let scheduled = false;

/** Run the sweep once per app launch, a few seconds after start-up (off the critical path). */
export function scheduleOrphanMediaSweep(delayMs = 8000): void {
  if (scheduled || typeof window === 'undefined') return;
  scheduled = true;
  window.setTimeout(() => {
    sweepOrphanMedia()
      .then((n) => {
        if (n) console.info(`Removed ${n} unused photo${n === 1 ? '' : 's'}`);
      })
      .catch((e) => console.warn('media sweep failed', e));
  }, delayMs);
}
