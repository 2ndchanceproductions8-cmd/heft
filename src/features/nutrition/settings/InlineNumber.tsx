import { useEffect, useRef, useState } from 'react';
import { cx, toast } from '../../../components/ui';
import { parseDecimal, round } from '../../../lib/units';

const INPUT =
  'h-10 rounded-lg border border-line bg-surface-2 px-2.5 text-right text-[16px] text-fg tabular-nums outline-none placeholder:text-faint focus:border-accent';

const digits = (v: string) => v.replace(/[^\d.,]/g, '');

/**
 * A small numeric input for a settings row. Commits on blur / Enter (not per keystroke); an out-of-range value
 * shows an error toast and reverts. While it has focus the typed text wins over live-query updates.
 */
export function InlineNumber({
  value,
  onCommit,
  label,
  min,
  max,
  integer,
  allowEmpty,
  placeholder,
  suffix,
  className,
}: {
  value: number | null;
  onCommit: (v: number | null) => void | Promise<void>;
  /** Accessible name, also used in the error message. */
  label: string;
  min: number;
  max: number;
  integer?: boolean;
  /** Blank commits null (e.g. "use automatic"). Otherwise blank reverts. */
  allowEmpty?: boolean;
  placeholder?: string;
  suffix?: string;
  /** Width class for the input (default w-20). */
  className?: string;
}) {
  const shown = value == null ? '' : String(value);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);

  const failed = (e: unknown) => {
    toast(`Couldn't save: ${(e as Error)?.message || 'unknown error'}`, 'error');
    setText(shown);
  };
  const commit = () => {
    focused.current = false;
    const t = text.trim();
    if (t === shown) return;
    if (!t) {
      if (allowEmpty) void Promise.resolve(onCommit(null)).catch(failed);
      else setText(shown);
      return;
    }
    const n = parseDecimal(t);
    if (n == null || n < min || n > max || (integer && !Number.isInteger(n))) {
      toast(`${label}: enter ${integer ? 'a whole number' : 'a number'} from ${min.toLocaleString()} to ${max.toLocaleString()}`, 'error');
      setText(shown);
      return;
    }
    if (value != null && n === value) {
      setText(shown);
      return;
    }
    void Promise.resolve(onCommit(n)).catch(failed);
  };

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <input
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        enterKeyHint="done"
        autoComplete="off"
        aria-label={label}
        value={text}
        placeholder={placeholder}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setText(digits(e.target.value))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className={cx(INPUT, className ?? 'w-20')}
      />
      {suffix ? <span className="text-[14px] text-muted">{suffix}</span> : null}
    </span>
  );
}

export const CM_PER_IN = 2.54;

/** Whole inches → feet + inches. */
export function splitInches(totalIn: number): { ft: number; inch: number } {
  const t = Math.round(totalIn);
  return { ft: Math.floor(t / 12), inch: t % 12 };
}

/**
 * Height as two boxes (ft, in) for lb users. Commits when either box loses focus and feet are filled in
 * (blank inches = 0); typing only inches waits for feet instead of erroring.
 */
export function HeightFtIn({ cm, onCommit }: { cm: number | null; onCommit: (cm: number) => void | Promise<void> }) {
  const total = cm ? Math.round(cm / CM_PER_IN) : null;
  const parts = total == null ? null : splitInches(total);
  const shownFt = parts ? String(parts.ft) : '';
  const shownIn = parts ? String(parts.inch) : '';
  const [ft, setFt] = useState(shownFt);
  const [inch, setInch] = useState(shownIn);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setFt(shownFt);
      setInch(shownIn);
    }
  }, [shownFt, shownIn]);

  const revert = () => {
    setFt(shownFt);
    setInch(shownIn);
  };
  const commit = () => {
    focused.current = false;
    if (!ft.trim()) {
      // No feet yet: a first-time entry waits for them; clearing a saved height isn't supported, so revert.
      if (total != null) revert();
      return;
    }
    const f = parseDecimal(ft);
    const i = inch.trim() ? parseDecimal(inch) : 0;
    if (f == null || !Number.isInteger(f) || f < 3 || f > 8 || i == null || i < 0 || i >= 12) {
      toast('Height: feet from 3 to 8, inches from 0 to 11', 'error');
      revert();
      return;
    }
    const newTotal = f * 12 + i;
    if (total != null && Math.abs(newTotal - total) < 0.01) return;
    void Promise.resolve(onCommit(round(newTotal * CM_PER_IN, 1))).catch((e: unknown) => {
      toast(`Couldn't save: ${(e as Error)?.message || 'unknown error'}`, 'error');
      revert();
    });
  };
  const box = (v: string, set: (s: string) => void, label: string, unit: string) => (
    <span className="flex items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        enterKeyHint="done"
        autoComplete="off"
        aria-label={label}
        value={v}
        onFocus={() => (focused.current = true)}
        onChange={(e) => set(digits(e.target.value))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className={cx(INPUT, 'w-12')}
      />
      <span className="text-[14px] text-muted">{unit}</span>
    </span>
  );
  return (
    <span className="flex shrink-0 items-center gap-2">
      {box(ft, setFt, 'Height, feet', 'ft')}
      {box(inch, setInch, 'Height, inches', 'in')}
    </span>
  );
}
