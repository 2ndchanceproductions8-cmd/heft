import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { ChevronDown, Timer } from 'lucide-react';
import { cx } from '../../components/ui';
import { restOptionLabel, restOptionsWith, restSettingLabel } from '../../lib/rest';

/**
 * Rest timer picker. A native <select> sits invisibly over the label, so phones show their own wheel /
 * list picker (fast, one-handed). null = "Default" (exercise default, else the settings default).
 */
export function RestTimerSelect({
  value,
  defaultSec,
  onChange,
  className,
}: {
  value: number | null | undefined;
  defaultSec: number;
  onChange: (sec: number | null) => void;
  className?: string;
}) {
  const options = restOptionsWith(value);
  return (
    <label
      className={cx(
        'relative inline-flex h-10 max-w-full items-center gap-1.5 rounded-lg pr-1 text-[15px] font-medium text-accent active:bg-surface-2',
        className,
      )}
    >
      <Timer className="h-[18px] w-[18px] shrink-0" aria-hidden />
      <span className="truncate">Rest Timer: {restSettingLabel(value, defaultSec)}</span>
      <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
      <select
        aria-label="Rest timer"
        value={value == null ? 'default' : String(value)}
        onChange={(e) => onChange(e.target.value === 'default' ? null : Number(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
      >
        <option value="default">{restSettingLabel(null, defaultSec)}</option>
        {options.map((s) => (
          <option key={s} value={String(s)}>
            {restOptionLabel(s)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Borderless textarea that grows with its content (exercise notes). */
export function AutoTextarea({ className, value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      {...rest}
      className={cx('block w-full resize-none overflow-hidden bg-transparent text-fg outline-none placeholder:text-faint', className)}
    />
  );
}
