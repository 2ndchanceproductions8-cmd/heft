import { useEffect, useRef, useState } from 'react';
import { Ellipsis, RotateCcw } from 'lucide-react';
import { IconButton } from '../../../components/ui';
import { itemNutrients } from '../../../lib/nutrition/math';
import type { MealItem } from '../../../lib/nutrition/types';
import { displayMass, formatGrams, massToG, parseDecimal, type MassUnit } from '../../../lib/units';
import { formatKcal, MacroLine, SourceChip } from '../ui';
import { lookupNote, matchedLine } from './format';

/** True when the user changed an item's weight away from what Claude / the label said. */
export function gramsEdited(item: Pick<MealItem, 'grams' | 'baselineGrams' | 'fixed'>): boolean {
  return !item.fixed && item.grams != null && item.baselineGrams != null && Math.abs(item.grams - item.baselineGrams) >= 0.05;
}

export interface ItemRowProps {
  item: MealItem;
  serves: number;
  mu: MassUnit;
  onRename: () => void;
  /** New grams PER SERVING. */
  onGrams: (grams: number) => void;
  onResetGrams: () => void;
  onMenu: () => void;
}

/**
 * One food in a meal. Shows the item's OWN name (a database match only ever appears on the "USDA: …" line),
 * where its numbers came from, why Claude's estimate was used, and an inline weight editor.
 */
export function ItemRow({ item, serves, mu, onRename, onGrams, onResetGrams, onMenu }: ItemRowProps) {
  const n = itemNutrients(item, serves);
  const matched = matchedLine(item);
  const note = lookupNote(item);
  const edited = gramsEdited(item);
  const name = item.name.trim() || 'Unnamed food';
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onRename} className="flex min-h-10 max-w-full items-center gap-2 text-left active:opacity-60">
            <span className="truncate text-[16px] font-semibold text-fg">{name}</span>
            <SourceChip source={item.source} className="shrink-0" />
          </button>
          {matched ? <div className="-mt-1 truncate text-[13px] text-muted">{matched}</div> : null}
          {note ? <div className="text-[13px] text-warn">{note}</div> : null}
        </div>
        <div className="flex min-h-10 flex-col items-end justify-center pl-1">
          <span className="text-[16px] leading-tight font-semibold tabular-nums">{formatKcal(n.kcal)}</span>
          <span className="text-[11px] text-faint">kcal</span>
        </div>
        <IconButton label={`Options for ${name}`} tone="muted" onClick={onMenu}>
          <Ellipsis className="h-5 w-5" />
        </IconButton>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {item.fixed ? (
          <span className="inline-flex h-10 items-center rounded-lg bg-surface-2 px-3 text-[14px] font-medium text-muted">Quick add</span>
        ) : (
          <GramsInput grams={item.grams} mu={mu} label={`Weight of ${name} in ${mu}`} onCommit={onGrams} />
        )}
        {serves > 1 && !item.fixed ? <span className="text-[13px] text-faint tabular-nums">× {serves}</span> : null}
        {edited ? (
          <button
            type="button"
            onClick={onResetGrams}
            aria-label={`Reset weight to ${formatGrams(item.baselineGrams, mu)}`}
            className="inline-flex h-10 items-center gap-1 rounded-lg px-1.5 text-[13px] text-muted active:opacity-60"
          >
            <span className="tabular-nums">was {formatGrams(item.baselineGrams, mu)}</span>
            <RotateCcw className="h-3.5 w-3.5 text-accent" />
            <span className="font-medium text-accent">Reset</span>
          </button>
        ) : null}
        <MacroLine proteinG={n.proteinG} carbsG={n.carbsG} fatG={n.fatG} className="ml-auto text-[13px]" />
      </div>
      {item.portion ? <div className="mt-1 text-[12px] text-faint">Portion: {item.portion}</div> : null}
    </div>
  );
}

/**
 * Weight field in the user's mass unit. Keeps the raw text while focused; commits on blur / Enter. An
 * untouched value never commits (re-converting 5.3 oz would otherwise nudge 150 g to 150.3 g).
 */
export function GramsInput({
  grams,
  mu,
  label,
  onCommit,
}: {
  grams: number | null;
  mu: MassUnit;
  label: string;
  onCommit: (grams: number) => void;
}) {
  const fmt = (g: number | null) => {
    const v = displayMass(g, mu);
    return v == null ? '' : String(v);
  };
  const [text, setText] = useState(() => fmt(grams));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(grams));
    // fmt only depends on mu, which is in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grams, mu]);

  const commit = () => {
    const t = text.trim().replace(',', '.');
    if (t === fmt(grams)) return;
    const v = parseDecimal(t);
    if (v == null || v <= 0) {
      setText(fmt(grams));
      return;
    }
    onCommit(Math.round(massToG(v, mu) * 10) / 10);
  };

  return (
    <label className="inline-flex h-10 items-center gap-1 rounded-lg bg-surface-2 pr-3 focus-within:ring-2 focus-within:ring-accent/60">
      <input
        type="text"
        inputMode="decimal"
        enterKeyHint="done"
        aria-label={label}
        value={text}
        placeholder="0"
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ''))}
        className="h-10 w-16 min-w-0 bg-transparent pl-3 text-right text-[16px] font-semibold tabular-nums text-fg outline-none placeholder:text-faint"
      />
      <span className="text-[14px] text-muted">{mu}</span>
    </label>
  );
}
