import { memo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { Clock, Copy, FolderInput, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react';
import { ActionSheet, Button, IconButton } from '../../components/ui';
import { useExercises } from '../../lib/ExerciseProvider';
import type { Routine } from '../../types';
import { MoveToFolderSheet } from './MoveToFolderSheet';
import { confirmDeleteRoutine, duplicateWithToast, useStartRoutine } from './routineActions';
import { exercisePreview } from './routineUtils';

export function lastPerformedLabel(ts: number | null | undefined): string {
  return ts ? `Last performed: ${formatDistanceToNow(ts, { addSuffix: true })}` : 'Never performed';
}

/** Hevy-style routine card: name, exercise preview, last performed, Start Routine, ⋯ menu. */
export const RoutineCard = memo(function RoutineCard({
  routine,
  lastPerformedAt,
}: {
  routine: Routine;
  lastPerformedAt: number | null | undefined;
}) {
  const nav = useNavigate();
  const { get } = useExercises();
  const start = useStartRoutine();
  const [menu, setMenu] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);

  const names = routine.exercises.map((e) => get(e.exerciseId).name);
  const open = () => nav(`/routines/${routine.id}`);

  return (
    <div className="rounded-2xl bg-surface">
      <div className="flex items-start">
        <button
          type="button"
          onClick={open}
          className="min-w-0 flex-1 rounded-tl-2xl px-4 pt-3.5 pb-1 text-left transition-colors active:bg-surface-2"
        >
          <div className="truncate text-[17px] font-bold">{routine.name}</div>
          <div className="mt-0.5 line-clamp-2 text-[14px] leading-snug text-muted">{exercisePreview(names)}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[13px] text-faint">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{lastPerformedLabel(lastPerformedAt)}</span>
          </div>
        </button>
        <IconButton label={`Options for ${routine.name}`} tone="muted" className="mt-2 mr-2" onClick={() => setMenu(true)}>
          <MoreHorizontal className="h-5 w-5" />
        </IconButton>
      </div>
      <div className="px-4 pt-2 pb-4">
        <Button block icon={<Play className="h-4 w-4 fill-current" />} onClick={() => void start(routine)}>
          Start Routine
        </Button>
      </div>

      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        title={routine.name}
        actions={[
          { label: 'Edit Routine', icon: <Pencil className="h-5 w-5" />, onClick: () => nav(`/routines/${routine.id}/edit`) },
          { label: 'Duplicate', icon: <Copy className="h-5 w-5" />, onClick: () => void duplicateWithToast(routine) },
          { label: 'Move To Folder', icon: <FolderInput className="h-5 w-5" />, onClick: () => setMoveOpen(true) },
          {
            label: 'Delete Routine',
            icon: <Trash2 className="h-5 w-5" />,
            danger: true,
            onClick: () => void confirmDeleteRoutine(routine),
          },
        ]}
      />
      {moveOpen ? <MoveToFolderSheet routine={routine} open onClose={() => setMoveOpen(false)} /> : null}
    </div>
  );
});
