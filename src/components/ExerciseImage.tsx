import { useEffect, useState } from 'react';
import { Dumbbell } from 'lucide-react';
import type { Exercise } from '../types';
import { useExerciseImages, useMediaUrls } from '../lib/media';
import { cx } from './ui/Button';

/**
 * Small exercise thumbnail (first frame or the user's own photo). Static on purpose — lists can show
 * hundreds. Falls back to an icon when there is no picture. Only exercises with user photos open an
 * IndexedDB query; library pictures are plain URLs.
 */
export function ExerciseThumb(props: {
  exercise: Exercise | null | undefined;
  size?: number;
  className?: string;
  rounded?: 'full' | 'xl';
}) {
  return props.exercise?.photoIds.length ? <PhotoThumb {...props} /> : <ThumbImg src={props.exercise?.images[0]} {...props} />;
}

function PhotoThumb(props: { exercise: Exercise | null | undefined; size?: number; className?: string; rounded?: 'full' | 'xl' }) {
  const urls = useMediaUrls(props.exercise?.photoIds);
  return <ThumbImg src={urls[0]} {...props} />;
}

function ThumbImg({
  src,
  size = 44,
  className,
  rounded = 'full',
}: {
  src: string | undefined;
  size?: number;
  className?: string;
  rounded?: 'full' | 'xl';
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const ok = !!src && failed !== src;
  return (
    <div
      className={cx(
        'relative shrink-0 overflow-hidden bg-white',
        rounded === 'full' ? 'rounded-full' : 'rounded-xl',
        !ok && 'flex items-center justify-center bg-surface-3!',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {ok ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          className="h-full w-full object-cover"
        />
      ) : (
        <Dumbbell className="text-muted" style={{ width: size * 0.45, height: size * 0.45 }} />
      )}
    </div>
  );
}

/**
 * Large looping demo: cross-fades between the exercise's frames (start ↔ end position) like Hevy's
 * animations. User photos are shown as a swipeable/fading gallery the same way.
 *
 * Frames are cached on first view, so offline (or on a slow gym connection) some may not load: it only
 * cycles through frames that have loaded, drops frames that fail, and shows the placeholder icon when
 * none load. Failed frames are retried when the connection comes back.
 */
export function ExerciseAnimation({
  exercise,
  className,
  intervalMs = 1100,
}: {
  exercise: Exercise | null | undefined;
  className?: string;
  intervalMs?: number;
}) {
  const all = useExerciseImages(exercise);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const imgs = all.filter((s) => !failed.has(s));
  const ready = imgs.filter((s) => loaded.has(s));
  const readyKey = ready.join('|');
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setFrame(0);
    if (ready.length < 2) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % ready.length), intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the frame list's contents
  }, [readyKey, intervalMs]);

  useEffect(() => {
    if (!failed.size) return;
    const retry = () => setFailed(new Set());
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [failed]);

  if (!imgs.length) {
    return (
      <div className={cx('flex aspect-[3/2] w-full items-center justify-center bg-surface-2', className)}>
        <Dumbbell className="h-16 w-16 text-faint" />
      </div>
    );
  }
  // Until a frame has loaded, keep the first one visible (it paints as it arrives).
  const shown = ready.length ? ready[frame % ready.length] : imgs[0];
  return (
    <div className={cx('relative aspect-[3/2] w-full overflow-hidden bg-white', className)}>
      {imgs.map((src, i) => (
        <img
          key={src}
          src={src}
          alt={i === 0 ? exercise?.name : ''}
          draggable={false}
          onLoad={() => setLoaded((prev) => (prev.has(src) ? prev : new Set(prev).add(src)))}
          onError={() => setFailed((prev) => (prev.has(src) ? prev : new Set(prev).add(src)))}
          className="absolute inset-0 h-full w-full object-contain transition-opacity duration-500"
          style={{ opacity: src === shown ? 1 : 0 }}
        />
      ))}
    </div>
  );
}
