import { Check } from 'lucide-react';
import { Sheet, cx } from '../../components/ui';
import { ExerciseThumb } from '../../components/ExerciseImage';
import type { ExerciseIndex } from '../../lib/exercises';
import type { RoutineExercise } from '../../types';
import { ReorderRow, SortableList } from './SortableList';
import { supersetIndex, supersetLetter, supersetStyle } from './routineUtils';

/** Drag-to-reorder the routine's exercises. */
export function ReorderExercisesSheet({
  open,
  onClose,
  exercises,
  index,
  onReorder,
}: {
  open: boolean;
  onClose: () => void;
  exercises: RoutineExercise[];
  index: ExerciseIndex;
  onReorder: (orderedIds: string[]) => void;
}) {
  const ss = supersetIndex(exercises);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="full"
      title="Reorder Exercises"
      right={
        <button type="button" onClick={onClose} className="h-10 rounded-lg px-2 text-[17px] font-semibold text-accent active:opacity-60">
          Done
        </button>
      }
    >
      <p className="px-4 pb-2 text-center text-[13px] text-muted">Press and hold an exercise, then drag it into place.</p>
      <SortableList
        className="space-y-2 px-3 pb-6"
        items={exercises}
        onReorder={onReorder}
        renderItem={(re, dragging) => {
          const ex = index.get(re.exerciseId);
          const si = re.supersetId ? ss.get(re.supersetId) : undefined;
          return (
            <ReorderRow dragging={dragging} raised>
              <ExerciseThumb exercise={ex} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[16px] font-semibold">{ex.name}</div>
                <div className="flex items-center gap-2 text-[13px] text-muted">
                  <span>
                    {re.sets.length} {re.sets.length === 1 ? 'set' : 'sets'}
                  </span>
                  {si != null ? <span className={cx('font-semibold', supersetStyle(si).text)}>Superset {supersetLetter(si)}</span> : null}
                </div>
              </div>
            </ReorderRow>
          );
        }}
      />
    </Sheet>
  );
}

/** Choose which exercise to superset `forId` with. */
export function SupersetSheet({
  forId,
  onClose,
  exercises,
  index,
  onPick,
}: {
  forId: string | null;
  onClose: () => void;
  exercises: RoutineExercise[];
  index: ExerciseIndex;
  onPick: (partnerId: string) => void;
}) {
  const self = exercises.find((e) => e.id === forId);
  const ss = supersetIndex(exercises);
  const others = exercises.filter((e) => e.id !== forId);
  return (
    <Sheet open={!!self} onClose={onClose} title="Superset With…">
      {self ? (
        <div className="px-3 pb-3">
          <div className="mb-2 truncate px-2 text-center text-[14px] text-muted">{index.get(self.exerciseId).name}</div>
          <div className="overflow-hidden rounded-2xl bg-surface-2">
            {others.map((re, i) => {
              const ex = index.get(re.exerciseId);
              const si = re.supersetId ? ss.get(re.supersetId) : undefined;
              const together = !!re.supersetId && re.supersetId === self.supersetId;
              return (
                <button
                  key={re.id}
                  type="button"
                  disabled={together}
                  onClick={() => {
                    onClose();
                    onPick(re.id);
                  }}
                  className={cx(
                    'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors active:bg-surface-3 disabled:opacity-50',
                    i > 0 && 'border-t border-line',
                  )}
                >
                  <ExerciseThumb exercise={ex} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[16px] font-medium">{ex.name}</span>
                    {si != null ? (
                      <span className={cx('block text-[12px] font-semibold', supersetStyle(si).text)}>
                        {together ? 'Already in this superset' : `Joins Superset ${supersetLetter(si)}`}
                      </span>
                    ) : null}
                  </span>
                  {together ? <Check className="h-5 w-5 shrink-0 text-accent" /> : null}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="mt-2 w-full rounded-2xl bg-surface-2 py-3.5 text-[16px] font-semibold text-accent active:bg-surface-3"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div />
      )}
    </Sheet>
  );
}
