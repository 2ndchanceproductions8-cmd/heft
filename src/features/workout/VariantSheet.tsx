import { useEffect, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { Sheet, Spinner, cx } from '../../components/ui';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { useExercises } from '../../lib/ExerciseProvider';
import { variantFamily } from '../../lib/exercises';
import { promptCreateVariant } from '../exercises/ExerciseActions';

/**
 * "Switch Machine / Brand Variant": the exercise plus all its gym/brand variants. Picking one swaps the
 * exercise in this workout; "New variant..." creates one (e.g. the Hammer Strength lat pulldown).
 */
export function VariantSheet({
  open,
  onClose,
  exerciseId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  exerciseId: string;
  onPick: (exerciseId: string) => void;
}) {
  const index = useExercises();
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const family = open ? variantFamily(index, exerciseId) : [];

  // Wait until the new custom exercise shows up in the index before switching to it (no "missing" flash).
  useEffect(() => {
    if (!creatingId || !index.byId.has(creatingId)) return;
    onPick(creatingId);
    setCreatingId(null);
    setBusy(false);
    onClose();
  }, [creatingId, index, onPick, onClose]);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setCreatingId(null);
    }
  }, [open]);

  // Same prompt as the library and detail page: variant of the family root, and a brand the family already
  // has is rejected (two same-named variants would split one machine's history).
  const createNew = async () => {
    const created = await promptCreateVariant(index, index.get(exerciseId));
    if (!created) return; // cancelled, or failed (the helper already showed the error toast)
    setBusy(true); // spinner until the new exercise shows up in the index
    setCreatingId(created.id); // the effect above then switches to it and closes the sheet
  };

  return (
    <Sheet open={open} onClose={onClose} title="Machine / Brand">
      <div className="px-4 pb-4">
        <p className="pb-3 text-center text-[14px] leading-snug text-muted">
          Same exercise on a different machine? Variants keep their own weights and history.
        </p>
        <div className="overflow-hidden rounded-2xl bg-surface-2">
          {family.map((ex, i) => {
            const current = ex.id === exerciseId;
            return (
              <button
                key={ex.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  onPick(ex.id);
                  onClose();
                }}
                className={cx(
                  'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors active:bg-surface-3 disabled:opacity-50',
                  i > 0 && 'border-t border-line',
                )}
              >
                <ExerciseThumb exercise={ex} size={40} />
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-[16px] font-medium', current && 'text-accent')}>{ex.name}</span>
                  <span className="block truncate text-[13px] text-muted">
                    {i === 0 ? 'Original' : ex.brand ? `Variant · ${ex.brand}` : 'Variant'}
                  </span>
                </span>
                {current ? <Check className="h-5 w-5 shrink-0 text-accent" strokeWidth={2.5} /> : null}
              </button>
            );
          })}
          <button
            type="button"
            disabled={busy}
            onClick={() => void createNew()}
            className="flex w-full items-center gap-3 border-t border-line px-3 py-3 text-left text-accent active:bg-surface-3 disabled:opacity-60"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft">
              {busy ? <Spinner className="h-5 w-5 text-accent" /> : <Plus className="h-5 w-5" strokeWidth={2.5} />}
            </span>
            <span className="text-[16px] font-semibold">New variant...</span>
          </button>
        </div>
      </div>
    </Sheet>
  );
}
