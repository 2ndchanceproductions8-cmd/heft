import { db } from '../db';
import type { Measurement, Settings, Unit } from '../types';
import { isAppleMobile, plainSpaces } from './appleHealth';
import { getSettings } from './settings';
import { KG_PER_LB, kgToUnit, round } from './units';

/*
 * Apple Health → Heft: the latest weigh-in (weight + body fat %) from the owner's smart scale.
 *
 * A web app can't read HealthKit, and a Shortcut that opens a Heft URL would land in Safari (whose storage is
 * separate from the home-screen app), so the bridge is the clipboard: the user's "Health to Heft" Shortcut finds
 * the latest Weight and Body Fat Percentage samples and COPIES a small text block; back in Heft, "Paste from
 * Health" reads it, shows a preview and saves.
 *
 *   heft-health
 *   weight: 184.2 lb
 *   weight date: Oct 5, 2026 at 7:02 AM
 *   body fat: 18.5%
 *   body fat date: Oct 5, 2026 at 7:02 AM
 *
 * The parser is deliberately tolerant (Shortcuts' text for a Health Sample or a date varies by iOS version and
 * region): see parseHealthText. Everything here is node-testable; only applyHealthImport touches the database.
 *
 * Calories and Food targets need nothing extra: they read the newest weigh-in through lib/settings.ts
 * pickBodyweightKg (a NEWER hand-typed profile weight still wins), so an import never writes the profile.
 */

/** Must match the Shortcut's name exactly. */
export const HEALTH_IMPORT_SHORTCUT = 'Health to Heft';
/** First line of the Shortcut's text: tells Heft the clipboard holds health data. */
export const HEALTH_MARKER = 'heft-health';
/** The Shortcut's Text step, literally (the user inserts a variable after each colon). */
export const HEALTH_TEMPLATE_LINES = [HEALTH_MARKER, 'weight: ', 'weight date: ', 'body fat: ', 'body fat date: '] as const;
export const healthTemplateText = (): string => HEALTH_TEMPLATE_LINES.join('\n');

export { isAppleMobile };

/** Runs the "Health to Heft" Shortcut. Open it from a tap (iOS only follows app links from a user gesture). */
export function importShortcutUrl(): string {
  return 'shortcuts://run-shortcut?name=' + encodeURIComponent(HEALTH_IMPORT_SHORTCUT);
}

export const WEIGHT_RANGE_KG = [20, 400] as const;
export const BODY_FAT_RANGE = [1, 75] as const;
/** A body fat sample this close to a weight belongs to the same weigh-in. */
export const SAME_WEIGH_IN_MS = 10 * 60_000;
const KG_PER_STONE = 6.35029318;
/** Dates further ahead than this are rejected (a day/month mix-up, or a wrong clock). */
const FUTURE_SLACK_MS = 36 * 3_600_000;

export type HealthKind = 'weight' | 'bodyFat';

/** One Apple Health sample: weight in KG, body fat in PERCENT (18.5), `at` epoch ms. */
export interface HealthSample {
  kind: HealthKind;
  value: number;
  at: number;
}

export interface HealthParseResult {
  samples: HealthSample[];
  /** Readable reasons for values that were dropped (unreadable, out of range, bad date). */
  errors: string[];
  /** False when the text isn't Heft health data at all (no heft-health line and no weight / body fat keys). */
  recognized: boolean;
  /**
   * Kinds whose line was there but empty ("body fat: ") and that gave no sample: the Shortcut's Find Health
   * Samples step for it found nothing (wrong type, a date filter, or a second Find that filters the first's result).
   */
  missing: HealthKind[];
}

export interface HealthParseOptions {
  /** The unit for a weight written without one. */
  unit: Unit;
  /** "Now" for samples without a date (and the future-date check). Defaults to Date.now(). */
  now?: number;
}

// ------------------------------------------------------------------ text cleanup

// Zero-width and bidi marks (iOS sprinkles some into dates), and every space-like character → a plain space.
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const span = (a: number, b: number) => ch(a) + '-' + ch(b);
// (Built from char codes so the source stays plain ASCII.)
const INVISIBLE = new RegExp('[' + span(0x200b, 0x200f) + span(0x202a, 0x202e) + span(0x2060, 0x2064) + ch(0xfeff) + ']', 'g');
const ODD_SPACE = new RegExp('[' + ch(0x09, 0xa0, 0x1680) + span(0x2000, 0x200a) + ch(0x202f, 0x205f, 0x3000) + ']', 'g');
const LINE_BREAK = new RegExp(ch(0x0d) + ch(0x0a) + '?|[' + ch(0x0d, 0x2028, 0x2029) + ']', 'g');
const CURLY_DOUBLE = new RegExp('[' + ch(0x201c, 0x201d, 0x201e, 0x201f) + ']', 'g');
const CURLY_SINGLE = new RegExp('[' + ch(0x2018, 0x2019) + ']', 'g');

