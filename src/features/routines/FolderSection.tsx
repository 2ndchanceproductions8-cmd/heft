import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, FolderPlus, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { ActionSheet, IconButton, cx } from '../../components/ui';
import type { RoutineFolder } from '../../types';
import { confirmDeleteFolder, promptRenameFolder } from './routineActions';

/**
 * Collapsible routine group ("My Routines" or a custom folder). Custom folders get a ⋯ menu:
 * Rename, Add Routine Here, Delete Folder.
 */
export function FolderSection({
  title,
  count,
  collapsed,
  onToggle,
  folder,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Present for custom folders (enables the ⋯ menu). */
  folder?: RoutineFolder;
  children: ReactNode;
}) {
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const bodyId = `folder-body-${folder?.id ?? 'mine'}`;

  return (
    <section className="mt-4">
      <div className="flex items-center pr-2 pl-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 rounded-xl px-2 text-left transition-colors active:bg-surface-2"
        >
          <ChevronDown
            className={cx('h-5 w-5 shrink-0 text-muted transition-transform duration-200', collapsed && '-rotate-90')}
            aria-hidden
          />
          <span className="truncate text-[16px] font-semibold">{title}</span>
          <span className="shrink-0 text-[15px] text-muted tabular-nums">({count})</span>
        </button>
        {folder ? (
          <IconButton label={`Options for folder ${folder.name}`} tone="muted" onClick={() => setMenu(true)}>
            <MoreHorizontal className="h-5 w-5" />
          </IconButton>
        ) : null}
      </div>

      {!collapsed ? (
        <div id={bodyId} className="mt-1 space-y-3 px-4">
          {count === 0 && folder ? (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-line px-4 py-3">
              <span className="text-[14px] text-muted">No routines in this folder yet.</span>
              <button
                type="button"
                onClick={() => nav(`/routines/new?folder=${encodeURIComponent(folder.id)}`)}
                className="flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-[14px] font-semibold text-accent active:bg-surface-2"
              >
                <Plus className="h-4 w-4" />
                Add Routine
              </button>
            </div>
          ) : (
            children
          )}
        </div>
      ) : null}

      {folder ? (
        <ActionSheet
          open={menu}
          onClose={() => setMenu(false)}
          title={folder.name}
          actions={[
            { label: 'Rename', icon: <Pencil className="h-5 w-5" />, onClick: () => void promptRenameFolder(folder) },
            {
              label: 'Add Routine Here',
              icon: <FolderPlus className="h-5 w-5" />,
              onClick: () => nav(`/routines/new?folder=${encodeURIComponent(folder.id)}`),
            },
            {
              label: 'Delete Folder',
              icon: <Trash2 className="h-5 w-5" />,
              danger: true,
              hint: count ? 'Routines move to My Routines' : undefined,
              onClick: () => void confirmDeleteFolder(folder, count),
            },
          ]}
        />
      ) : null}
    </section>
  );
}
