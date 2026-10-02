import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { IconButton, cx } from '../../components/ui';

interface Gesture {
  x0: number;
  y0: number;
  axis: 'x' | 'y' | null;
}

/**
 * Full-screen photo viewer: swipe left/right (or arrow buttons / keyboard) between photos, swipe up or
 * down (or Escape / the close button) to dismiss. Render it only while open (it starts on `startIndex`).
 */
export function PhotoViewer({
  urls,
  startIndex,
  onClose,
}: {
  urls: string[];
  startIndex: number;
  onClose: () => void;
}) {
  const count = urls.length;
  const [index, setIndex] = useState(startIndex);
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const gesture = useRef<Gesture | null>(null);
  const width = useRef(0);

  const i = Math.min(Math.max(0, index), Math.max(0, count - 1));
  const prev = () => setIndex(Math.max(0, i - 1));
  const next = () => setIndex(Math.min(count - 1, i + 1));

  useEffect(() => {
    if (!count) return; // nothing is shown, so don't lock the page
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setIndex((v) => Math.max(0, v - 1));
      else if (e.key === 'ArrowRight') setIndex((v) => Math.min(count - 1, v + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [count, onClose]);

  if (!count) return null;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gesture.current = { x0: e.clientX, y0: e.clientY, axis: null };
    width.current = e.currentTarget.clientWidth || window.innerWidth;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (g.axis === 'x') {
      // Rubber-band at the ends.
      const atEdge = (dx > 0 && i === 0) || (dx < 0 && i === count - 1);
      setDrag({ x: atEdge ? dx * 0.3 : dx, y: 0, active: true });
    } else {
      setDrag({ x: 0, y: dy, active: true });
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    setDrag({ x: 0, y: 0, active: false });
    if (g.axis === 'x') {
      const threshold = Math.min(80, width.current * 0.2);
      if (dx < -threshold) next();
      else if (dx > threshold) prev();
    } else if (g.axis === 'y' && Math.abs(dy) > 110) {
      onClose();
    }
  };

  const fade = 1 - Math.min(0.7, Math.abs(drag.y) / 350);

  return createPortal(
    <div
      className="fixed inset-0 z-[55] flex animate-fade-in touch-none flex-col overscroll-none bg-bg"
      role="dialog"
      aria-modal="true"
      aria-label="Workout photos"
      style={{ opacity: fade }}
    >
      <div className="relative flex h-12 shrink-0 items-center justify-between px-2 pt-safe box-content">
        <IconButton label="Close" onClick={onClose}>
          <X className="h-6 w-6" />
        </IconButton>
        <div className="text-[15px] font-semibold tabular-nums" aria-live="polite">
          {count > 1 ? `${i + 1} of ${count}` : 'Photo'}
        </div>
        <div className="w-10" />
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          className="h-full touch-none overflow-hidden select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div
            className="flex h-full"
            style={{
              transform: `translate3d(calc(${-i * 100}% + ${drag.x}px), ${drag.y}px, 0)`,
              transition: drag.active ? 'none' : 'transform .3s cubic-bezier(.2,.9,.25,1)',
            }}
          >
            {urls.map((u, k) => (
              <div key={u} className="flex h-full w-full shrink-0 items-center justify-center p-3">
                <img
                  src={u}
                  alt={`Photo ${k + 1} of ${count}`}
                  draggable={false}
                  className="max-h-full max-w-full rounded-xl object-contain"
                />
              </div>
            ))}
          </div>
        </div>

        {count > 1 ? (
          <>
            <ArrowButton side="left" label="Previous photo" disabled={i === 0} onClick={prev} />
            <ArrowButton side="right" label="Next photo" disabled={i === count - 1} onClick={next} />
          </>
        ) : null}
      </div>

      <div className="flex h-14 shrink-0 items-center justify-center gap-1.5 pb-safe box-content">
        {count > 1
          ? urls.map((u, k) => (
              <button
                key={u}
                type="button"
                aria-label={`Show photo ${k + 1}`}
                onClick={() => setIndex(k)}
                className="flex h-6 w-5 items-center justify-center"
              >
                <span className={cx('block h-2 w-2 rounded-full transition-colors', k === i ? 'bg-fg' : 'bg-surface-3')} />
              </button>
            ))
          : null}
      </div>
    </div>,
    document.body,
  );
}

function ArrowButton({
  side,
  label,
  disabled,
  onClick,
}: {
  side: 'left' | 'right';
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  if (disabled) return null;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx(
        'absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface-2/80 text-fg shadow-lg backdrop-blur active:bg-surface-3',
        side === 'left' ? 'left-3' : 'right-3',
      )}
    >
      {side === 'left' ? <ChevronLeft className="h-6 w-6" /> : <ChevronRight className="h-6 w-6" />}
    </button>
  );
}
