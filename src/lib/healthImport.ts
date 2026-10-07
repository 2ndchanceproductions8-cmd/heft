import { db } from '../db';
import type { Measurement, Settings, Unit } from '../types';
import { isAppleMobile, plainSpaces } from './appleHealth';
import { getSettings } from './settings';
import { KG_PER_LB, kgToUnit, round } from './units';

/*
 * Apple Health → Heft: every weigh-in (weight + body fat %) from the owner's smart scale (a Hume Body Pod, which
 * writes only those two types to Apple Health).
 *
 * A web app can't read HealthKit, and a Shortcut that opens a Heft URL would land in Safari (whose storage is
 * separate from the home-screen app), so the user's "Health to Heft" Shortcut finds the last 30 days of Weight and
 * Body Fat Percentage samples and writes them as a small text block, which reaches Heft two ways:
 * - automatically: an iOS automation runs the Shortcut whenever the Hume app closes, and it posts the text to Heft's
 *   private GitHub inbox, which lib/healthInbox.ts reads;
 * - by hand: run from Heft (importShortcutUrl), the Shortcut also copies the text, and "Paste from Health" reads the
 *   clipboard, shows a preview, saves.
 *
 *   heft-health
 *   weight: 184.2 lb
 *   183.9 lb
 *   weight date: 2026-10-06T07:02:11-07:00
 *   2026-10-05T07:01:03-07:00
 *   body fat: 19.4%
 *   19.6%
 *   body fat date: 2026-10-06T07:02:11-07:00
 *   2026-10-05T07:01:03-07:00
 *
 * (A list variable puts one value per line under its key; values pair with their dates by position.)
 *
 * Every weigh-in becomes its own Measurements row (planHealthImport), so sending the same 30 days again changes
 * nothing; a weigh-in deleted in Heft never comes back (deleteMeasurement remembers it in Settings.healthDeleted).
 * The parser is deliberately tolerant (Shortcuts' text for a Health Sample or a date varies by iOS version and
 * region): see parseHealthText. Everything here is node-testable; only applyHealthImport and deleteMeasurement touch
 * the database.
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

/** The input Heft passes when IT runs the Shortcut (Get from Health): the Shortcut copies to the clipboard only then. */
export const HEALTH_PASTE_INPUT = 'paste';

/**
 * Runs the "Health to Heft" Shortcut with HEALTH_PASTE_INPUT as its input, so its "If Shortcut Input is paste" step
 * copies the text for Paste from Health (the Hume-closed automation runs it with no input and leaves the clipboard
 * alone; a Shortcut without that If ignores the input). Open it from a tap (iOS only follows app links from a user
 * gesture).
 */
