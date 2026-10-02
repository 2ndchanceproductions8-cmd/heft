import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import type { WorkoutExercise } from '../../types';
import { Sheet, cx } from '../../components/ui';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { useExercises } from '../../lib/ExerciseProvider';
import type { SupersetColor } from './logic';

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** Drag exercises into a new order (press-and-hold on touch so the list still scrolls). */
export function ReorderSheet({
  open,
  onClose,
  exercises,
  colors,
  onReorder,
}: {
  open: boolean;
  onClose: () => void;
  exercises: WorkoutExercise[];
  colors: Map<string, SupersetColor>;
  onReorder: (orderedIds: string[]) => void;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = exercises.map((e) => e.id);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Reorder Exercises"
      right={
        <button type="button" onClick={onClose} className="h-10 px-2 text-[16px] font-semibold text-accent">
          Done
        </button>
      }
    >
      <p className="px-5 pb-3 text-center text-[13px] text-muted">Press and hold an exercise, then drag it.</p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[verticalOnly]}
        onDragStart={() => navigator.vibrate?.(8)}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="space-y-2 px-3 pb-4">
            {exercises.map((we) => (
              <SortableRow key={we.id} we={we} color={we.supersetId ? colors.get(we.supersetId) : undefined} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </Sheet>
  );
}

function SortableRow({ we, color }: { we: WorkoutExercise; color?: SupersetColor }) {
  const index = useExercises();
  const ex = index.get(we.exerciseId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: we.id });
  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition, touchAction: 'manipulation' }}
      className={cx(
        // No iOS "Save Image" callout when the thumbnail is pressed and held to start a drag.
        'relative flex cursor-grab items-center gap-3 overflow-hidden rounded-2xl bg-surface-2 py-2.5 pr-3 pl-3 select-none [-webkit-touch-callout:none]',
        isDragging && 'z-10 cursor-grabbing shadow-2xl ring-2 ring-accent/60',
      )}
    >
      {color ? <span className={cx('absolute inset-y-0 left-0 w-1', color.bar)} aria-hidden /> : null}
      <ExerciseThumb exercise={ex} size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] font-medium">{ex.name}</span>
        <span className="block text-[13px] text-muted">
          {we.sets.length} {we.sets.length === 1 ? 'set' : 'sets'}
        </span>
      </span>
      <GripVertical className="h-5 w-5 shrink-0 text-faint" />
    </li>
  );
}
