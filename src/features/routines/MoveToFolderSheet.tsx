import { Check, Folder, FolderPlus, Inbox } from 'lucide-react';
import { Sheet, cx, toast } from '../../components/ui';
import { moveRoutineToFolder, useFolders } from '../../lib/routines';
import type { Routine } from '../../types';
import { attempt, promptNewFolder } from './routineActions';

/** "Move To Folder": My Routines, every custom folder, or a brand-new folder. */
export function MoveToFolderSheet({ routine, open, onClose }: { routine: Routine; open: boolean; onClose: () => void }) {
  const folders = useFolders();
  const current = routine.folderId && folders?.some((f) => f.id === routine.folderId) ? routine.folderId : null;

  const move = async (folderId: string | null, label: string) => {
    onClose();
    if (folderId === current) return;
    const ok = await attempt(() => moveRoutineToFolder(routine.id, folderId).then(() => true), 'Could not move the routine');
    if (ok) toast(`Moved to ${label}`, 'success');
  };

  const createAndMove = async () => {
    onClose();
    const id = await promptNewFolder();
    if (!id) return;
    const ok = await attempt(() => moveRoutineToFolder(routine.id, id).then(() => true), 'Could not move the routine');
    if (ok) toast('Routine moved', 'success');
  };

  const rows: { id: string | null; label: string }[] = [
    { id: null, label: 'My Routines' },
    ...(folders ?? []).map((f) => ({ id: f.id, label: f.name })),
  ];

  return (
    <Sheet open={open} onClose={onClose} title="Move To Folder">
      <div className="px-3 pb-3">
        <div className="mb-2 truncate px-2 text-center text-[14px] text-muted">{routine.name}</div>
        <div className="overflow-hidden rounded-2xl bg-surface-2">
          {rows.map((r, i) => {
            const selected = r.id === current;
            return (
              <button
                key={r.id ?? '__mine'}
                type="button"
                onClick={() => void move(r.id, r.label)}
                className={cx(
                  'flex w-full items-center gap-3 px-4 py-3.5 text-left text-[16px] transition-colors active:bg-surface-3',
                  i > 0 && 'border-t border-line',
                )}
              >
                {r.id ? <Folder className="h-5 w-5 shrink-0 text-muted" /> : <Inbox className="h-5 w-5 shrink-0 text-muted" />}
                <span className={cx('min-w-0 flex-1 truncate', selected && 'font-semibold')}>{r.label}</span>
                {selected ? <Check className="h-5 w-5 shrink-0 text-accent" aria-label="Current folder" /> : null}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => void createAndMove()}
            className="flex w-full items-center gap-3 border-t border-line px-4 py-3.5 text-left text-[16px] font-medium text-accent transition-colors active:bg-surface-3"
          >
            <FolderPlus className="h-5 w-5 shrink-0" />
            New folder…
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded-2xl bg-surface-2 py-3.5 text-[16px] font-semibold text-accent active:bg-surface-3"
        >
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
