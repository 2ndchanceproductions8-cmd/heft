import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { cx } from '../../components/ui';

const OPEN_PX = 88;

interface Gesture {
  id: number;
  x0: number;
  y0: number;
  base: number;
  mode: 'pending' | 'h';
}

/**
 * Swipe a row left to reveal a red Delete action (iOS style). A long swipe deletes straight away.
 * Uses pointer events with `touch-action: pan-y`, so vertical page scrolling keeps working and only a
 * clearly horizontal drag is captured.
 */
export function SwipeToDelete({
  children,
  onDelete,
  disabled,
  className,
  contentClassName,
  label = 'Delete',
}: {
  children: ReactNode;
  onDelete: () => void;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  label?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const offsetRef = useRef(0);
  const swallowClick = useRef(false);
  const [offset, setOffsetState] = useState(0);
  const [animate, setAnimate] = useState(true);

  const setOffset = (v: number, anim: boolean) => {
    offsetRef.current = v;
    setAnimate(anim);
    setOffsetState(v);
  };

  const isOpen = offset !== 0;
  // Close when the user touches anything else.
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOffset(0, true);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [isOpen]);

  const width = () => rootRef.current?.offsetWidth ?? 320;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    gesture.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base: offsetRef.current, mode: 'pending' };
    swallowClick.current = false;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (g.mode === 'pending') {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.3) {
        g.mode = 'h';
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        const ae = document.activeElement as HTMLElement | null;
        if (ae && rootRef.current?.contains(ae)) ae.blur();
      } else {
        gesture.current = null; // vertical scroll — not ours
        return;
      }
    }
    const next = Math.min(0, g.base + dx);
    setOffset(Math.max(next, -width()), false);
  };

  const finish = (cancelled: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.mode !== 'h') {
      // A plain tap on an open row just closes it.
      if (!cancelled && offsetRef.current !== 0) {
        swallowClick.current = true;
        setOffset(0, true);
      }
      return;
    }
    swallowClick.current = true;
    const cur = -offsetRef.current;
    if (!cancelled && cur > width() * 0.55) {
      setOffset(-width(), true);
      navigator.vibrate?.(10);
      window.setTimeout(onDelete, 160);
    } else if (cur > OPEN_PX * 0.5) setOffset(-OPEN_PX, true);
    else setOffset(0, true);
  };

  return (
    <div ref={rootRef} className={cx('relative overflow-hidden', className)}>
      {isOpen ? (
        <button
          type="button"
          onClick={onDelete}
          className="absolute inset-y-0 right-0 flex items-center justify-end gap-1.5 bg-danger pr-5 text-[15px] font-semibold text-white"
          style={{ width: Math.max(OPEN_PX, -offset) }}
        >
          <Trash2 className="h-4 w-4" />
          {label}
        </button>
      ) : null}
      <div
        className={cx('relative', contentClassName)}
        style={{
          transform: offset ? `translateX(${offset}px)` : undefined,
          transition: animate ? 'transform 0.2s ease' : 'none',
          touchAction: 'pan-y',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finish(false)}
        onPointerCancel={() => finish(true)}
        onClickCapture={(e) => {
          if (swallowClick.current) {
            swallowClick.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