function clean(s: string): string {
  return plainSpaces(s)
    .replace(LINE_BREAK, '\n')
    .replace(INVISIBLE, '')
    .replace(ODD_SPACE, ' ');
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local calendar day, yyyy-MM-dd. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ------------------------------------------------------------------ numbers

const NUM = String.raw`\d+(?:[.,]\d+)*`;
const STONE_LB_RE = new RegExp(String.raw`(${NUM})\s*(?:stones?|st)\.?\s*(${NUM})\s*(?:pounds?|lbs?)(?![a-z])`, 'i');
const WEIGHT_UNIT_RE = new RegExp(String.raw`(${NUM})\s*(kilograms?|kgs?|pounds?|lbs?|stones?|st|grams?|g)(?![a-z])`, 'i');
const PERCENT_RE = new RegExp(String.raw`(${NUM})\s*%`);
const BARE_RE = new RegExp(String.raw`(${NUM})`);
// A number with a mass unit: never a body fat value ("Fat: 12 g" is a nutrition label).
const MASS_RE = new RegExp(String.raw`\d\s*(?:kilograms?|kgs?|grams?|g|pounds?|lbs?|ounces?|oz|stones?|st)(?![a-z])`, 'i');

/** "184.2", "184,2" (decimal comma), "83,500" / "1.234,5" (thousands, grams only). */
function toNumber(s: string, thousandsOk = false): number | null {
  let t = s;
  const dots = (t.match(/\./g) ?? []).length;
  const commas = (t.match(/,/g) ?? []).length;
  if (dots && commas) {
    // The last separator is the decimal one.
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (commas) {
    if (thousandsOk && /^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
    else if (commas === 1) t = t.replace(',', '.');
    else return null;
  } else if (dots > 1) {
    if (thousandsOk && /^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    else return null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** kg per one of the unit words the parser accepts; null = not a weight unit. */
function kgPerUnit(word: string): number | null {
  const w = word.trim().toLowerCase();
  if (/^(kilograms?|kgs?)$/.test(w)) return 1;
  if (/^(pounds?|lbs?)$/.test(w)) return KG_PER_LB;
  if (/^(stones?|st)$/.test(w)) return KG_PER_STONE;
  if (/^(grams?|g)$/.test(w)) return 0.001;
  return null;
}

/** A weight in kg from "184.2 lb", "83,5 kg", "13 st 2 lb", "13.1 st", "83500 g" or a bare number (in `unit`). */
export function parseWeightKg(text: string, unit: string): number | null {
  const t = text.trim();
  const sl = STONE_LB_RE.exec(t);
  if (sl) {
    const st = toNumber(sl[1]);
    const lb = toNumber(sl[2]);
    return st == null || lb == null ? null : st * KG_PER_STONE + lb * KG_PER_LB;
  }
  const wu = WEIGHT_UNIT_RE.exec(t);
  if (wu) {
    const factor = kgPerUnit(wu[2]);
    const n = toNumber(wu[1], factor === 0.001);
    return n == null || factor == null ? null : n * factor;
  }
  const bare = BARE_RE.exec(t);
  const factor = kgPerUnit(unit);
  if (!bare || factor == null) return null;
  const n = toNumber(bare[1], factor === 0.001);
  return n == null ? null : n * factor;
}

/**
 * Body fat in percent from "18.5%", "18.5" or a fraction "0.185" (a bare number ≤ 1 is read as a fraction; with a %
 * sign it never is: "1%" is one percent). null for a value with a mass unit ("12 g").
 */
export function parseBodyFatPct(text: string): number | null {
  const t = text.trim();
  if (MASS_RE.test(t)) return null;
  const pct = PERCENT_RE.exec(t);
  const m = pct ?? BARE_RE.exec(t);
  if (!m) return null;
  const n = toNumber(m[1]);
  if (n == null) return null;
  return round(!pct && n <= 1 ? n * 100 : n, 2);
}

// ------------------------------------------------------------------ dates

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** 0-11 for "Oct", "Oct.", "October", "Sept"; -1 otherwise. */
function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return -1;
  return MONTH_NAMES.findIndex((m) => m.startsWith(w));
}

/** A local date-time, or null when a field is out of range (Feb 30, 25:00…). */
function localTime(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number | null {
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const dt = new Date(y, mo, d, h, mi, s, ms);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
  return dt.getTime();
}

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : y.length === 4 ? Number(y) : NaN);

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const WEEKDAY_RE = /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;
const NAME_MDY_RE = /^([a-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b(.*)$/i;
const NAME_DMY_RE = /^(\d{1,2})(?:st|nd|rd|th)?\.?\s+([a-z]+\.?),?\s+(\d{4})\b(.*)$/i;
const NUMERIC_RE = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{2,4})\b(.*)$/;
const RELATIVE_RE = /^(today|yesterday)\b(.*)$/i;
// The time after a date: optional separator (",", "at", "@"), h:mm[:ss], optional AM/PM, then an optional zone:
// a name ("EDT" = local), a name with an offset ("GMT-4", "UTC+05:30"), a bare offset ("-0400", RFC 2822) or "Z".
const TIME_RE =
  /^(?:,|\s)*(?:at\s+|@\s*)?(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:\s*([ap])\.?\s*m\.?)?(?:\s+([a-z]{2,5})(?:\s*([+-]\d{1,2}(?::?\d{2})?))?|\s*([+-]\d{2}:?\d{2})|\s*(z))?\s*$/i;

/** "+05:30" / "-0400" / "-4" → minutes east of UTC. */
function offsetMinutes(s: string): number {
  const z = /^([+-])(\d{1,2}?)(?::?(\d{2}))?$/.exec(s)!;
  return (Number(z[2]) * 60 + Number(z[3] ?? 0)) * (z[1] === '-' ? -1 : 1);
}

/**
 * h/m/s from the text after a date ("" = midnight) and the UTC offset in minutes when the text gives one (null =
 * local time; a zone name alone like "EDT" is the phone's own zone). null when it isn't a time.
 */
function parseTimeRest(rest: string): [number, number, number, number | null] | null {
  if (!rest.replace(/[\s,]/g, '')) return [0, 0, 0, null];
  const m = TIME_RE.exec(rest);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[4].toLowerCase() === 'p' ? 12 : 0);
  }
  const [name, nameOffset, bareOffset, zulu] = [m[5], m[6], m[7], m[8]];
  let offset: number | null = null;
  if (nameOffset || bareOffset) offset = offsetMinutes(nameOffset ?? bareOffset);
  else if (zulu || (name && /^(gmt|utc|ut)$/i.test(name))) offset = 0;
  return [h, mi, s, offset];
}

/**
 * Epoch ms from the date formats Shortcuts produces, parsed explicitly (never Date.parse, whose handling of
 * these strings differs between engines):
 * - ISO 8601 with or without an offset ("2026-10-05T07:02:00-04:00", "2026-10-05 07:02"); no offset = local time
 * - "Oct 5, 2026 at 7:02 AM", "October 5, 2026, 7:02 AM", "Monday, October 5, 2026 at 7:02:15 AM EDT"
 * - "5 Oct 2026 at 07:02" (day first), and RFC 2822 "Mon, 05 Oct 2026 07:02:00 -0400"
 * - a numeric offset or "GMT-4" / "UTC" after the time is applied; a zone name alone ("EDT") means local time
 * - "10/5/26, 7:02 AM" (US month/day; day/month when the first number is over 12; "05.10.2026" day.month)
 * - "Today at 7:02 AM" / "Yesterday at 7:02 AM", and epoch seconds / milliseconds
 * U+202F / U+00A0 spaces (newer iOS puts one before AM/PM) are fine. null when unreadable.
 */
export function parseHealthDate(input: string, now: number = Date.now()): number | null {
  let s = clean(input).replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (!s) return null;
  if (/^\d{10}(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  if (/^\d{12,13}$/.test(s)) return Number(s);

  const iso = ISO_RE.exec(s);
  if (iso) {
    const [y, mo, d] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
    const [h, mi, sec] = [Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0)];
    const ms = iso[7] ? Math.round(Number('0.' + iso[7]) * 1000) : 0;
    const local = localTime(y, mo, d, h, mi, sec, ms); // also validates the fields
    if (local == null) return null;
    const zone = iso[8];
    if (!zone) return local;
    if (zone.toUpperCase() === 'Z') return Date.UTC(y, mo, d, h, mi, sec, ms);
    const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)!;
    const offsetMin = (Number(z[2]) * 60 + Number(z[3] ?? 0)) * (z[1] === '-' ? -1 : 1);
    return Date.UTC(y, mo, d, h, mi, sec, ms) - offsetMin * 60_000;
  }

  s = s.replace(WEEKDAY_RE, '');
  let y: number;
  let mo: number;
  let d: number;
  let rest: string;
  let m: RegExpExecArray | null;
  if ((m = NAME_MDY_RE.exec(s)) && monthIndex(m[1]) >= 0) {
    [mo, d, y, rest] = [monthIndex(m[1]), Number(m[2]), Number(m[3]), m[4]];
  } else if ((m = NAME_DMY_RE.exec(s)) && monthIndex(m[2]) >= 0) {
    [d, mo, y, rest] = [Number(m[1]), monthIndex(m[2]), Number(m[3]), m[4]];
  } else if ((m = NUMERIC_RE.exec(s))) {
    const [a, sep, b, c] = [m[1], m[2], Number(m[3]), m[4]];
    rest = m[5];
    if (a.length === 4) {
      if (c.length > 2) return null;
      [y, mo, d] = [Number(a), b - 1, Number(c)]; // 2026/10/05
    } else {
      if (a.length > 2) return null;
      y = fullYear(c);
      const first = Number(a);
      const dayFirst = sep === '.' || (first > 12 && b <= 12);
      [mo, d] = dayFirst ? [b - 1, first] : [first - 1, b];
    }
  } else if ((m = RELATIVE_RE.exec(s))) {
    const base = new Date(now);
    if (m[1].toLowerCase() === 'yesterday') base.setDate(base.getDate() - 1);
    [y, mo, d, rest] = [base.getFullYear(), base.getMonth(), base.getDate(), m[2]];
  } else {
    return null;
  }
  if (!Number.isFinite(y)) return null;
  const time = parseTimeRest(rest);
  if (!time) return null;
  const [h, mi, sec, offsetMin] = time;
  const local = localTime(y, mo, d, h, mi, sec); // also validates the fields
  if (local == null || offsetMin == null) return local;
  return Date.UTC(y, mo, d, h, mi, sec) - offsetMin * 60_000;
}

// ------------------------------------------------------------------ keys

type Field = 'weight' | 'weightDate' | 'bodyFat' | 'bodyFatDate' | 'date' | 'unit' | 'kind' | 'value';

const WEIGHT_KEYS = new Set(['weight', 'bodyweight', 'bodymass', 'mass', 'weighin']);
const FAT_KEYS = new Set([
  'bodyfat',
  'bodyfatpercentage',
  'bodyfatpercent',
  'bodyfatpct',
  'bodyfatperc',
  'fat',
  'fatpct',
  'fatpercent',
  'fatpercentage',
  'bf',
  'bfpct',
]);
/**
 * Keys too generic to mark text as health data by themselves ("Fat: 12 g" is a nutrition label, the kind of text
 * the Food tab's users have on the clipboard). They are still read after the heft-health line or beside a specific
 * key.
 */
const WEAK_KEYS = new Set(['fat', 'mass', 'bf']);
const GENERIC_DATE_BASES = new Set(['', 'sample', 'measured', 'start', 'end', 'record', 'recorded', 'logged']);
const DATE_SUFFIXES = ['startdate', 'datetime', 'timestamp', 'date', 'time', 'when', 'at'];

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

interface KeyClass {
  field: Field;
  /** Unit named in the key ("weight kg"). */
  unit?: string;
  /** A generic key (WEAK_KEYS): doesn't make the text recognized on its own. */
  weak?: boolean;
}

function baseField(b: string): { field: 'weight' | 'bodyFat'; unit?: string; weak?: boolean } | null {
  if (FAT_KEYS.has(b)) return { field: 'bodyFat', weak: WEAK_KEYS.has(b) };
  if (WEIGHT_KEYS.has(b)) return { field: 'weight', weak: WEAK_KEYS.has(b) };
  const u = /^(.*?)(kgs?|lbs?)$/.exec(b); // "weightKg", "weight_lb"
  if (u && WEIGHT_KEYS.has(u[1])) return { field: 'weight', unit: u[2], weak: WEAK_KEYS.has(u[1]) };
  return null;
}

/** Which field a key names: case, spaces, underscores and dashes don't matter ("Body Fat", "body_fat", "bodyFat"). */
function classifyKey(raw: string): KeyClass | null {
  const k = normKey(raw);
  if (!k) return null;
  if (k === 'unit' || k === 'units' || k === 'weightunit') return { field: 'unit' };
  if (k === 'type' || k === 'kind' || k === 'sampletype' || k === 'quantitytype') return { field: 'kind' };
  if (k === 'value' || k === 'quantity') return { field: 'value' };
  const direct = baseField(k);
  if (direct) return direct;
  for (const suf of DATE_SUFFIXES) {
    if (!k.endsWith(suf)) continue;
    const b = k.slice(0, -suf.length);
    if (GENERIC_DATE_BASES.has(b)) return { field: 'date' };
    const f = baseField(b);
    if (f) return { field: f.field === 'weight' ? 'weightDate' : 'bodyFatDate' };
  }
  return null;
}

/** "HKQuantityTypeIdentifierBodyMass", "Weight", "Body Fat Percentage" → kind. */
function classifyKind(v: unknown): HealthKind | null {
  if (typeof v !== 'string') return null;
  const k = normKey(v);
  if (k.includes('lean')) return null;
  if (k.includes('fat')) return 'bodyFat';
  if (k.includes('mass') || k.includes('weight')) return 'weight';
  return null;
}

// ------------------------------------------------------------------ collecting values

interface Val {
  text: string;
  /** Unit from the key ("weight kg: 83.5"), for a value written without one. */
  unit?: string;
}

/** Values found in one record (the whole text, or one JSON object). Lists line up by position. */
interface Collected {
  recognized: boolean;
  weight: Val[];
  weightDate: Val[];
  bodyFat: Val[];
  bodyFatDate: Val[];
  date: Val[];
  unit?: string;
  /** Kinds whose key was there with nothing after it ("body fat: "): the Shortcut found no sample of that type. */
  blank: Set<HealthKind>;
}

const emptyCollected = (): Collected => ({
  recognized: false,
  weight: [],
  weightDate: [],
  bodyFat: [],
  bodyFatDate: [],
  date: [],
  blank: new Set(),
});

const isKindField = (f: Field): f is HealthKind => f === 'weight' || f === 'bodyFat';

type ListField = 'weight' | 'weightDate' | 'bodyFat' | 'bodyFatDate' | 'date';
const isListField = (f: Field): f is ListField => f !== 'unit' && f !== 'kind' && f !== 'value';

const MARKER_LINE = /^heft[\s_-]?health\b/i;
// "weight: 184.2 lb", "Body Fat %: 18.5", "weightDate = …". The key has no digits, so a date line is never a key.
const KEY_LINE = /^([a-z][a-z _%.-]*?)\s*[:=]\s*(.*)$/i;

/** The line format: "key: value" lines; a line without a key continues the previous key's list. */
function collectLines(src: string): Collected {
  const c = emptyCollected();
  let current: ListField | null = null;
  let currentUnit: string | undefined;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) {
      current = null;
      continue;
    }
    if (MARKER_LINE.test(line)) {
      c.recognized = true;
      current = null;
      continue;
    }
    const kv = KEY_LINE.exec(line);
    const cls = kv ? classifyKey(kv[1]) : null;
    if (kv) {
      current = null;
      if (!cls) continue; // some other "key: value" line
      const value = kv[2].trim();
      if (isKindField(cls.field)) {
        if (!cls.weak) c.recognized = true;
        if (!value) c.blank.add(cls.field);
      }
      if (cls.field === 'unit') {
        if (value) c.unit = value;
        continue;
      }
      if (!isListField(cls.field)) continue;
      current = cls.field;
      currentUnit = cls.unit;
      // An empty value is skipped (not stored), so a list continued on the next lines still lines up.
      if (value) c[current].push({ text: value, unit: currentUnit });
      continue;
    }
    if (current) c[current].push({ text: line, unit: currentUnit });
  }
  return c;
}

/** JSON values → text: numbers, strings, {value, unit} objects and arrays of those. */
function jsonVals(v: unknown, unit?: string): Val[] {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap((x) => jsonVals(x, unit));
  if (typeof v === 'number') return Number.isFinite(v) ? [{ text: String(v), unit }] : [];
  if (typeof v === 'string') return v.trim() ? [{ text: v.trim(), unit }] : [];
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const inner = o.value ?? o.quantity;
    if (typeof inner === 'number' || typeof inner === 'string') {
      const u = typeof o.unit === 'string' ? o.unit : unit;
      return jsonVals(inner, u);
    }
  }
  return [];
}

/** The JSON format: an object {weight, weightDate, bodyFat, bodyFatDate}, a list of those, or {samples: [...]}. */
function collectJson(root: unknown): { records: Collected[]; recognized: boolean } {
  const records: Collected[] = [];
  let marker = false;
  const visit = (x: unknown, depth: number) => {
    if (depth > 4 || x == null || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const y of x) visit(y, depth + 1);
      return;
    }
    const c = emptyCollected();
    let kind: HealthKind | null = null;
    let value: unknown = undefined;
    for (const [key, v] of Object.entries(x as Record<string, unknown>)) {
      const k = normKey(key);
      if (k === 'hefthealth' || (typeof v === 'string' && ['app', 'format', 'source', 'type'].includes(k) && normKey(v) === 'hefthealth')) {
        marker = true;
        continue;
      }
      if (k === 'samples' || k === 'data' || k === 'items' || k === 'records') {
        visit(v, depth + 1);
        continue;
      }
      const cls = classifyKey(key);
      if (!cls) continue;
      if (cls.field === 'unit') {
        if (typeof v === 'string' && v.trim()) c.unit = v.trim();
      } else if (cls.field === 'kind') {
        kind = classifyKind(v);
      } else if (cls.field === 'value') {
        value = v;
      } else {
        const vals = jsonVals(v, cls.unit);
        if (isKindField(cls.field)) {
          if (!cls.weak) c.recognized = true;
          if (!vals.length) c.blank.add(cls.field);
        }
        c[cls.field].push(...vals);
      }
    }
    // A sample record: {type: "HKQuantityTypeIdentifierBodyMass", value: 83.5, unit: "kg", startDate: …}.
    if (kind && value !== undefined) {
      c.recognized = true;
      c[kind].push(...jsonVals(value));
    }
    // Records with only generic keys are kept too: they count when the heft-health marker is there.
    if (c.recognized || c.weight.length || c.bodyFat.length || c.blank.size) records.push(c);
  };
  visit(root, 0);
  return { records, recognized: marker || records.some((r) => r.recognized) };
}

