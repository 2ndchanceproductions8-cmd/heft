import type { DistanceUnit, Unit } from '../types';

export const KG_PER_LB = 0.45359237;
export const M_PER_MI = 1609.344;

/** Round to at most `dp` decimals and strip float noise (e.g. 99.99999999 -> 100). */
export function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

// ---------- weight ----------
export function kgToUnit(kg: number, unit: Unit): number {
  return unit === 'kg' ? kg : kg / KG_PER_LB;
}
export function unitToKg(value: number, unit: Unit): number {
  return unit === 'kg' ? value : value * KG_PER_LB;
}
/** Weight in the display unit, rounded for display/editing (2 dp). */
export function displayWeight(kg: number | null | undefined, unit: Unit): number | null {
  if (kg == null || Number.isNaN(kg)) return null;
  return round(kgToUnit(kg, unit), 2);
}
export function formatNumber(n: number, dp = 2): string {
  return round(n, dp).toLocaleString(undefined, { maximumFractionDigits: dp });
}
/** "60 kg" / "132.5 lb" */
export function formatWeight(kg: number | null | undefined, unit: Unit, withUnit = true): string {
  const v = displayWeight(kg, unit);
  if (v == null) return '-';
  return withUnit ? `${formatNumber(v)} ${unit}` : formatNumber(v);
}
/** Total volume: no decimals, thousands separators. "12,345 kg" */
export function formatVolume(kg: number, unit: Unit, withUnit = true): string {
  const v = Math.round(kgToUnit(kg, unit));
  return withUnit ? `${v.toLocaleString()} ${unit}` : v.toLocaleString();
}

// ---------- distance ----------
export function metersToUnit(m: number, unit: DistanceUnit): number {
  return unit === 'km' ? m / 1000 : m / M_PER_MI;
}
export function unitToMeters(value: number, unit: DistanceUnit): number {
  return unit === 'km' ? value * 1000 : value * M_PER_MI;
}
export function displayDistance(m: number | null | undefined, unit: DistanceUnit): number | null {
  if (m == null || Number.isNaN(m)) return null;
  return round(metersToUnit(m, unit), 2);
}
export function formatDistance(m: number | null | undefined, unit: DistanceUnit, withUnit = true): string {
  const v = displayDistance(m, unit);
  if (v == null) return '-';
  return withUnit ? `${formatNumber(v)} ${unit}` : formatNumber(v);
}

