import { Link2 } from 'lucide-react';
import type { WorkoutExercise } from '../../types';
import { Sheet, cx } from '../../components/ui';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { useExercises } from '../../lib/ExerciseProvider';
import type { SupersetColor } from './logic';

/** Pick another exercise of this workout to superset with. */
export function SupersetSheet({
  open,
  onClose,
  weId,
  exercises,
  colors,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  weId: string | null;
  exercises: WorkoutExercise[];
  colors: Map<string, SupersetColor>;
  onPick: (otherWeId: string) => void;
}) {
  const index = useExercises();
  const self = exercises.find((e) => e.id === weId);
  const others = exercises.filter((e) => e.id !== weId);
  return (
    <Sheet open={open && !!self} onClose={onClose} title="Add To Superset">
      <div className="px-4 pb-4">
        <p className="pb-3 text-center text-[14px] text-muted">
          Superset <span className="font-semibold text-fg">{self ? index.get(self.exerciseId).name : ''}</span> with:
        </p>
        {others.length ? (
          <div className="overflow-hidden rounded-2xl bg-surface-2">
            {others.map((we, i) => {
              const ex = index.get(we.exerciseId);
              const color = we.supersetId ? colors.get(we.supersetId) : undefined;
              return (
                <button
                  key={we.id}
                  type="button"
                  onClick={() => {
                    onPick(we.id);
                    onClose();
                  }}
                  className={cx(
                    'flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-surface-3',
                    i > 0 && 'border-t border-line',
                  )}
                >
                  <ExerciseThumb exercise={ex} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[16px] font-medium">{ex.name}</span>
                    {color ? <span className={cx('block text-[13px] font-semibold', color.text)}>In a superset</span> : null}
                  </span>
                  <Link2 className="h-5 w-5 shrink-0 text-faint" />
                </button>
              );
            })}
          </div>
        ) : (
          <p className="py-6 text-center text-[14px] text-muted">Add another exercise first.</p>
        )}
      </div>
    </Sheet>
  );
}
