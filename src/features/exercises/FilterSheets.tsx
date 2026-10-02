import { useState, type Ref } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import type { Equipment, Muscle } from '../../types';
import { Sheet, cx } from '../../components/ui';
import { EQUIPMENT_FILTERS, EQUIPMENT_LABEL, MUSCLE_FILTERS, MUSCLE_LABEL } from '../../lib/exerciseMeta';

/** Rounded search input with a magnifier and a clear button. */
export function SearchField({
  value,
  onChange,
  placeholder = 'Search exercise',
  autoFocus,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-[18px] w-[18px] -translate-y-1/2 text-faint" />
      <input
        ref={inputRef}
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        }}
        className="h-10 w-full appearance-none rounded-xl bg-surface-2 pr-10 pl-9.5 text-fg outline-none placeholder:text-faint focus:ring-2 focus:ring-accent/50 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="group absolute top-1/2 right-0 flex h-10 w-10 -translate-y-1/2 items-center justify-center text-muted"
        >
          {/* Same spot and look as before (40px hit area, centred where the 32px button was). */}
          <span className="flex h-8 w-8 items-center justify-center rounded-full group-active:bg-surface-3">
            <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-faint/60 text-surface">
              <X className="h-3 w-3" strokeWidth={3} />
            </span>
          </span>
        </button>
      ) : null}
    </div>
  );
}

function FilterButton({
  label,
  active,
  onOpen,
  onClear,
}: {
  label: string;
  active: boolean;
  onOpen: () => void;
  onClear: () => void;
}) {
  return (
    <div
      className={cx(
        'flex h-10 min-w-0 flex-1 items-center rounded-xl transition-colors',
        active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-fg',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className={cx('flex h-full min-w-0 flex-1 items-center justify-center gap-1 rounded-xl text-[14px] font-semibold', active ? 'pl-3' : 'px-3')}
      >
        <span className="truncate">{label}</span>
        {!active ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : null}
      </button>
      {active ? (
        <button
          type="button"
          aria-label={`Clear ${label} filter`}
          onClick={onClear}
          className="flex h-full w-10 shrink-0 items-center justify-center rounded-r-xl active:brightness-125"
        >
          <X className="h-4 w-4" strokeWidth={2.5} />
        </button>
      ) : null}
    </div>
  );
}

/** A single-choice list in a bottom sheet (with an "All ..." option that clears). */
export function OptionSheet<T extends string>({
  open,
  onClose,
  title,
  allLabel,
  options,
  value,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  allLabel?: string;
  options: { value: T; label: string }[];
  value: T | null;
  onSelect: (v: T | null) => void;
}) {
  const rows: { value: T | null; label: string }[] = allLabel ? [{ value: null, label: allLabel }, ...options] : options;
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="px-3 pb-3">
        <div className="overflow-hidden rounded-2xl bg-surface-2">
          {rows.map((o, i) => {
            const sel = o.value === value;
            return (
              <button
                key={o.value ?? '__all'}
                type="button"
                onClick={() => {
                  onSelect(o.value);
                  onClose();
                }}
                className={cx(
                  'flex w-full items-center gap-3 px-4 py-3 text-left text-[16px] transition-colors active:bg-surface-3',
                  i > 0 && 'border-t border-line',
                  sel ? 'font-semibold text-accent' : 'text-fg',
                )}
              >
                <span className="flex-1">{o.label}</span>
                {sel ? <Check className="h-5 w-5 text-accent" strokeWidth={2.5} /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}

export const EQUIPMENT_OPTIONS = EQUIPMENT_FILTERS.map((e) => ({ value: e, label: EQUIPMENT_LABEL[e] }));
export const MUSCLE_OPTIONS = MUSCLE_FILTERS.map((m) => ({ value: m, label: MUSCLE_LABEL[m] }));

/** "All Equipment" / "All Muscles" buttons that open option sheets; the chosen option shows in the button. */
export function FilterBar({
  equipment,
  muscle,
  onEquipment,
  onMuscle,
  className,
}: {
  equipment: Equipment | null;
  muscle: Muscle | null;
  onEquipment: (e: Equipment | null) => void;
  onMuscle: (m: Muscle | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState<'equipment' | 'muscle' | null>(null);
  return (
    <>
      <div className={cx('flex gap-2', className)}>
        <FilterButton
          label={equipment ? EQUIPMENT_LABEL[equipment] : 'All Equipment'}
          active={!!equipment}
          onOpen={() => setOpen('equipment')}
          onClear={() => onEquipment(null)}
        />
        <FilterButton
          label={muscle ? MUSCLE_LABEL[muscle] : 'All Muscles'}
          active={!!muscle}
          onOpen={() => setOpen('muscle')}
          onClear={() => onMuscle(null)}
        />
      </div>
      <OptionSheet
        open={open === 'equipment'}
        onClose={() => setOpen(null)}
        title="Equipment"
        allLabel="All Equipment"
        options={EQUIPMENT_OPTIONS}
        value={equipment}
        onSelect={onEquipment}
      />
      <OptionSheet
        open={open === 'muscle'}
        onClose={() => setOpen(null)}
        title="Muscle Group"
        allLabel="All Muscles"
        options={MUSCLE_OPTIONS}
        value={muscle}
        onSelect={onMuscle}
      />
    </>
  );
}
