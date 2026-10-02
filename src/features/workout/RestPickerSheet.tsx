import { useEffect, useState } from 'react';
import { Sheet, Toggle, cx } from '../../components/ui';
import { restOptionLabel, restOptionsWith } from '../../lib/rest';

/** Pick the rest timer for one exercise (optionally saving it as that exercise's default). */
export function RestPickerSheet({
  open,
  onClose,
  exerciseName,
  value,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  exerciseName: string;
  value: number;
  onPick: (sec: number, asDefault: boolean) => void;
}) {
  const [asDefault, setAsDefault] = useState(false);
  useEffect(() => {
    if (open) setAsDefault(false);
  }, [open]);

  const options = restOptionsWith(value);

  return (
    <Sheet open={open} onClose={onClose} title="Rest Timer">
      <div className="px-4 pb-4">
        <p className="truncate pb-3 text-center text-[14px] text-muted">{exerciseName}</p>
        <div className="grid grid-cols-4 gap-2">
          {options.map((sec) => (
            <button
              key={sec}
              type="button"
              onClick={() => {
                onPick(sec, asDefault);
                onClose();
              }}
              aria-pressed={sec === value}
              className={cx(
                'h-12 rounded-xl text-[16px] font-semibold tabular-nums transition-colors',
                sec === value ? 'bg-accent text-on-accent' : 'bg-surface-2 text-fg active:bg-surface-3',
              )}
            >
              {restOptionLabel(sec)}
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium">Use as default for this exercise</div>
            <div className="text-[13px] text-muted">Applies every time you log it</div>
          </div>
          <Toggle checked={asDefault} onChange={setAsDefault} label="Use as default for this exercise" />
        </div>
      </div>
    </Sheet>
  );
}
