import type { ISODate } from '@/types';

export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parse yyyy-mm-dd as a local date (avoids UTC shift). */
export function parseISO(date: ISODate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date: Date): ISODate {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayISO(): ISODate {
  return toISO(new Date());
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = parseISO(date);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

/** Monday of the week containing the given date. */
export function startOfWeek(date: ISODate | Date): ISODate {
  const d = typeof date === 'string' ? parseISO(date) : new Date(date);
  const day = d.getDay(); // 0 Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toISO(d);
}

export function currentWeekStart(): ISODate {
  return startOfWeek(new Date());
}

export function weekDates(weekStart: ISODate): ISODate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** JS weekday (0 = Sunday) for an ISO date. */
export function weekday(date: ISODate): number {
  return parseISO(date).getDay();
}

export function isWeekend(date: ISODate): boolean {
  const d = weekday(date);
  return d === 0 || d === 6;
}

export function formatDate(date: ISODate, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }): string {
  if (!date) return '—';
  return parseISO(date).toLocaleDateString('en-US', opts);
}

export function formatShort(date: ISODate): string {
  return formatDate(date, { day: 'numeric', month: 'short' });
}

export function formatWeekRange(weekStart: ISODate): string {
  const end = addDays(weekStart, 6);
  const s = parseISO(weekStart);
  const e = parseISO(end);
  const sameMonth = s.getMonth() === e.getMonth();
  const left = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const right = sameMonth
    ? `${e.getDate()}, ${e.getFullYear()}`
    : e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${left} – ${right}`;
}

export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function isWithin(date: ISODate, start: ISODate, end: ISODate): boolean {
  return date >= start && date <= end;
}

/** True if the ranges [aStart,aEnd] and [bStart,bEnd] overlap. */
export function rangesOverlap(aStart: ISODate, aEnd: ISODate, bStart: ISODate, bEnd: ISODate): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Calendar matrix (6 weeks × 7 days, Monday-first) for a month view. */
export function monthMatrix(year: number, month: number): ISODate[] {
  const first = toISO(new Date(year, month, 1));
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function weeksBack(count: number, from: ISODate = currentWeekStart()): ISODate[] {
  return Array.from({ length: count }, (_, i) => addDays(from, -7 * i));
}
