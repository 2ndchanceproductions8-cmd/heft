import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft' | 'success';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent active:brightness-90 disabled:opacity-40',
  secondary: 'bg-surface-2 text-fg active:bg-surface-3 disabled:opacity-40',
  soft: 'bg-accent-soft text-accent active:brightness-110 disabled:opacity-40',
  ghost: 'bg-transparent text-accent active:bg-surface-2 disabled:opacity-40',
  danger: 'bg-danger-soft text-danger active:brightness-110 disabled:opacity-40',
  success: 'bg-success text-white active:brightness-90 disabled:opacity-40',
};
const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm rounded-lg gap-1.5',
  md: 'h-11 px-4 text-[15px] rounded-xl gap-2',
  lg: 'h-13 px-5 text-base rounded-2xl gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block, icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex items-center justify-center font-semibold transition-[filter,background-color,opacity] select-none',
        VARIANT[variant],
        SIZE[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string; // accessible name
  tone?: 'default' | 'accent' | 'danger' | 'muted';
  size?: 'sm' | 'md';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tone = 'default', size = 'md', className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full transition-colors active:bg-surface-3 disabled:opacity-40',
        size === 'sm' ? 'h-8 w-8' : 'h-10 w-10',
        tone === 'accent' && 'text-accent',
        tone === 'danger' && 'text-danger',
        tone === 'muted' && 'text-muted',
        tone === 'default' && 'text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
