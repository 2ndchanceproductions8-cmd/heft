import { format, isValid, parse } from 'date-fns';
import { dayStart, kcal, macroG } from '../../../lib/nutrition/math';
import type { Meal, MealItem, Per100g } from '../../../lib/nutrition/types';

/*
 * Pure display helpers for the capture / meal / search / scan screens (no hooks, no I/O).
 */

/** "130 kcal · P 2.7 · C 28 · F 0.3" for a per-100 g nutrient set. */
export function per100Line(p: Per100g): string {
  return `${kcal(p.kcal)} kcal · P ${macroG(p.proteinG)} · C ${macroG(p.carbsG)} · F ${macroG(p.fatG)}`;
}

/** "USDA: Rice, white, cooked" / "Label: Nutella · Ferrero", or null when the item has no database match. */
export function matchedLine(item: Pick<MealItem, 'source' | 'matchedName'>): string | null {
  if (!item.matchedName) return null;
  if (item.source === 'usda') return `USDA: ${item.matchedName}`;
  if (item.source === 'off') return `Label: ${item.matchedName}`;
  return null;
}

/** Why an item fell back to Claude's own numbers (null when the lookup was fine or not attempted). */
export function lookupNote(item: Pick<MealItem, 'lookup'>): string | null {
  switch (item.lookup) {
    case 'rate_limited':
      return "USDA busy — Claude's estimate";
    case 'no_match':
      return "No database match — Claude's estimate";
    case 'failed':
      return "USDA unreachable — Claude's estimate";
    case 'key_rejected':
      return "USDA rejected your key — Claude's estimate";
    default:
      return null;
  }
}

/** The meal's title, else its foods, else the user's description, else "Meal". */
export function mealDisplayTitle(meal: Pick<Meal, 'title' | 'items' | 'input'>): string {
  if (meal.title.trim()) return meal.title.trim();
  const names = meal.items.map((i) => i.name.trim()).filter(Boolean);
  if (names.length) {
    const joined = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
    return joined;
  }
  if (meal.input.description?.trim()) return meal.input.description.trim();
  return 'Meal';
}

const DT_FORMAT = "yyyy-MM-dd'T'HH:mm";

/** Value for an <input type="datetime-local">. */
export function toDateTimeLocal(ms: number): string {
  return format(ms, DT_FORMAT);
}

/** Parse an <input type="datetime-local"> value as LOCAL time (seconds ignored); null for empty/junk. */
export function fromDateTimeLocal(v: string): number | null {
  if (!v) return null;
  const d = parse(v.slice(0, 16), DT_FORMAT, new Date(0));
  return isValid(d) ? d.getTime() : null;
}

/**
 * The 'Eaten' field's new time: null for empty / junk, 'future' for a time after `now` (the Diary can't show
 * future days, so the meal would vanish until then).
 */
export function eatenAtFromInput(v: string, now: number): number | 'future' | null {
  const at = fromDateTimeLocal(v);
  if (at == null) return null;
  return at > now ? 'future' : at;
}

/** "Today" / "Yesterday" / "Thu, Oct 1". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  const start = dayStart(day);
  if (!Number.isFinite(start)) return day;
  const t = dayStart(today);
  if (Number.isFinite(t) && Math.round((t - start) / 864e5) === 1) return 'Yesterday';
  return format(start, 'EEE, MMM d');
}

/** One-tap amounts for a food: its label serving (when known) and 100 g. */
export function quickAmounts(servingG: number | null | undefined): { label: string; grams: number }[] {
  const out: { label: string; grams: number }[] = [];
  if (servingG && servingG > 0) out.push({ label: `1 serving (${Math.round(servingG * 10) / 10} g)`, grams: servingG });
  if (!servingG || Math.abs(servingG - 100) > 0.05) out.push({ label: '100 g', grams: 100 });
  return out;
}

/**
 * The barcode spellings a cached product might be stored under: UPC-A (12 digits) and its EAN-13 form
 * (leading 0) are the same product.
 */
export function barcodeCandidates(code: string): string[] {
  const out = [code];
  if (code.length === 12) out.push('0' + code);
  if (code.length === 13 && code.startsWith('0')) out.push(code.slice(1));
  return out;
}

/** "1 angle" / "3 angles". */
export const anglesLabel = (n: number) => `${n} angle${n === 1 ? '' : 's'}`;
