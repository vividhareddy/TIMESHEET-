/**
 * Pure helpers for the assistant's leave planner: reading months and dates from typed text, and ranking clash-free
 * leave days. Dates are ISO strings (YYYY-MM-DD) handled in UTC, so results never depend on the browser's time zone.
 * Self-contained on purpose (no app imports), so it can be tested on its own.
 */

export type ISODate = string;

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): ISODate => `${y}-${pad(m)}-${pad(d)}`;
const parts = (date: ISODate) => ({ y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) });
const utc = (date: ISODate) => new Date(`${date}T00:00:00Z`);

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addDays(date: ISODate, days: number): ISODate {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export const weekdayOf = (date: ISODate) => utc(date).getUTCDay();

export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  return `${y + Math.floor(m / 12)}-${pad((((m % 12) + 12) % 12) + 1)}`;
}

export const monthOf = (date: ISODate) => date.slice(0, 7);

export function monthLabel(month: string): string {
  return utc(`${month}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** e.g. "Fri 5 Dec" (with the year when it differs from `today`'s). */
export function dayLabel(date: ISODate, today?: ISODate): string {
  const withYear = today !== undefined && date.slice(0, 4) !== today.slice(0, 4);
  return utc(date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

function monthIndex(word: string): number {
  const w = word.toLowerCase();
  return MONTH_NAMES.findIndex((name) => name.startsWith(w.slice(0, 3)));
}

/** A month named without a year means the next time that month comes round (this month counts). */
function yearFor(monthIdx: number, today: ISODate): number {
  const { y, m } = parts(today);
  return monthIdx + 1 < m ? y + 1 : y;
}

/** Reads a month from text: "this month", "next month", "December", "dec 2026", "2026-12". Null if none. */
export function parseMonth(text: string, today: ISODate): string | null {
  const t = text.toLowerCase();
  const current = monthOf(today);
  if (/\bmonth after next\b/.test(t)) return addMonths(current, 2);
  if (/\bnext\s+month\b/.test(t)) return addMonths(current, 1);
  if (/\b(this|current|present)\s+(?:\w+\s+)?month\b/.test(t)) return current;
  const isoMonth = /\b(\d{4})-(0[1-9]|1[0-2])\b/.exec(t);
  if (isoMonth) return `${isoMonth[1]}-${isoMonth[2]}`;
  const named = new RegExp(`\\b${MONTH_RE}\\b(?:\\s+(\\d{4}))?`).exec(t);
  if (named) {
    const idx = monthIndex(named[1]);
    const year = named[2] ? Number(named[2]) : yearFor(idx, today);
    return `${year}-${pad(idx + 1)}`;
  }
  return null;
}

export interface ParsedDates {
  /** Sorted, unique. */
  dates: ISODate[];
  /** Dates that came from a range such as "15-17 Dec": weekends and holidays in them are skipped silently. */
  fromRange: Set<ISODate>;
}

/**
 * Reads leave dates from text. Understands "12 Dec", "Dec 12", "12th December 2026", "2026-12-12", "12/12",
 * ranges ("15-17 Dec", "Dec 15 to 17", "15 to 17") and bare day numbers ("5, 8 and 12"), which use `month`.
 */
export function parseDates(text: string, month: string, today: ISODate): ParsedDates {
  let t = ` ${text.toLowerCase()} `
    .replace(/(\d{1,2})(st|nd|rd|th)\b/g, '$1')
    .replace(/\s*(?:–|—|\bto\b|\btill\b|\buntil\b|\bthrough\b|\bthru\b)\s*/g, '-')
    .replace(/\bof\b/g, ' ');
  const out = new Set<ISODate>();
  const fromRange = new Set<ISODate>();
  const mYear = Number(month.slice(0, 4));
  const mIdx = Number(month.slice(5, 7)) - 1;

  const add = (y: number, mi: number, d: number, range = false) => {
    if (mi < 0 || mi > 11 || d < 1 || d > daysInMonth(y, mi + 1)) return;
    const date = iso(y, mi + 1, d);
    out.add(date);
    if (range) fromRange.add(date);
  };
  const addRange = (y: number, mi: number, a: number, b: number) => {
    if (b < a || b - a > 30) return;
    for (let d = a; d <= b; d++) add(y, mi, d, true);
  };
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    t = t.replace(re, (...args) => {
      fn(args.slice(0, -2) as unknown as RegExpExecArray);
      return ' ';
    });
  };

  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => add(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  take(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/g, (m) => {
    const mi = Number(m[2]) - 1;
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : yearFor(mi, today);
    add(year, mi, Number(m[1]));
  });
  take(new RegExp(`\\b(\\d{1,2})\\s*-\\s*(\\d{1,2})\\s*${MONTH_RE}\\b(?:\\s+(\\d{4}))?`, 'g'), (m) => {
    const mi = monthIndex(m[3]);
    addRange(m[4] ? Number(m[4]) : yearFor(mi, today), mi, Number(m[1]), Number(m[2]));
  });
  take(new RegExp(`\\b${MONTH_RE}\\s*(\\d{1,2})\\s*-\\s*(\\d{1,2})\\b(?:,?\\s+(\\d{4}))?`, 'g'), (m) => {
    const mi = monthIndex(m[1]);
    addRange(m[4] ? Number(m[4]) : yearFor(mi, today), mi, Number(m[2]), Number(m[3]));
  });
  take(new RegExp(`\\b(\\d{1,2})\\s*${MONTH_RE}\\b(?:\\s+(\\d{4}))?`, 'g'), (m) => {
    const mi = monthIndex(m[2]);
    add(m[3] ? Number(m[3]) : yearFor(mi, today), mi, Number(m[1]));
  });
  take(new RegExp(`\\b${MONTH_RE}\\s*(\\d{1,2})\\b(?:,?\\s+(\\d{4}))?`, 'g'), (m) => {
    const mi = monthIndex(m[1]);
    add(m[3] ? Number(m[3]) : yearFor(mi, today), mi, Number(m[2]));
  });
  take(/\b(\d{1,2})\s*-\s*(\d{1,2})\b/g, (m) => addRange(mYear, mIdx, Number(m[1]), Number(m[2])));
  take(/\b(\d{1,2})\b/g, (m) => add(mYear, mIdx, Number(m[1])));

  return { dates: [...out].sort(), fromRange };
}

export interface Suggestion {
  date: ISODate;
  /** Why this day is a good pick, if anything stands out. */
  note?: string;
  longWeekend: boolean;
}

export interface SuggestInput {
  month: string;
  today: ISODate;
  isWorkingDay: (date: ISODate) => boolean;
  holidayName: (date: ISODate) => string | undefined;
  /** Days on which a teammate is on leave. */
  teamBusy: Set<ISODate>;
  /** Days the user already has leave. */
  mine: Set<ISODate>;
  max?: number;
}

/**
 * Clash-free working days in the month, after today. Days next to a holiday, then Fridays and Mondays (a long
 * weekend), are preferred; the picks are returned in date order.
 */
export function suggestLeaveDays(input: SuggestInput): Suggestion[] {
  const { month, today, isWorkingDay, holidayName, teamBusy, mine, max = 6 } = input;
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const scored: (Suggestion & { score: number })[] = [];
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const date = iso(y, m, d);
    if (date <= today || !isWorkingDay(date) || teamBusy.has(date) || mine.has(date)) continue;
    const before = holidayName(addDays(date, -1));
    const after = holidayName(addDays(date, 1));
    const wd = weekdayOf(date);
    const longWeekend = wd === 5 || wd === 1 || !isWorkingDay(addDays(date, -1)) || !isWorkingDay(addDays(date, 1));
    const holiday = before ?? after;
    scored.push({
      date,
      longWeekend,
      note: holiday ? `next to ${holiday}` : longWeekend ? 'long weekend' : undefined,
      score: (holiday ? 3 : 0) + (longWeekend ? 2 : 0),
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date))
    .slice(0, max)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ score: _score, ...s }) => s);
}
