import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { CheckCircle2, AlertTriangle, Info, Trophy } from 'lucide-react';
import { cx } from './Button';

/*
 * Imperative dialogs usable from anywhere (no hooks needed):
 *   if (await confirm({ title: 'Discard workout?', danger: true, confirmLabel: 'Discard' })) ...
 *   const name = await prompt({ title: 'Rename exercise', initial: ex.name })   // null when cancelled
 *   toast('Workout saved', 'success')
 * <DialogHost/> and <ToastHost/> are mounted once in the app root.
 */

interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
interface PromptOpts {
  title: string;
  message?: ReactNode;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
  /** Return an error string to block submit. */
  validate?: (v: string) => string | null;
}
type Dialog =
  | { id: number; kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { id: number; kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };
let dialogId = 0;

type ToastKind = 'info' | 'success' | 'error' | 'pr';
interface ToastItem {
  id: number;
  message: ReactNode;
  kind: ToastKind;
}

const useDialogStore = create<{ queue: Dialog[]; toasts: ToastItem[] }>(() => ({ queue: [], toasts: [] }));

export function confirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) =>
    useDialogStore.setState((s) => ({ queue: [...s.queue, { id: ++dialogId, kind: 'confirm', opts, resolve }] })),
  );
}

export function prompt(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) =>
    useDialogStore.setState((s) => ({ queue: [...s.queue, { id: ++dialogId, kind: 'prompt', opts, resolve }] })),
  );
}

let toastId = 0;
export function toast(message: ReactNode, kind: ToastKind = 'info', ms = 2600) {
  const id = ++toastId;
  useDialogStore.setState((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
  setTimeout(() => useDialogStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

function shift() {
  useDialogStore.setState((s) => ({ queue: s.queue.slice(1) }));
}

export function DialogHost() {
  const current = useDialogStore((s) => s.queue[0]);
  if (!current) return null;
  return createPortal(<DialogView key={current.id} dialog={current} />, document.body);
}

function DialogView({ dialog }: { dialog: Dialog }) {
  const [value, setValue] = useState(dialog.kind === 'prompt' ? dialog.opts.initial ?? '' : '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog.kind === 'prompt') setTimeout(() => inputRef.current?.select(), 50);
  }, [dialog.kind]);

  const cancel = () => {
    if (dialog.kind === 'confirm') dialog.resolve(false);
    else dialog.resolve(null);
    shift();
  };
  const ok = () => {
    if (dialog.kind === 'confirm') {
      dialog.resolve(true);
      shift();
      return;
    }
    const err = dialog.opts.validate?.(value) ?? null;
    if (err) {
      setError(err);
      return;
    }
    dialog.resolve(value);
    shift();
  };

  const o = dialog.opts;
  const danger = dialog.kind === 'confirm' && dialog.opts.danger;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" role="alertdialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade-in bg-backdrop" onClick={cancel} />
      <form
        className="relative w-full max-w-[340px] animate-pop overflow-hidden rounded-[20px] bg-surface-2 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <div className="px-5 pt-5 pb-4 text-center">
          <div className="text-[17px] font-semibold">{o.title}</div>
          {o.message ? <div className="mt-1.5 text-[14px] leading-snug text-muted">{o.message}</div> : null}
          {dialog.kind === 'prompt' ? (
            <>
              <input
                ref={inputRef}
                autoFocus
                value={value}
                inputMode={dialog.opts.inputMode}
                placeholder={dialog.opts.placeholder}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                className="mt-4 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-fg outline-none focus:border-accent"
              />
              {error ? <div className="mt-2 text-[13px] text-danger">{error}</div> : null}
            </>
          ) : null}
        </div>
        <div className="grid grid-cols-2 border-t border-line">
          <button type="button" onClick={cancel} className="py-3.5 text-[16px] text-accent active:bg-surface-3">
            {(dialog.kind === 'confirm' && dialog.opts.cancelLabel) || 'Cancel'}
          </button>
          <button
            type="submit"
            className={cx('border-l border-line py-3.5 text-[16px] font-semibold active:bg-surface-3', danger ? 'text-danger' : 'text-accent')}
          >
            {o.confirmLabel || (dialog.kind === 'prompt' ? 'Save' : 'OK')}
          </button>
        </div>
      </form>
    </div>
  );
}

const TOAST_ICON: Record<ToastKind, ReactNode> = {
  info: <Info className="h-5 w-5 text-accent" />,
  success: <CheckCircle2 className="h-5 w-5 text-success" />,
  error: <AlertTriangle className="h-5 w-5 text-danger" />,
  pr: <Trophy className="h-5 w-5 text-gold" />,
};

export function ToastHost() {
  const toasts = useDialogStore((s) => s.toasts);
  if (!toasts.length) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex flex-col items-center gap-2 px-4 pt-safe">
      <div className="h-2" />
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex max-w-sm animate-toast items-center gap-2.5 rounded-2xl border border-line bg-surface-2/95 px-4 py-3 text-[15px] font-medium shadow-xl backdrop-blur"
        >
          {TOAST_ICON[t.kind]}
          <span>{t.message}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
