import type { Measurement, Unit } from '../../../types';
import { dailyWeighIns } from '../../../lib/today';
import { healthSampleAt } from '../../../lib/measurements';
import { dayKey, shiftDay } from '../../../lib/nutrition/math';
import { plural, readingText } from './format';

/*
 * The model behind Today's "Weigh-ins" sheet: every reading of the last two weeks, newest first, so a wrong one
 * can be deleted. When the latest weigh-in is older than that, the list reaches
 * back to its day: the card's big number opens this sheet, so it must be there to delete. Pure; the sheet is
 * WeighInsSheet.tsx.
 */

/** Days the sheet lists, today included. */
export const WEIGH_IN_LIST_DAYS = 14;

export interface WeighInItem {
  /** The stored row (deleteMeasurement needs its id, Apple Health sample and photos). */
  row: Measurement;
  id: string;
  at: number;
  day: string;
  /** Body weight in kg; null on a body-fat-only reading. */
  kg: number | null;
  bodyFatPct: number | null;
  /** Imported from Apple Health (the Hume scale, before that sync was removed) and not edited in Heft since. */
  hume: boolean;
  /** Has an Apple Health sample behind it (an old import, edited or not). */
  fromHealth: boolean;
  /** The reading the trend and Today use for its day (lib/today dailyWeighIns). */
  counts: boolean;
  /** How many readings its day has in the list (`counts` is only worth showing when there's more than one). */
  sameDayCount: number;
}

const validKg = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const validPct = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100;

/**
 * The readings (rows with a weight or body fat) of the last WEIGH_IN_LIST_DAYS days, newest first; from the latest
 * weigh-in's day instead when that is older (the card shows it however old).
 */
export function weighInList(rows: readonly Measurement[], today: string, days = WEIGH_IN_LIST_DAYS): WeighInItem[] {
  const daily = dailyWeighIns(rows);
  const picked = new Set(daily.map((w) => w.id));
  const windowStart = shiftDay(today, -(Math.max(1, Math.floor(days)) - 1));
  // The card's big number is the latest weigh-in however old; the sheet it opens must list it so it can be deleted.
  const latestDay = daily.length ? daily[daily.length - 1].day : null;
  const first = latestDay != null && latestDay < windowStart ? latestDay : windowStart;
  const listed = rows.filter(
    (m) => Number.isFinite(m.date) && dayKey(m.date) >= first && (validKg(m.bodyweightKg) || validPct(m.bodyFatPct)),
  );
  const perDay = new Map<string, number>();
  for (const m of listed) {
    const day = dayKey(m.date);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  return listed
    .map((m): WeighInItem => {
      const day = dayKey(m.date);
      return {
        row: m,
        id: m.id,
        at: m.date,
        day,
        kg: validKg(m.bodyweightKg) ? m.bodyweightKg : null,
        bodyFatPct: validPct(m.bodyFatPct) ? m.bodyFatPct : null,
        hume: m.source === 'health',
        fromHealth: healthSampleAt(m) != null,
        counts: picked.has(m.id),
        sameDayCount: perDay.get(day) ?? 1,
      };
    })
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Show the "counts for the day" marker: the day's reading, on a day with more than one. */
export const showsCountsMarker = (item: Pick<WeighInItem, 'counts' | 'sameDayCount'>): boolean =>
  item.counts && item.sameDayCount > 1;

const TAPE = [
  ['waistCm', 'waist'],
  ['chestCm', 'chest'],
  ['armCm', 'arm'],
  ['thighCm', 'thigh'],
  ['hipsCm', 'hips'],
  ['neckCm', 'neck'],
] as const;

/** "a", "a and b", "a, b and c". */
const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * What else deleting this row loses: ["2 photos", "waist measurement", "note"]. A typed check-in carries its tape
 * measurements, progress photos and note on the same row as the weight, and deleteMeasurement removes all of it.
 */
export function alsoDeleted(
  row: Pick<Measurement, 'photoIds' | 'notes' | 'waistCm' | 'chestCm' | 'armCm' | 'thighCm' | 'hipsCm' | 'neckCm'>,
): string[] {
  const out: string[] = [];
  const photos = row.photoIds?.length ?? 0;
  if (photos > 0) out.push(plural(photos, 'photo'));
  const tape = TAPE.filter(([key]) => {
    const v = row[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  }).map(([, word]) => word);
  if (tape.length) out.push(`${andList(tape)} ${tape.length === 1 ? 'measurement' : 'measurements'}`);
  if (row.notes?.trim()) out.push('note');
  return out;
}

/** The Delete confirmation for one reading (and what else goes with its row, if anything). */
export function deleteWeighInConfirm(
  item: Pick<WeighInItem, 'row' | 'at' | 'kg' | 'bodyFatPct' | 'fromHealth'>,
  unit: Unit,
): { title: string; message: string; danger: true; confirmLabel: string } {
  const what = readingText(item, unit);
  const extra = alsoDeleted(item.row);
  return {
    title: 'Delete this weigh-in?',
    message: `${what}.${extra.length ? ` Its ${andList(extra)} will be deleted too.` : ''}`,
    danger: true,
    confirmLabel: extra.length ? 'Delete all' : 'Delete',
  };
}
