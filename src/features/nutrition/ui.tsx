import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, cx, Segmented, Sheet } from '../../components/ui';
import { displayMass, massToG, massUnitFor, parseDecimal, type MassUnit } from '../../lib/units';
import { useSettings } from '../../lib/settings';
import { kcal, macroG } from '../../lib/nutrition/math';
import type { Confidence, NutrientSource } from '../../lib/nutrition/types';

/*
 * Shared presentational pieces for the Food tab (foundation-owned; feature builders import, don't edit).
 */

/** Circular progress ring. `value/max`; over max turns danger. Children render centered. */
export function Ring({
  value,
  max,
  size = 132,
  stroke = 11,
  className,
  children,
}: {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  className?: string;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = max > 0 ? Math.max(0, value / max) : 0;
  const over = max > 0 && value > max;
  const shown = Math.min(1, frac);
  return (
    <div className={cx('relative shrink-0', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-surface-3" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - shown)}
          className={cx('transition-[stroke-dashoffset] duration-500', over ? 'stroke-danger' : 'stroke-accent')}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

/** One macro line: label, "eaten / target g", and a thin bar. */
export function MacroBar({
  label,
  eaten,
  target,
  unit = 'g',
  tone = 'accent',
}: {
  label: string;
  eaten: number;
  target: number | null;
  unit?: string;
  tone?: 'accent' | 'success' | 'warn' | 'drop' | 'gold';
}) {
  const frac = target && target > 0 ? Math.min(1, eaten / target) : 0;
  const TONE = { accent: 'bg-accent', success: 'bg-success', warn: 'bg-warn', drop: 'bg-drop', gold: 'bg-gold' } as const;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium text-muted">{label}</span>
        <span className="tabular-nums">
          <span className="font-semibold text-fg">{macroG(eaten)}</span>
          {target ? <span className="text-faint"> / {Math.round(target)}{unit}</span> : <span className="text-faint">{unit}</span>}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className={cx('h-full rounded-full transition-[width] duration-500', TONE[tone])} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<NutrientSource, string> = { usda: 'USDA', off: 'Label', estimate: 'Est.', manual: 'Manual' };
const SOURCE_CLASS: Record<NutrientSource, string> = {
  usda: 'bg-success-soft text-success',
  off: 'bg-accent-soft text-accent',
  estimate: 'bg-warn-soft text-warn',
  manual: 'bg-surface-3 text-muted',
};
const SOURCE_TITLE: Record<NutrientSource, string> = {
  usda: 'Numbers from USDA FoodData Central',
  off: 'Numbers from the product label (Open Food Facts)',
  estimate: "Claude's estimate (no database match)",
  manual: 'Entered by you',
};

/** Where an item's numbers came from. */
export function SourceChip({ source, className }: { source: NutrientSource; className?: string }) {
  return (
    <span
      title={SOURCE_TITLE[source]}
      className={cx('inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-bold tracking-wide uppercase', SOURCE_CLASS[source], className)}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

const CONF_CLASS: Record<Confidence, string> = {
  high: 'bg-success-soft text-success',
  medium: 'bg-accent-soft text-accent',
  low: 'bg-warn-soft text-warn',
};

export function ConfidenceBadge({ confidence, className }: { confidence: Confidence | null; className?: string }) {
  if (!confidence) return null;
  return (
    <span className={cx('inline-flex h-6 items-center rounded-full px-2.5 text-[12px] font-semibold capitalize', CONF_CLASS[confidence], className)}>
      {confidence} confidence
    </span>
  );
}

/** "1,234" kcal with thousands separators. */
export function formatKcal(v: number): string {
  return kcal(v).toLocaleString();
}

/** Compact "P 32 · C 40 · F 12" line. */
export function MacroLine({ proteinG, carbsG, fatG, className }: { proteinG: number; carbsG: number; fatG: number; className?: string }) {
  return (
    <span className={cx('tabular-nums text-muted', className)}>
      P {macroG(proteinG)} · C {macroG(carbsG)} · F {macroG(fatG)}
    </span>
  );
}

/** The user's food-mass unit (oz for lb users, g for kg users) plus a local toggle. */
export function useMassUnit(): [MassUnit, (u: MassUnit) => void] {
  const settings = useSettings();
  const def = massUnitFor(settings.unit);
  const [mu, setMu] = useState<MassUnit>(def);
  useEffect(() => setMu(def), [def]);
  return [mu, setMu];
}

/** A mass for a text field in `mu` ('' when unknown). */
export function massText(grams: number | null | undefined, mu: MassUnit): string {
  const v = displayMass(grams ?? null, mu);
  return v == null ? '' : String(v);
}

/**
 * The typed amount re-expressed after a g/oz flip: the toggle CONVERTS what was typed (250 g → 8.8 oz), it
 * never reinterprets or replaces it. Empty / junk / zero text is left as typed.
 */
export function convertMassText(text: string, from: MassUnit, to: MassUnit): string {
  if (from === to) return text;
  const v = parseDecimal(text);
  if (v == null || !(v > 0)) return text;
  return massText(massToG(v, from), to) || text;
}

/**
 * Exact grams behind a programmatically filled field. The field shows a ROUNDED value (15 g reads "0.5" oz),
 * so while the text still equals that rounding of `exact`, the exact grams are what the user means: saving
 * logs 15 g (not 14.2) and flipping g/oz re-renders from 15 g (not from 0.5 oz → 14 g). Once the user types
 * something else, the typed value wins.
 */
export function gramsFromField(text: string, mu: MassUnit, exact: number | null): number | null {
  if (exact != null && exact > 0 && text === massText(exact, mu)) return exact;
  const v = parseDecimal(text);
  return v != null && v > 0 ? massToG(v, mu) : null;
}

/** The field's text after a g/oz flip (see gramsFromField for why `exact` matters). */
export function flipMassText(text: string, from: MassUnit, to: MassUnit, exact: number | null): string {
  if (exact != null && exact > 0 && text === massText(exact, from)) return massText(exact, to);
  return convertMassText(text, from, to);
}

/** One-tap amount chips (label serving, 100 g): 40 px tall touch targets. */
export function QuickAmounts({
  quick,
  mu,
  onPick,
}: {
  quick: { label: string; grams: number }[];
  mu: MassUnit;
  onPick: (text: string, grams: number) => void;
}) {
  if (!quick.length) return null;
  return (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
      {quick.map((q) => (
        <button
          key={q.label}
          type="button"
          onClick={() => onPick(massText(q.grams, mu), q.grams)}
          className="h-10 shrink-0 rounded-full bg-surface-2 px-3.5 text-[14px] font-medium text-fg active:bg-surface-3"
        >
          {q.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Bottom sheet that asks for a weight (g/oz toggle) — the ONE gram-entry UI for "add a food", barcode
 * products and edits. `onSave(grams)`; a `quick` list offers one-tap amounts (e.g. the label serving).
 * Opening fills in `initialGrams`; flipping g/oz while open converts whatever is typed.
 */
export function GramsSheet({
  open,
  onClose,
  title,
  subtitle,
  initialGrams,
  quick,
  saveLabel = 'Add',
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  initialGrams?: number | null;
  /** One-tap amounts in grams, e.g. [{label: '1 serving (37 g)', grams: 37}]. */
  quick?: { label: string; grams: number }[];
  saveLabel?: string;
  onSave: (grams: number) => void;
}) {
  const [mu, setMu] = useMassUnit();
  const [text, setText] = useState('');
  // Grams behind a filled-in value (initial amount or a chip); see gramsFromField.
  const exact = useRef<number | null>(null);
  const prev = useRef({ open: false, mu });
  useEffect(() => {
    const was = prev.current;
    prev.current = { open, mu };
    if (!open) return;
    // Opening: start from the initial amount. A unit flip while open (the toggle, or settings loading):
    // convert the CURRENT text, so a typed 250 g becomes 8.8 oz instead of the initial amount coming back.
    if (!was.open) {
      exact.current = initialGrams ?? null;
      setText(massText(initialGrams, mu));
    } else if (was.mu !== mu) setText((t) => flipMassText(t, was.mu, mu, exact.current));
    // initialGrams is read only at the moment the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mu]);
  const grams = gramsFromField(text, mu, exact.current);
  const save = () => {
    if (grams == null) return;
    onSave(Math.round(grams * 10) / 10);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="space-y-4 px-4 pb-4">
        {subtitle ? <div className="text-center text-[14px] text-muted">{subtitle}</div> : null}
        <div className="flex items-center gap-3">
          <input
            autoFocus
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            aria-label={`Weight in ${mu}`}
            value={text}
            placeholder="0"
            onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            className="h-14 min-w-0 flex-1 rounded-xl bg-surface-2 px-4 text-center text-[28px] font-bold tabular-nums text-fg outline-none placeholder:text-faint focus:ring-2 focus:ring-accent/60"
          />
          <Segmented
            className="w-32"
            value={mu}
            onChange={setMu}
            options={[
              { value: 'g', label: 'g' },
              { value: 'oz', label: 'oz' },
            ]}
          />
        </div>
        {quick?.length ? (
          <QuickAmounts
            quick={quick}
            mu={mu}
            onPick={(t, g) => {
              exact.current = g;
              setText(t);
            }}
          />
        ) : null}
        <Button block size="lg" disabled={grams == null} onClick={save}>
          {saveLabel}
        </Button>
      </div>
    </Sheet>
  );
}