function tryJson(src: string): unknown {
  const t = src.replace(CURLY_DOUBLE, '"').replace(CURLY_SINGLE, "'");
  if (!/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const LABEL: Record<HealthKind, string> = { weight: 'weight', bodyFat: 'body fat' };

function buildSamples(c: Collected, unit: Unit, now: number, out: HealthParseResult): void {
  const kinds: [HealthKind, Val[], Val[]][] = [
    ['weight', c.weight, c.weightDate],
    ['bodyFat', c.bodyFat, c.bodyFatDate],
  ];
  for (const [kind, values, dates] of kinds) {
    values.forEach((v, i) => {
      const what = `${LABEL[kind]} "${v.text}"`;
      const value = kind === 'weight' ? parseWeightKg(v.text, v.unit ?? c.unit ?? unit) : parseBodyFatPct(v.text);
      if (value == null) {
        out.errors.push(`Couldn't read the ${what}`);
        return;
      }
      const dateVal = dates[i] ?? c.date[i];
      const at = dateVal ? parseHealthDate(dateVal.text, now) : now;
      if (at == null) {
        out.errors.push(`Couldn't read the date "${dateVal!.text}" for the ${what}`);
        return;
      }
      if (at > now + FUTURE_SLACK_MS) {
        out.errors.push(`The ${what} is dated in the future`);
        return;
      }
      const [lo, hi] = kind === 'weight' ? WEIGHT_RANGE_KG : BODY_FAT_RANGE;
      if (value < lo || value > hi) {
        // The weight range in the user's unit, like the rest of the app ("44–882 lb").
        const range =
          kind === 'weight'
            ? `${Math.round(kgToUnit(lo, unit))}–${Math.round(kgToUnit(hi, unit))} ${unit}`
            : `${lo}–${hi}%`;
        out.errors.push(`The ${what} is outside ${range}`);
        return;
      }
      out.samples.push({ kind, value, at });
    });
  }
}

/**
 * Read the Shortcut's text (or any of the tolerated variants) into samples. Accepts:
 * - the template lines (marker + "weight: … / weight date: … / body fat: … / body fat date: …"); keys are
 *   case-insensitive with optional spaces/underscores ("bodyfat", "body_fat", "weightDate"), plus a generic "date".
 *   Generic keys ("fat", "mass", "bf") are read but don't make text recognized on their own (WEAK_KEYS)
 * - weights in lb/lbs/kg/st (also "13 st 2 lb")/g, or no unit (= opts.unit); decimal commas
 * - body fat as "18.5%", "18.5" or a fraction "0.185"
 * - dates per parseHealthDate; a missing date = now
 * - JSON {"weight", "weightDate", "bodyFat", "bodyFatDate"} (or lists / {samples: […]})
 * - lists of many samples: repeated key lines, or values continued on the lines under a key (how Shortcuts
 *   writes a list variable), paired with the dates by position
 * Out-of-range values (weight 20–400 kg, body fat 1–75 %) are dropped with an error.
 */
export function parseHealthText(text: string, opts: HealthParseOptions): HealthParseResult {
  const now = opts.now ?? Date.now();
  const out: HealthParseResult = { samples: [], errors: [], recognized: false, missing: [] };
  const src = clean(text ?? '').trim();
  if (!src) return out;
  const json = tryJson(src);
  let records: Collected[];
  if (json !== undefined) {
    const r = collectJson(json);
    out.recognized = r.recognized;
    records = r.records;
  } else {
    const c = collectLines(src);
    out.recognized = c.recognized;
    records = [c];
  }
  if (!out.recognized) return out;
  for (const c of records) buildSamples(c, opts.unit, now, out);
  // The same sample listed twice counts once.
  const seen = new Set<string>();
  out.samples = out.samples
    .filter((s) => {
      const key = `${s.kind}|${s.at}|${s.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.at - b.at);
  out.missing = (['weight', 'bodyFat'] as const).filter(
    (k) => records.some((c) => c.blank.has(k) && !c[k].length) && !out.samples.some((s) => s.kind === k),
  );
  return out;
}

// ------------------------------------------------------------------ planning

/** Why a day's samples were not imported. */
export type HealthSkipReason = 'unchanged' | 'old' | 'manual' | 'edited' | 'later';

export const HEALTH_SKIP_LABEL: Record<HealthSkipReason, string> = {
  unchanged: 'Already in Heft',
  old: 'Imported before (deleted in Heft since)',
  manual: 'You logged a weigh-in that day',
  edited: 'You edited this entry in Heft',
  later: 'Heft keeps the first weigh-in of the day',
};

export interface HealthImportPlan {
  add: Measurement[];
  update: Measurement[];
  skipped: { reason: HealthSkipReason; at: number }[];
  /**
   * The new watermark candidate: the newest sample this import writes into a row, or that an imported row already
   * holds. Samples skipped as manual / edited / later never count (nothing of theirs is in Heft), so deleting your
   * own entry later still lets the scale's reading in. null = none.
   */
  importedThrough: number | null;
}

export interface HealthPlanOptions {
  /** Ignore the watermark: bring back imported weigh-ins that were deleted in Heft. */
  reimportAll?: boolean;
}

const EXACT_MS = 1000;
const anchorOf = (m: Measurement) => m.healthAt ?? m.date;
const exactSample = (list: HealthSample[], at: number) => list.find((s) => Math.abs(s.at - at) < EXACT_MS);

/** The sample closest to `at` within one weigh-in (10 minutes). */
function nearSample(list: HealthSample[], at: number): HealthSample | undefined {
  let best: HealthSample | undefined;
  for (const s of list) {
    const d = Math.abs(s.at - at);
    if (d <= SAME_WEIGH_IN_MS && (!best || d < Math.abs(best.at - at))) best = s;
  }
  return best;
}

function differs(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return (a ?? null) !== (b ?? null);
  return Math.abs(a - b) > 1e-6;
}

/**
 * Decide what an import does, one LOCAL day at a time (one Heft row per day = that day's first weigh-in):
 * - the anchor is the day's earliest weight sample; body fat measured within 10 minutes of it rides along
 *   (else the day's earliest body fat). A day with only body fat makes a row with only bodyFatPct.
 * - new rows get the stable id "hk_<anchor ms>", source 'health', healthAt = anchor.
 * - MANUAL WINS: a day that already has a weigh-in typed in Heft (any row whose source isn't 'health' with a
 *   body weight — including an imported row the user edited) is skipped whole and counted.
 * - an existing imported row for the day is updated only when its values differ (re-importing is a no-op), and a
 *   later weigh-in the same day only fills a value that row is missing. When a time-zone change has put two
 *   imported rows on one local day, the row the samples came from is the one refreshed, and a value is filled
 *   only from the same weigh-in (never from the other row's weigh-in).
 * - deleted rows stay deleted: a sample at or before settings.healthImportedThrough never creates a row (it
 *   can still refresh the row it created) unless opts.reimportAll. A weight from the same weigh-in as the day's
 *   imported row (its body fat came in first, timed a minute later) joins that row: that row wasn't deleted.
 * - plan.importedThrough is the watermark candidate (see HealthImportPlan).
 */
export function planHealthImport(
  samples: HealthSample[],
  existing: Measurement[],
  settings: Pick<Settings, 'healthImportedThrough'>,
  opts: HealthPlanOptions = {},
): HealthImportPlan {
  const plan: HealthImportPlan = { add: [], update: [], skipped: [], importedThrough: null };
  const watermark = opts.reimportAll ? null : (settings.healthImportedThrough ?? null);
  const mark = (at: number | undefined) => {
    if (at != null) plan.importedThrough = plan.importedThrough == null ? at : Math.max(plan.importedThrough, at);
  };

  const days = new Map<string, { ws: HealthSample[]; fs: HealthSample[] }>();
  for (const s of samples) {
    if (!Number.isFinite(s.at) || !Number.isFinite(s.value)) continue;
    const key = localDayKey(s.at);
    const g = days.get(key) ?? { ws: [], fs: [] };
    (s.kind === 'weight' ? g.ws : g.fs).push(s);
    days.set(key, g);
  }
  const rowsByDay = new Map<string, Measurement[]>();
  for (const m of existing) {
    const key = localDayKey(m.date);
    rowsByDay.set(key, [...(rowsByDay.get(key) ?? []), m]);
  }
  const byId = new Map(existing.map((m) => [m.id, m]));

  for (const day of [...days.keys()].sort()) {
    const g = days.get(day)!;
    const ws = [...g.ws].sort((a, b) => a.at - b.at);
    const fs = [...g.fs].sort((a, b) => a.at - b.at);
    // The day's anchor: its earliest weight (or earliest body fat when it has no weight).
    const anchor = ws[0] ?? fs[0];
    const rows = rowsByDay.get(day) ?? [];

    // Manual wins: the user's own weigh-in that day (or their own body fat, on a body-fat-only day).
    const manual = rows.filter((m) => m.source !== 'health');
    if (manual.some((m) => m.bodyweightKg) || (!ws.length && manual.some((m) => m.bodyFatPct))) {
      plan.skipped.push({ reason: 'manual', at: anchor.at });
      continue;
    }

    const health = rows.filter((m) => m.source === 'health').sort((a, b) => anchorOf(a) - anchorOf(b));
    // Normally one imported row per local day. After a time-zone change two can share one: then refresh the row
    // these samples came from (its anchor matches one), and fill a missing value only from the same weigh-in.
    const merged = health.length > 1;
    const ex =
      health.find((m) => Math.abs(anchorOf(m) - anchor.at) < EXACT_MS) ??
      health.find((m) => exactSample(ws, anchorOf(m)) ?? exactSample(fs, anchorOf(m))) ??
      health[0];
    const exAt = ex ? anchorOf(ex) : null;
    const fill = (list: HealthSample[], at: number) => nearSample(list, at) ?? (merged ? undefined : list[0]);

    if (ex && exAt != null && (!ws.length || exAt <= ws[0].at)) {
      // The day's imported row already exists and is the day's first weigh-in: refresh it. Its own sample
      // (same time) may correct its values; a later weigh-in only fills what it's missing.
      const own = !!(exactSample(ws, exAt) ?? exactSample(fs, exAt));
      const weight = ex.bodyweightKg == null ? fill(ws, exAt) : exactSample(ws, exAt);
      const fat = ex.bodyFatPct == null ? fill(fs, exAt) : own ? nearSample(fs, exAt) : undefined;
      const next: Measurement = { ...ex };
      if (weight) next.bodyweightKg = weight.value;
      if (fat) next.bodyFatPct = fat.value;
      if (own) {
        // The row's own weigh-in: Heft already holds it.
        mark(exAt);
        mark(nearSample(fs, exAt)?.at);
      }
      if (differs(ex.bodyweightKg, next.bodyweightKg) || differs(ex.bodyFatPct, next.bodyFatPct)) {
        plan.update.push(next);
        mark(weight?.at);
        mark(fat?.at);
      } else plan.skipped.push({ reason: !own && ws.length ? 'later' : 'unchanged', at: own || !ws.length ? exAt : ws[0].at });
      continue;
    }

    // A new anchor for the day. The day's imported row from this same weigh-in was not deleted: join it.
    const sameWeighIn = health.find((m) => Math.abs(anchorOf(m) - anchor.at) <= SAME_WEIGH_IN_MS);
    if (!sameWeighIn && watermark != null && anchor.at <= watermark) {
      plan.skipped.push({ reason: 'old', at: anchor.at });
      continue;
    }
    const id = 'hk_' + anchor.at;
    const same = byId.get(id);
    if (same && same.source !== 'health') {
      plan.skipped.push({ reason: 'edited', at: anchor.at });
      continue;
    }
    const fat = fill(fs, anchor.at);
    const values = {
      date: anchor.at,
      healthAt: anchor.at,
      source: 'health' as const,
      bodyweightKg: ws[0]?.value ?? null,
      bodyFatPct: fat?.value ?? null,
    };
    // A weight joining its weigh-in's row, or an earlier weigh-in than the day's imported row (a re-import of
    // older history), takes over that row.
    const target = sameWeighIn ?? ex ?? same;
    if (target) plan.update.push({ ...target, ...values, bodyFatPct: fat ? fat.value : (target.bodyFatPct ?? null) });
    else plan.add.push({ id, photoIds: [], ...values });
    mark(anchor.at);
    mark(fat?.at);
  }
  return plan;
}

// ------------------------------------------------------------------ saving

/**
 * Save a plan in ONE transaction: the rows, plus the watermark (healthImportedThrough = the newer of the stored
 * one and plan.importedThrough, the newest sample actually brought in) and healthImportedAt = now. A plan that
 * writes nothing and moves no watermark (the "Done" of a nothing-new preview) leaves the settings alone. It never
 * writes the profile body weight: calories and Food targets already follow the newest weigh-in (lib/settings.ts
 * pickBodyweightKg).
 */
export async function applyHealthImport(plan: HealthImportPlan): Promise<{ added: number; updated: number }> {
  const rows = [...plan.add, ...plan.update];
  await db.transaction('rw', db.measurements, db.settings, async () => {
    if (rows.length) await db.measurements.bulkPut(rows);
    const cur = await getSettings();
    const prev = cur.healthImportedThrough ?? null;
    const next = plan.importedThrough;
    const through = next == null ? prev : prev == null ? next : Math.max(prev, next);
    if (!rows.length && through === prev) return;
    await db.settings.put({ ...cur, id: 'settings', healthImportedThrough: through, healthImportedAt: Date.now() });
  });
  return { added: plan.add.length, updated: plan.update.length };
}

/**
 * A user's save of a measurement. Starts from the stored row so fields the form doesn't show (source, healthAt,
 * anything newer) survive; an EDITED imported row becomes the user's own ('manual'), so an import never
 * overwrites it again.
 */
export function editedMeasurement(
  entry: Measurement | null,
  changes: Pick<Measurement, 'id' | 'date' | 'photoIds'> & Partial<Measurement>,
  edited = true,
): Measurement {
  const rec: Measurement = { ...(entry ?? {}), ...changes };
  if (edited && entry?.source === 'health') rec.source = 'manual';
  return rec;
}
