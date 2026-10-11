import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Heart, Paperclip, Trash2 } from 'lucide-react';
import type { Unit } from '../../../types';
import { IconButton, Sheet, confirm, cx, toast } from '../../../components/ui';
import { deleteMeasurement } from '../../../lib/measurements';
import { fixed1, readingText, readingWhen, weightText } from './format';
import { alsoDeleted, deleteWeighInConfirm, showsCountsMarker, WEIGH_IN_LIST_DAYS, type WeighInItem } from './weighIns';

/*
 * Today → Body → tap the big number: every reading of the last two weeks (back to the latest weigh-in when that is
 * older), newest first. Each one can be deleted here (a typo, a bad reading). A typed check-in's photos, tape measurements and note live on the same row: its line says so, and so does the
 * confirmation. "All measurements" opens the full history.
 */

const ALL_MEASUREMENTS = '/progress/measurements';

/** Confirm, delete (row + photos), toast. true when it was deleted. */
export async function deleteWeighIn(item: WeighInItem, unit: Unit): Promise<boolean> {
  if (!(await confirm(deleteWeighInConfirm(item, unit)))) return false;
  try {
    await deleteMeasurement(item.row);
  } catch {
    toast("Couldn't delete the weigh-in", 'error');
    return false;
  }
  toast('Weigh-in deleted', 'success');
  return true;
}

export interface WeighInsListProps {
  items: WeighInItem[];
  unit: Unit;
  today: string;
  /** A delete is being confirmed or written: the Delete buttons wait. */
  busy?: boolean;
  onDelete: (item: WeighInItem) => void;
}

/** Pure list (props only), tested without a DOM. */
export function WeighInsList({ items, unit, today, busy = false, onDelete }: WeighInsListProps) {
  if (!items.length) {
    return (
      <p className="py-6 text-center text-[14px] text-muted" data-state="no-weigh-ins">
        No weigh-ins in the last {WEIGH_IN_LIST_DAYS} days.
      </p>
    );
  }
  return (
    <ul className="overflow-hidden rounded-2xl bg-surface-2" data-list="weigh-ins">
      {items.map((it, i) => {
        const marker = showsCountsMarker(it);
        // A typed check-in: deleting the reading deletes its photos / tape / note too, so it mustn't look bare.
        const extra = alsoDeleted(it.row);
        return (
          <li
            key={it.id}
            className={cx('flex items-center gap-2 py-2 pr-1.5 pl-4', i > 0 && 'border-t border-line')}
            data-reading={it.id}
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2 tabular-nums">
                {it.kg != null ? <span className="shrink-0 text-[16px] font-semibold">{weightText(it.kg, unit)}</span> : null}
                {it.bodyFatPct != null ? (
                  <span className={it.kg != null ? 'truncate text-[14px] text-muted' : 'truncate text-[16px] font-semibold'}>
                    {`${fixed1(it.bodyFatPct)}% body fat`}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted tabular-nums">
                <span>{readingWhen(it.at, today)}</span>
                {it.hume ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-1.5 text-[12px] font-semibold"
                    data-tag="hume"
                  >
                    <Heart className="h-3 w-3 text-danger" fill="currentColor" aria-hidden />
                    Hume
                  </span>
                ) : null}
                {marker ? (
                  <span className="inline-flex items-center gap-1 text-[12px]" data-marker="counts">
                    <Check className="h-3 w-3" aria-hidden />
                    Counts for the day
                  </span>
                ) : null}
                {extra.length ? (
                  <span className="inline-flex min-w-0 items-center gap-1 text-[12px]" data-marker="extras">
                    <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
                    {extra.length > 1 ? `${extra[0]} + more` : extra[0]}
                  </span>
                ) : null}
              </div>
            </div>
            <IconButton label={`Delete ${readingText(it, unit)}`} tone="danger" disabled={busy} onClick={() => onDelete(it)}>
              <Trash2 className="h-[18px] w-[18px]" aria-hidden />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

/** The sheet (live: deleting goes through lib/measurements, and the list follows the database). */
export function WeighInsSheet({
  open,
  onClose,
  items,
  unit,
  today,
}: {
  open: boolean;
  onClose: () => void;
  items: WeighInItem[];
  unit: Unit;
  today: string;
}) {
  const [busy, setBusy] = useState(false);
  const onDelete = async (item: WeighInItem) => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteWeighIn(item, unit);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Weigh-ins"
      footer={
        <Link
          to={ALL_MEASUREMENTS}
          className="flex h-11 w-full items-center justify-center gap-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-accent active:bg-surface-3"
        >
          All measurements
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
      }
    >
      <div className="px-4 pb-4">
        <p className="pb-3 text-[13px] leading-snug text-muted">
          Your recent readings. One reading a day counts toward your trend: the latest one you logged that day.
        </p>
        <WeighInsList items={items} unit={unit} today={today} busy={busy} onDelete={onDelete} />
      </div>
    </Sheet>
  );
}
