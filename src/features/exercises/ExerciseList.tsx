import { useEffect, type ReactNode } from 'react';
import { Spinner } from '../../components/ui';
import { useIncremental } from './hooks';

/**
 * Renders a long list incrementally (first ~60 rows, then more as the user scrolls) so ~800 exercises
 * stay fast on a phone. `resetKey` (query/filters) snaps back to the first page.
 */
export function IncrementalList<T>({
  items,
  resetKey,
  renderItem,
  startAt,
  onCountChange,
  initial,
}: {
  items: T[];
  resetKey: string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Restore a previous rendered count (e.g. when returning to the library). */
  startAt?: number;
  onCountChange?: (count: number) => void;
  initial?: number;
}) {
  const { shown, hasMore, sentinelRef } = useIncremental(items.length, resetKey, { startAt, initial });
  useEffect(() => {
    onCountChange?.(shown);
  }, [shown, onCountChange]);
  return (
    <>
      {items.slice(0, shown).map(renderItem)}
      {hasMore ? (
        <div ref={sentinelRef} className="flex justify-center py-6" aria-label="Loading more">
          <Spinner className="h-5 w-5" />
        </div>
      ) : null}
    </>
  );
}
