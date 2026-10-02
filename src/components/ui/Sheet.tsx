import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './Button';

// Stack of open sheets: only the top-most one reacts to Escape, and body scroll stays locked while any is open.
const stack: number[] = [];
let nextSheetId = 0;
function pushSheet(id: number) {
  stack.push(id);
  document.body.style.overflow = 'hidden';
}
function popSheet(id: number) {
  const i = stack.lastIndexOf(id);
  if (i >= 0) stack.splice(i, 1);
  if (!stack.length) document.body.style.overflow = '';
}

const DRAG_START_PX = 6;
const DISMISS_PX = 110;

/**
 * Bottom sheet. Drag the handle/header down (or tap the backdrop, or press Escape) to dismiss.
 * size="full" makes it ~94% of the viewport (pickers, editors); "auto" hugs its content.
 */
export function Sheet({
  open,
  onClose,
  title,
  left,
  right,
  children,
  footer,
  size = 'auto',
  className,
  bodyClassName,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'auto' | 'full';
  className?: string;
  bodyClassName?: string;
}) {
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; pointerId: number; active: boolean } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const idRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const id = ++nextSheetId;
    idRef.current = id;
    pushSheet(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === id) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      popSheet(id);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setDragY(0);
  }, [open]);

  if (!open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    // Never hijack taps on header buttons/inputs.
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select, [role="button"]')) return;
    drag.current = { startY: e.clientY, pointerId: e.pointerId, active: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dy = e.clientY - d.startY;
    if (!d.active) {
      if (dy < DRAG_START_PX) return;
      d.active = true;
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDragY(Math.max(0, dy));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d?.active) return;
    if (dragY > DISMISS_PX) onCloseRef.current();
    // If the parent keeps the sheet open (e.g. a cancelled "discard?" confirm), snap back.
    setDragY(0);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade-in bg-backdrop" onClick={() => onCloseRef.current()} />
      <div
        className={cx(
          'relative flex animate-sheet-up flex-col rounded-t-[22px] bg-surface shadow-2xl',
          size === 'full' ? 'h-[94dvh]' : 'max-h-[90dvh]',
          className,
        )}
        style={{ transform: dragY ? `translateY(${dragY}px)` : undefined, transition: dragging ? 'none' : 'transform .2s' }}
      >
        <div
          className="shrink-0 touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-surface-3" />
          {title || left || right ? (
            <div className="relative flex h-12 items-center px-3">
              <div className="z-10 flex flex-1 items-center">{left}</div>
              {title ? (
                <div className="pointer-events-none absolute inset-x-20 truncate text-center text-[17px] font-semibold">{title}</div>
              ) : null}
              <div className="z-10 flex flex-1 items-center justify-end">{right}</div>
            </div>
          ) : (
            <div className="h-3" />
          )}
        </div>
        <div className={cx('min-h-0 flex-1 overflow-y-auto overscroll-contain', bodyClassName)}>{children}</div>
        {footer ? <div className="shrink-0 border-t border-line px-4 pt-3 pb-safe">{footer}<div className="h-3" /></div> : <div className="pb-safe" />}
      </div>
    </div>,
    document.body,
  );
}

export interface SheetAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Secondary line under the label. */
  hint?: string;
}

/** iOS-style action menu. Each action closes the sheet before running. */
export function ActionSheet({
  open,
  onClose,
  title,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  actions: SheetAction[];
}) {
  return (
    <Sheet open={open} onClose={onClose}>
      {title ? <div className="px-5 pt-1 pb-3 text-center text-sm font-medium text-muted">{title}</div> : null}
      <div className="px-3 pb-3">
        <div className="overflow-hidden rounded-2xl bg-surface-2">
          {actions.map((a, i) => (
            <button
              key={a.label + i}
              type="button"
              disabled={a.disabled}
              onClick={() => {
                onClose();
                a.onClick();
              }}
              className={cx(
                'flex w-full items-center gap-3 px-4 py-3.5 text-left text-[16px] transition-colors active:bg-surface-3 disabled:opacity-40',
                i > 0 && 'border-t border-line',
                a.danger ? 'text-danger' : 'text-fg',
              )}
            >
              {a.icon ? <span className={cx('flex h-6 w-6 items-center justify-center', a.danger ? 'text-danger' : 'text-muted')}>{a.icon}</span> : null}
              <span className="flex-1">
                <span className="block font-medium">{a.label}</span>
                {a.hint ? <span className="block text-[13px] text-muted">{a.hint}</span> : null}
              </span>
            </button>
          ))}
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