// ---------- time ----------
/** 3725 -> "1h 2min", 95 -> "1min 35s", 40 -> "40s" */
export function formatDuration(totalSec: number | null | undefined): string {
  if (totalSec == null || totalSec < 0) return '-';
  const s = Math.round(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return sec && m < 10 ? `${m}min ${sec}s` : `${m}min`;
  return `${sec}s`;
}
/** Clock style: 65 -> "1:05", 3725 -> "1:02:05" */
export function formatClock(totalSec: number | null | undefined): string {
  if (totalSec == null || totalSec < 0 || Number.isNaN(totalSec)) return '0:00';
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
/** "1:30" -> 90, "90" -> 90, "1:02:03" -> 3723. Returns null when unparseable. */
export function parseClock(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const parts = t.split(':').map((p) => p.trim());
  if (parts.some((p) => !/^\d+$/.test(p)) || parts.length > 3) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

// Time cells in set rows (DurationCell). Phone number pads have no ':' key, so typed digits fill h:mm:ss
// from the right like a microwave or Hevy/Strong: "45" -> 0:45, "130" -> 1:30, "2500" -> 25:00,
// "13000" -> 1:30:00. parseClock keeps reading bare digits as seconds for free-text prompts.

/** The digits of a time-cell entry: non-digits (including ':' '.' ',') dropped, leading zeros stripped,
 *  at most 6 (hh mm ss). Existing values round-trip: "1:02:05" -> "10205". */
export function clockDigits(input: string): string {
  return input.replace(/\D/g, '').replace(/^0+/, '').slice(0, 6);
}
/** Right-aligned digits -> seconds. "130" -> 90, "190" -> 150 (shown as 2:30 once formatted). '' -> null. */
export function digitsToSeconds(d: string): number | null {
  if (!d) return null;
  const p = d.padStart(6, '0');
  return Number(p.slice(0, 2)) * 3600 + Number(p.slice(2, 4)) * 60 + Number(p.slice(4, 6));
}
/** Live text while typing: "5" -> "0:05", "130" -> "1:30", "12345" -> "1:23:45". Seconds are shown as
 *  typed ("0:90"); formatClock normalises them on blur. */
export function formatClockDigits(d: string): string {
  if (!d) return '';
  const p = d.padStart(3, '0');
  const ss = p.slice(-2);
  const rest = p.slice(0, -2);
  if (rest.length <= 2) return `${Number(rest)}:${ss}`;
  return `${Number(rest.slice(0, -2))}:${rest.slice(-2)}:${ss}`;
}
/** Seconds for whatever was typed into a time cell (right-aligned digits). */
export function parseTimeEntry(input: string): number | null {
  return digitsToSeconds(clockDigits(input));
}

/** Parse a user-typed decimal ("62,5" or "62.5"). Empty -> null. */
export function parseDecimal(input: string): number | null {
  const t = input.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---------- short distances (carries, sleds) ----------
// Weight & Distance exercises (farmer's walk, sled push) cover tens of meters, which reads badly as
// "0.02 mi". They use meters (km users) or yards (mi users) for input and display instead.
export type AnyDistanceUnit = DistanceUnit | 'm' | 'yd';
export const M_PER_YD = 0.9144;

/** The distance unit an exercise type uses: m/yd for weight_distance, km/mi otherwise. */
export function distanceUnitForType(type: string, unit: DistanceUnit): AnyDistanceUnit {
  if (type !== 'weight_distance') return unit;
  return unit === 'km' ? 'm' : 'yd';
}
export function metersToAny(m: number, unit: AnyDistanceUnit): number {
  switch (unit) {
    case 'm':
      return m;
    case 'yd':
      return m / M_PER_YD;
    default:
      return metersToUnit(m, unit);
  }
}
export function anyToMeters(value: number, unit: AnyDistanceUnit): number {
  switch (unit) {
    case 'm':
      return value;
    case 'yd':
      return value * M_PER_YD;
    default:
      return unitToMeters(value, unit);
  }
}
/** Distance in any unit, rounded for display: m / yd to 1 decimal ("40", "40.5"), km / mi to 2. */
export function displayDistanceAny(m: number | null | undefined, unit: AnyDistanceUnit): number | null {
  if (m == null || Number.isNaN(m)) return null;
  return round(metersToAny(m, unit), unit === 'm' || unit === 'yd' ? 1 : 2);
}
/** Format a distance for an exercise type: "1.2 mi" for runs, "40 yd" for a farmer's walk. */
export function formatDistanceForType(
  m: number | null | undefined,
  type: string,
  unit: DistanceUnit,
  withUnit = true,
): string {
  const u = distanceUnitForType(type, unit);
  const v = displayDistanceAny(m, u);
  if (v == null) return '-';
  return withUnit ? `${formatNumber(v)} ${u}` : formatNumber(v);
}

// ---------- food mass (Food tab) ----------
// Food is stored in GRAMS (nutrition databases are per 100 g). lb users see ounces, kg users see grams.
export const G_PER_OZ = 28.349523125;
export type MassUnit = 'g' | 'oz';
/** The food-mass unit for a weight unit: lb → oz, kg → g. */
export const massUnitFor = (unit: Unit): MassUnit => (unit === 'lb' ? 'oz' : 'g');
export const gToOz = (g: number) => g / G_PER_OZ;
export const ozToG = (oz: number) => oz * G_PER_OZ;
/** Grams in a mass unit, rounded for display/editing: whole grams, ounces to 0.1. */
export function displayMass(g: number | null | undefined, mu: MassUnit): number | null {
  if (g == null || Number.isNaN(g)) return null;
  return mu === 'g' ? Math.round(g) : round(gToOz(g), 1);
}
/** A typed value in a mass unit back to grams. */
export const massToG = (value: number, mu: MassUnit) => (mu === 'g' ? value : ozToG(value));
/** "150 g" / "5.3 oz" */
export function formatGrams(g: number | null | undefined, mu: MassUnit): string {
  const v = displayMass(g, mu);
  if (v == null) return '-';
  return `${formatNumber(v, 1)} ${mu}`;
}
