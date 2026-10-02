import { useEffect, useRef, useState } from 'react';
import { clockDigits, digitsToSeconds, formatClock, formatClockDigits, parseDecimal, round } from '../../lib/units';
import { cx } from './Button';

/*
 * Compact numeric inputs for set rows (weight / reps / distance / time). They keep the raw text while
 * focused (so "62." can be typed) and report parsed numbers on every keystroke. Values are in DISPLAY
 * units — callers convert to kg/meters with lib/units.ts.
 */

const cellClass =
  'h-9 w-full min-w-0 rounded-lg bg-surface-2 px-1 text-center text-[16px] font-semibold tabular-nums text-fg outline-none placeholder:font-semibold placeholder:text-faint focus:bg-surface-3 focus:ring-2 focus:ring-accent/60';

export function NumberCell({
  value,
  onChange,
  placeholder,
  integer,
  className,
  ariaLabel,
  done,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  placeholder?: string;
  /** Reps etc. — numeric keypad without a decimal point. */
  integer?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Completed set styling (transparent background). */
  done?: boolean;
}) {
  const fmt = (v: number | null | undefined) => (v == null ? '' : String(round(v, 2)));
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);

  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      enterKeyHint="done"
      aria-label={ariaLabel}
      value={text}
      placeholder={placeholder}
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        setText(fmt(value));
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      onChange={(e) => {
        let t = e.target.value.replace(/[^\d.,]/g, '');
        if (integer) t = t.replace(/[.,]/g, '');
        setText(t);
        const n = parseDecimal(t);
        onChange(n == null ? null : integer ? Math.round(n) : n);
      }}
      className={cx(cellClass, done && 'bg-transparent', className)}
    />
  );
}

/**
 * Time input. Type digits; they fill m:ss from the right like a timer ("130" -> 1:30, "2500" -> 25:00,
 * "13000" -> 1:30:00), because the iPhone number pad has no ':' key. The text is shown as m:ss while
 * typing and normalised on blur ("0:90" -> 1:30). Value in seconds.
 */
export function DurationCell({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
  done,
}: {
  value: number | null | undefined;
  onChange: (sec: number | null) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  done?: boolean;
}) {
  const fmt = (v: number | null | undefined) => (v == null ? '' : formatClock(v));
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      enterKeyHint="done"
      aria-label={ariaLabel}
      value={text}
      placeholder={placeholder}
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        setText(fmt(value));
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      onChange={(e) => {
        const d = clockDigits(e.target.value);
        setText(formatClockDigits(d));
        onChange(digitsToSeconds(d));
      }}
      className={cx(cellClass, done && 'bg-transparent', className)}
    />
  );
}
