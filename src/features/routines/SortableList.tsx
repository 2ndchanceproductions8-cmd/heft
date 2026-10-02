import type { ReactNode } from 'react';
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
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { cx } from '../../components/ui';
import { moveItem } from './routineUtils';

/** Lists only reorder vertically. */
const restrictToVertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * Vertical drag-to-reorder list. Mouse drags start after 5px; touch drags start after a 150ms press
 * (5px tolerance) so a quick swipe still scrolls the page. The whole row is draggable; a grip icon marks it.
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  renderItem,
  className,
}: {
  items: T[];
  onReorder: (orderedIds: string[]) => void;
  renderItem: (item: T, dragging: boolean) => ReactNode;
  className?: string;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = items.map((i) => i.id);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(8);
      } catch {
        /* ignore */
      }
    }
    onReorder(moveItem(ids, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVertical]} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={className}>
          {items.map((it) => (
            <SortableRow key={it.id} id={it.id}>
              {(dragging) => renderItem(it, dragging)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ id, children }: { id: string; children: (dragging: boolean) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 20 : undefined,
        WebkitTouchCallout: 'none',
      }}
      className="cursor-grab touch-manipulation select-none active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      {children(isDragging)}
    </div>
  );
}

/** Standard reorder row: grip + content, lifted while dragging. `raised` for rows inside a sheet. */
export function ReorderRow({ dragging, children, raised }: { dragging: boolean; children: ReactNode; raised?: boolean }) {
  return (
    <div
      className={cx(
        'flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-shadow',
        raised ? 'bg-surface-2' : 'bg-surface',
        dragging && 'shadow-2xl ring-2 ring-accent/60',
      )}
    >
      <GripVertical className="h-5 w-5 shrink-0 text-faint" aria-hidden />
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
    </div>
  );
}
