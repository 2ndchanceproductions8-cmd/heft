import { useEffect, useState } from 'react';
import { Button, Field, Sheet, TextField, toast } from '../../../components/ui';
import { parseDecimal } from '../../../lib/units';
import { emptyTotals } from '../../../lib/nutrition/math';
import { newItemId, type NewMeal } from '../../../lib/nutrition/store';

export interface QuickAddValues {
  name: string;
  kcal: number;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

export const QUICK_KCAL_MAX = 10000;
export const QUICK_MACRO_MAX = 1000;

/**
 * A quick-add meal: one fixed item (no grams, no per-100 g — the numbers are the serving), entered by hand,
 * so it is 'done' immediately and counts toward the day.
 */
export function buildQuickAdd(v: QuickAddValues, at: number): NewMeal {
  const name = v.name.trim() || 'Quick add';
  return {
    input: { kind: 'quick' },
    status: 'done',
    at,
    title: name,
    items: [
      {
        id: newItemId(),
        name,
        portion: '',
        grams: null,
        baselineGrams: null,
        per100g: null,
        fixed: { ...emptyTotals(), kcal: v.kcal, proteinG: v.proteinG ?? 0, carbsG: v.carbsG ?? 0, fatG: v.fatG ?? 0 },
        source: 'manual',
      },
    ],
  };
}

/** Parse the form. kcal is required (1–10,000); macros are optional (blank = 0, else 0–1,000 g). */
export function parseQuickAdd(f: { name: string; kcal: string; protein: string; carbs: string; fat: string }):
  | { ok: true; values: QuickAddValues }
  | { ok: false; error: string | null } {
  const kcal = parseDecimal(f.kcal);
  if (f.kcal.trim() === '') return { ok: false, error: null };
  if (kcal == null || kcal <= 0 || kcal > QUICK_KCAL_MAX) return { ok: false, error: `Calories must be between 1 and ${QUICK_KCAL_MAX.toLocaleString()}.` };
  const macro = (label: string, t: string): number | null | string => {
    if (!t.trim()) return null;
    const n = parseDecimal(t);
    return n == null || n < 0 || n > QUICK_MACRO_MAX ? `${label} must be between 0 and ${QUICK_MACRO_MAX.toLocaleString()} g.` : n;
  };
  const p = macro('Protein', f.protein);
  const c = macro('Carbs', f.carbs);
  const fat = macro('Fat', f.fat);
  for (const m of [p, c, fat]) if (typeof m === 'string') return { ok: false, error: m };
  return {
    ok: true,
    values: { name: f.name, kcal, proteinG: p as number | null, carbsG: c as number | null, fatG: fat as number | null },
  };
}

const EMPTY = { name: '', kcal: '', protein: '', carbs: '', fat: '' };
const numeric = (v: string) => v.replace(/[^\d.,]/g, '');

/** Bottom sheet for "Quick add": name optional, calories required, protein/carbs/fat optional. */
export function QuickAddSheet({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  /** Persist the entry; the sheet closes when it resolves. */
  onSave: (values: QuickAddValues) => Promise<void>;
}) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setForm(EMPTY);
      setSaving(false);
    }
  }, [open]);

  const parsed = parseQuickAdd(form);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: k === 'name' ? e.target.value : numeric(e.target.value) }));

  const save = async () => {
    if (!parsed.ok || saving) return;
    setSaving(true);
    try {
      await onSave(parsed.values);
      onClose();
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message || 'unknown error'}`, 'error');
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Quick add">
      <form
        className="space-y-4 px-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name (optional)">
          <TextField value={form.name} onChange={set('name')} placeholder="e.g. Protein bar" enterKeyHint="next" maxLength={80} />
        </Field>
        <Field label="Calories (kcal)">
          <TextField
            value={form.kcal}
            onChange={set('kcal')}
            inputMode="decimal"
            enterKeyHint="next"
            placeholder="Required"
            className="tabular-nums"
            aria-invalid={!parsed.ok && !!parsed.error}
          />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Protein (g)">
            <TextField value={form.protein} onChange={set('protein')} inputMode="decimal" placeholder="0" className="tabular-nums" />
          </Field>
          <Field label="Carbs (g)">
            <TextField value={form.carbs} onChange={set('carbs')} inputMode="decimal" placeholder="0" className="tabular-nums" />
          </Field>
          <Field label="Fat (g)">
            <TextField value={form.fat} onChange={set('fat')} inputMode="decimal" placeholder="0" className="tabular-nums" />
          </Field>
        </div>
        {!parsed.ok && parsed.error ? <p className="text-[13px] text-danger">{parsed.error}</p> : null}
        <Button type="submit" block size="lg" disabled={!parsed.ok || saving}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
      </form>
    </Sheet>
  );
}