export function importShortcutUrl(): string {
  return (
    'shortcuts://run-shortcut?name=' + encodeURIComponent(HEALTH_IMPORT_SHORTCUT) + '&input=text&text=' + HEALTH_PASTE_INPUT
  );
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
  /** Readable reasons for values that were dropped (unreadable, out of range, a bad or missing date). */
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
  /** "Now" for the future-date check and "Today" / "Yesterday" dates. Defaults to Date.now(). */
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
    // A line this long is nothing the Shortcut writes: skipped like a blank line (and kept from KEY_LINE, which is
    // slow on long runs of spaces).
    const line = raw.length > 300 ? '' : raw.trim();
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

/** JSON values → text: numbers, strings, {value, unit} objects and arrays of those (nested at most 4 deep). */
function jsonVals(v: unknown, unit?: string, depth = 0): Val[] {
  if (depth > 4 || v == null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap((x) => jsonVals(x, unit, depth + 1));
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
        // A record's first generic date key is its date: a sample's endDate after its startDate is the same sample.
        if (cls.field === 'date' && c.date.length) continue;
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
  for (const [kind, values, own] of kinds) {
    if (!values.length) continue;
    // Values pair with their dates by position: the kind's own dates, else the generic "date" list. Lists of
    // different lengths can't be paired (every value would get another sample's date).
    const dates = own.length ? own : c.date;
    if (dates.length && dates.length !== values.length) {
      out.errors.push(`${values.length} ${LABEL[kind]} values but ${dates.length} dates`);
      continue;
    }
    values.forEach((v, i) => {
      // Long text is cut (an error message never carries a whole odd post) and never reaches the regexes.
      const what = `${LABEL[kind]} "${v.text.slice(0, 40)}"`;
      if (v.text.length > 64) {
        out.errors.push(`Couldn't read the ${what}`);
        return;
      }
      const value = kind === 'weight' ? parseWeightKg(v.text, v.unit ?? c.unit ?? unit) : parseBodyFatPct(v.text);
      if (value == null) {
        out.errors.push(`Couldn't read the ${what}`);
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
      // No date is no sample: "now" would make a new weigh-in on every sync.
      const dateVal = dates[i];
      if (!dateVal) {
        out.errors.push(`The ${what} has no date`);
        return;
      }
      if (dateVal.text.length > 64) {
        out.errors.push(`Couldn't read the date "${dateVal.text.slice(0, 40)}" for the ${what}`);
        return;
      }
      const at = parseHealthDate(dateVal.text, now);
      if (at == null) {
        out.errors.push(`Couldn't read the date "${dateVal.text}" for the ${what}`);
        return;
      }
      if (at > now + FUTURE_SLACK_MS) {
        out.errors.push(`The ${what} is dated in the future`);
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
 * - dates per parseHealthDate; a value without a date is dropped with an error (so is every value of a kind whose
 *   values and dates are lists of different lengths)
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

/** Why a weigh-in was left alone. */
export type HealthSkipReason = 'unchanged' | 'deleted' | 'edited';

export const HEALTH_SKIP_LABEL: Record<HealthSkipReason, string> = {
  unchanged: 'Already in Heft',
  deleted: 'You deleted it in Heft',
  edited: 'You edited it in Heft',
};

export interface HealthImportPlan {
  /** New rows, one per weigh-in Heft doesn't have yet. */
  add: Measurement[];
  /** Imported rows whose values change (body fat that synced after its weight, a weight joining its body fat's row). */
  update: Measurement[];
  /** One entry per weigh-in left alone; `at` = its anchor (the weight's time, or the body fat's on a fat-only one). */
  skipped: { reason: HealthSkipReason; at: number }[];
  /**
   * The newest sample this import writes, or that an imported row already holds; null = none. Display only
   * (Settings.healthImportedThrough, "newest weigh-in from the scale"): it no longer decides what may be imported.
   */
  importedThrough: number | null;
  /**
   * Settings.healthDeleted times this plan lifts: the deleted weigh-ins a reimportAll plan brings back (only those,
   * so a deleted weigh-in that isn't in this paste stays deleted). applyHealthImport removes them.
   */
  clearDeleted?: number[];
}

export interface HealthPlanOptions {
  /** "Bring deleted weigh-ins back": ignore Settings.healthDeleted (the plan's clearDeleted lifts what it restores). */
  reimportAll?: boolean;
}

/** One time on the scale: a weight and the body fat measured with it, or a body fat reading on its own. */
export interface HealthWeighIn {
  /** The anchor: the weight's time, else the body fat's. A new row's id ("hk_<anchor>"), date and healthAt. */
  at: number;
  weight?: HealthSample;
  bodyFat?: HealthSample;
}

/**
 * Two times this close are the same sample: Shortcuts' ISO 8601 text keeps whole seconds, so the same sample read
 * through another format can differ by the milliseconds.
 */
const SAME_SAMPLE_MS = 999;

const validKg = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0;
const validPct = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0;

function differs(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return (a ?? null) !== (b ?? null);
  return Math.abs(a - b) > 1e-6;
}

/** Oldest first, one sample per instant (the first one listed wins). */
function byTime(list: HealthSample[]): HealthSample[] {
  const out: HealthSample[] = [];
  for (const s of [...list].sort((a, b) => a.at - b.at)) if (!out.length || out[out.length - 1].at !== s.at) out.push(s);
  return out;
}

/**
 * Group samples into weigh-ins, oldest first: every weight is one; a body fat reading within SAME_WEIGH_IN_MS joins
 * the NEAREST weight (each reading joins one weight, each weight takes one reading); a body fat reading left over is
 * a weigh-in of its own (its weight hasn't reached Apple Health yet, or the scale only measured fat).
 */
export function groupWeighIns(samples: readonly HealthSample[]): HealthWeighIn[] {
  const valid = samples.filter((s) => Number.isFinite(s.at) && Number.isFinite(s.value));
  const ws = byTime(valid.filter((s) => s.kind === 'weight'));
  const fs = byTime(valid.filter((s) => s.kind === 'bodyFat'));
  // Every weight / body fat pair close enough to be one weigh-in, nearest first.
  const pairs: { w: number; f: number; d: number }[] = [];
  let from = 0;
  ws.forEach((w, wi) => {
    while (from < fs.length && fs[from].at < w.at - SAME_WEIGH_IN_MS) from++;
    for (let fi = from; fi < fs.length && fs[fi].at <= w.at + SAME_WEIGH_IN_MS; fi++) {
      pairs.push({ w: wi, f: fi, d: Math.abs(fs[fi].at - w.at) });
    }
  });
  pairs.sort((a, b) => a.d - b.d || a.w - b.w || a.f - b.f);
  const fatOf = new Map<number, HealthSample>();
  const used = new Set<number>();
  for (const p of pairs) {
    if (fatOf.has(p.w) || used.has(p.f)) continue;
    fatOf.set(p.w, fs[p.f]);
    used.add(p.f);
  }
  const out: HealthWeighIn[] = ws.map((w, i) => {
    const fat = fatOf.get(i);
    return fat ? { at: w.at, weight: w, bodyFat: fat } : { at: w.at, weight: w };
  });
  fs.forEach((f, i) => {
    if (!used.has(i)) out.push({ at: f.at, bodyFat: f });
  });
  return out.sort((a, b) => a.at - b.at);
}

const sampleTimes = (w: HealthWeighIn): number[] => [w.weight?.at, w.bodyFat?.at].filter((t): t is number => t != null);

/** The times a stored row answers to: its Apple Health sample (healthAt) and the one in its id ("hk_<ms>"). */
function rowTimes(m: Measurement): number[] {
  const at = healthSampleAt(m);
  const fromId = /^hk_(\d+)/.exec(m.id);
  const idAt = fromId ? Number(fromId[1]) : null;
  return [at, idAt].filter((t, i, all): t is number => t != null && Number.isFinite(t) && all.indexOf(t) === i);
}

interface Timed {
  t: number;
  /** Index of the weigh-in / row the time belongs to. */
  i: number;
}

/** Entries within `ms` of `t` in a list sorted by time. */
function around(sorted: readonly Timed[], t: number, ms: number): Timed[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].t < t - ms) lo = mid + 1;
    else hi = mid;
  }
  const out: Timed[] = [];
  for (let k = lo; k < sorted.length && sorted[k].t <= t + ms; k++) out.push(sorted[k]);
  return out;
}

const timeIndex = (entries: Timed[]): Timed[] => entries.sort((a, b) => a.t - b.t || a.i - b.i);

interface Pair {
  w: number;
  r: number;
  d: number;
  /** Lower wins first (before distance). */
  rank: number;
}

/** One-to-one, best pairs first: weigh-in index → row index. */
function assign(pairs: Pair[]): Map<number, number> {
  pairs.sort((a, b) => a.rank - b.rank || a.d - b.d || a.w - b.w || a.r - b.r);
  const out = new Map<number, number>();
  const used = new Set<number>();
  for (const p of pairs) {
    if (out.has(p.w) || used.has(p.r)) continue;
    out.set(p.w, p.r);
    used.add(p.r);
  }
  return out;
}

/** A row with a weigh-in's values. A value the weigh-in doesn't bring is kept (a Shortcut line can come back empty). */
function withWeighIn(row: Measurement, w: HealthWeighIn): Measurement {
  const next: Measurement = { ...row };
  if (w.weight) next.bodyweightKg = w.weight.value;
  if (w.bodyFat) next.bodyFatPct = w.bodyFat.value;
  // A row is anchored on its weight: it moves to a weigh-in anchored on a weight, or to any weigh-in while it has none.
  if (w.weight || !validKg(row.bodyweightKg)) {
    next.date = w.at;
    next.healthAt = w.at;
  }
  return next;
}

const rowChanged = (a: Measurement, b: Measurement) =>
  differs(a.bodyweightKg, b.bodyweightKg) || differs(a.bodyFatPct, b.bodyFatPct) || a.date !== b.date || a.healthAt !== b.healthAt;

/**
 * Decide what an import does. EVERY weigh-in is its own row: the scale is sometimes off, so a re-weigh minutes later
 * is a second row and the bad one can be deleted. Re-importing the same samples (the Shortcut sends the last 30 days
 * every time) changes nothing.
 * - Samples group into weigh-ins (groupWeighIns): every weight is one, body fat within 10 minutes joins the nearest
 *   weight, a body fat reading left over is a body-fat-only weigh-in.
 * - A weigh-in Heft already has is found by the row answering to one of its sample times (id "hk_<ms>" or healthAt,
 *   to the second), which also recognises rows imported before every weigh-in got its own row. A row the user
 *   edited (source 'manual', still carrying its healthAt) is never touched: `edited`. An imported row is updated only
 *   when a value differs (`unchanged` otherwise); a value the weigh-in doesn't bring is never cleared, except body fat
 *   this import gives to another weigh-in within 10 minutes (it paired with this weight before its own weight synced).
 * - Deletes stick: a weigh-in with no row is skipped (`deleted`) unless opts.reimportAll, which restores it and lists
 *   its tombstones in plan.clearDeleted. A weigh-in with a weight is blocked only by a Settings.healthDeleted time at
 *   one of its own sample times (to the second); a body-fat-only weigh-in by the nearest one within 10 minutes (the
 *   other half of a deleted weigh-in). Each tombstone belongs to ONE weigh-in. So a re-weigh minutes after a deleted
 *   bad reading comes in, even when that reading is gone from Apple Health; and a deleted weigh-in never takes over
 *   another row through its body fat's time.
 * - The other half of a weigh-in: when the body fat synced before its weight, the body fat made a body-fat-only row;
 *   the weight joins that row (it moves to the weight's time; its id stays). Found by the body fat's time, else any
 *   imported row within 10 minutes that no other weigh-in owns and that doesn't disagree (a row with a weight is a
 *   different weigh-in from another weight).
 * - New weigh-ins become rows "hk_<anchor ms>" (anchor = the weight's time, else the body fat's), source 'health',
 *   date = healthAt = anchor.
 * - Rows typed in Heft (no Apple Health sample) never block an import and are never touched: a typed weigh-in and the
 *   scale's sit side by side, and lib/today.ts dailyWeighIns decides which one is the day's.
 * - plan.importedThrough: the newest sample written or already held (display only).
 */
export function planHealthImport(
  samples: HealthSample[],
  existing: Measurement[],
  settings: Pick<Settings, 'healthDeleted'>,
  opts: HealthPlanOptions = {},
): HealthImportPlan {
  const clearDeleted: number[] = [];
  const plan: HealthImportPlan = { add: [], update: [], skipped: [], importedThrough: null, clearDeleted };
  const mark = (w: HealthWeighIn) => {
    for (const t of sampleTimes(w)) plan.importedThrough = plan.importedThrough == null ? t : Math.max(plan.importedThrough, t);
  };
  const weighIns = groupWeighIns(samples);
  const times = weighIns.map(sampleTimes);

  // Rows that came from Apple Health: imported ones, and imported ones the user has edited since.
  const rows = existing.filter((m) => healthSampleAt(m) != null);
  const rowIndex = timeIndex(rows.flatMap((m, i) => rowTimes(m).map((t) => ({ t, i }))));

  // 1. Deleted weigh-ins: each tombstone goes to the ONE weigh-in nearest it (the earlier one on a tie). A weigh-in
  //    with a weight takes only a tombstone at one of its own sample times (to the second); a body-fat-only one, the
  //    nearest within 10 minutes (the other half of a deleted weigh-in).
  const weighInIndex = timeIndex(weighIns.flatMap((_, i) => times[i].map((t) => ({ t, i }))));
  const tombs = new Map<number, number[]>();
  for (const t of settings.healthDeleted ?? []) {
    if (!Number.isFinite(t)) continue;
    let best: { i: number; d: number } | null = null;
    for (const hit of around(weighInIndex, t, SAME_WEIGH_IN_MS)) {
      const d = Math.abs(hit.t - t);
      // Its own sample, else (within 10 minutes) its body fat arriving without its weight. A weigh-in with a weight at
      // another time is another weigh-in: the re-weigh after a bad reading the user also deleted from Apple Health.
      if (d > SAME_SAMPLE_MS && weighIns[hit.i].weight) continue;
      if (!best || d < best.d || (d === best.d && hit.i < best.i)) best = { i: hit.i, d };
    }
    if (best) tombs.set(best.i, [...(tombs.get(best.i) ?? []), t]);
  }

  // 2. The row each weigh-in already has (one each way); a row anchored on the weigh-in's own anchor is the better claim.
  const exactPairs: Pair[] = [];
  weighIns.forEach((w, wi) => {
    const deleted = tombs.has(wi) && !opts.reimportAll;
    for (const t of times[wi]) {
      for (const hit of around(rowIndex, t, SAME_SAMPLE_MS)) {
        const anchored = Math.abs((healthSampleAt(rows[hit.i]) ?? NaN) - w.at) <= SAME_SAMPLE_MS;
        if (deleted && !anchored) continue; // a deleted weigh-in never takes over another row through its body fat's time
        exactPairs.push({ w: wi, r: hit.i, d: Math.abs(hit.t - t), rank: anchored ? 0 : 1 });
      }
    }
  });
  const own = assign(exactPairs);
  const owned = new Set(own.values());

  // 3. The other half of a weigh-in already in Heft: an imported row no weigh-in owns, within 10 minutes, that
  //    doesn't disagree with it.
  const free = rows.map((m, i) => ({ m, i })).filter(({ m, i }) => m.source === 'health' && !owned.has(i));
  const freeIndex = timeIndex(
    free.flatMap(({ m, i }) => [...new Set([...rowTimes(m), m.date])].filter(Number.isFinite).map((t) => ({ t, i }))),
  );
  const fits = (w: HealthWeighIn, m: Measurement) =>
    !(w.weight && validKg(m.bodyweightKg)) && !(w.bodyFat && validPct(m.bodyFatPct) && differs(m.bodyFatPct, w.bodyFat.value));
  const joinPairs: Pair[] = [];
  weighIns.forEach((w, wi) => {
    if (own.has(wi) || (tombs.has(wi) && !opts.reimportAll)) return;
    for (const t of times[wi]) {
      for (const hit of around(freeIndex, t, SAME_WEIGH_IN_MS)) {
        if (fits(w, rows[hit.i])) joinPairs.push({ w: wi, r: hit.i, d: Math.abs(hit.t - t), rank: 0 });
      }
    }
  });
  const joins = assign(joinPairs);

  // 4. Decide.
  const taken = new Set(existing.map((m) => m.id));
  // A weigh-in without body fat whose row holds the body fat this import gives to another weigh-in within 10 minutes:
  // that reading paired with this weight while its own weight hadn't reached Apple Health yet, so it isn't this row's.
  const fatElsewhere = (row: Measurement, w: HealthWeighIn) =>
    !w.bodyFat &&
    validPct(row.bodyFatPct) &&
    weighIns.some(
      (o) => o !== w && o.bodyFat && Math.abs(o.bodyFat.at - w.at) <= SAME_WEIGH_IN_MS && !differs(o.bodyFat.value, row.bodyFatPct),
    );
  const refresh = (row: Measurement, w: HealthWeighIn) => {
    const next = withWeighIn(row, w);
    if (fatElsewhere(row, w)) next.bodyFatPct = null;
    if (rowChanged(row, next)) plan.update.push(next);
    else plan.skipped.push({ reason: 'unchanged', at: w.at });
    mark(w);
  };
  weighIns.forEach((w, wi) => {
    const mine = own.get(wi);
    if (mine != null) {
      const row = rows[mine];
      if (row.source !== 'health') plan.skipped.push({ reason: 'edited', at: w.at });
      else refresh(row, w);
      return;
    }
    const dead = tombs.get(wi);
    if (dead && !opts.reimportAll) {
      plan.skipped.push({ reason: 'deleted', at: w.at });
      return;
    }
    if (dead) clearDeleted.push(...dead);
    const join = joins.get(wi);
    if (join != null) {
      refresh(rows[join], w);
      return;
    }
    let id = 'hk_' + w.at;
    for (let n = 2; taken.has(id); n++) id = `hk_${w.at}_${n}`;
    taken.add(id);
    plan.add.push({
      id,
      date: w.at,
      healthAt: w.at,
      source: 'health',
      bodyweightKg: w.weight?.value ?? null,
      bodyFatPct: w.bodyFat?.value ?? null,
      photoIds: [],
    });
    mark(w);
  });
  return plan;
}

// ------------------------------------------------------------------ saving

/**
 * Save a plan in ONE transaction. Rows are checked against the database as it is NOW, because a preview can stay
 * open while the automatic sync runs or an entry is deleted or edited: a row edited since (no longer source
 * 'health'), an update whose row was deleted since, and a new row whose sample was deleted since are left alone; a
 * new row the automatic sync saved since only gets the values the plan brings (nothing cleared; counted as updated
 * when one changes).
 * Settings: healthImportedAt = now when rows were written, healthImportedThrough = the newer of the stored one and
 * plan.importedThrough, and the tombstones a "Bring deleted weigh-ins back" plan lifts (plan.clearDeleted) leave
 * healthDeleted. A plan that changes none of that (the "Done" of a nothing-new preview) leaves the settings alone.
 * It never writes the profile body weight: calories and Food targets already follow the newest weigh-in
 * (lib/settings.ts pickBodyweightKg). Returns the rows actually written.
 */
export async function applyHealthImport(plan: HealthImportPlan): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  await db.transaction('rw', db.measurements, db.settings, async () => {
    const cur = await getSettings();
    const lifted = new Set(plan.clearDeleted ?? []);
    const deleted = cur.healthDeleted ?? [];
    const deletedSince = (m: Measurement) => {
      const at = healthSampleAt(m);
      return at != null && deleted.some((t) => !lifted.has(t) && Math.abs(t - at) <= SAME_SAMPLE_MS);
    };
    const stored = await db.measurements.bulkGet([...plan.add, ...plan.update].map((m) => m.id));
    const rows: Measurement[] = [];
    plan.add.forEach((m, i) => {
      const now = stored[i];
      if ((now && now.source !== 'health') || deletedSince(m)) return;
      if (now) {
        // Saved since the preview (the automatic sync): fill in what this brings, never clear what the row has.
        const merged = { ...now, bodyweightKg: m.bodyweightKg ?? now.bodyweightKg, bodyFatPct: m.bodyFatPct ?? now.bodyFatPct };
        if (rowChanged(now, merged)) {
          rows.push(merged);
          updated++;
        }
        return;
      }
      rows.push(m);
      added++;
    });
    plan.update.forEach((m, i) => {
      const now = stored[plan.add.length + i];
      if (!now || now.source !== 'health') return;
      rows.push(m);
      updated++;
    });
    if (rows.length) await db.measurements.bulkPut(rows);

    const prev = cur.healthImportedThrough ?? null;
    const next = plan.importedThrough;
    const through = next == null ? prev : prev == null ? next : Math.max(prev, next);
    const keep = deleted.filter((t) => !lifted.has(t));
    if (!rows.length && through === prev && keep.length === deleted.length) return;
    await db.settings.put({
      ...cur,
      id: 'settings',
      healthImportedThrough: through,
      healthImportedAt: rows.length ? Date.now() : (cur.healthImportedAt ?? null),
      healthDeleted: keep,
    });
  });
  return { added, updated };
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

// ------------------------------------------------------------------ deleting

/** The Apple Health sample a row came from (imported rows, and imported rows the user edited since), else null. */
export function healthSampleAt(m: Pick<Measurement, 'id' | 'healthAt' | 'source'>): number | null {
  if (m.healthAt != null && Number.isFinite(m.healthAt)) return m.healthAt;
  // "hk_<ms>", or "hk_<ms>_2" when two weigh-ins share a millisecond (planHealthImport).
  const fromId = /^hk_(\d+)(?:_\d+)?$/.exec(m.id);
  return fromId ? Number(fromId[1]) : null;
}

/**
 * THE way to delete a measurement (Measurements' sheet, Today's weigh-ins sheet): removes the row and its photos and,
 * for a weigh-in that came from Apple Health, remembers its sample time in Settings.healthDeleted so no later import
 * (pasted or automatic) brings it back. One transaction.
 */
export async function deleteMeasurement(entry: Pick<Measurement, 'id' | 'healthAt' | 'source' | 'photoIds'>): Promise<void> {
  const at = healthSampleAt(entry);
  await db.transaction('rw', db.measurements, db.media, db.settings, async () => {
    await db.measurements.delete(entry.id);
    if (entry.photoIds?.length) await db.media.bulkDelete(entry.photoIds);
    if (at == null) return;
    const cur = await getSettings();
    const deleted = cur.healthDeleted ?? [];
    if (!deleted.includes(at)) await db.settings.put({ ...cur, id: 'settings', healthDeleted: [...deleted, at] });
  });
}
