/** ISO (yyyy-mm-dd) date helpers. Calendar dates are timezone-free, so all arithmetic is done in UTC. */

const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);
const format = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

/** JS weekday (0 = Sunday … 6 = Saturday). */
export const weekday = (iso: string): number => parse(iso).getUTCDay();

/** Monday of the week containing the date. */
export function startOfWeek(iso: string): string {
  const wd = weekday(iso);
  return addDays(iso, wd === 0 ? -6 : 1 - wd);
}

/** Today in the server's local time zone. */
export function todayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export const currentWeekStart = (): string => startOfWeek(todayISO());

/** Monday … Sunday of the week. */
export const weekDates = (weekStart: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

export const rangesOverlap = (aStart: string, aEnd: string, bStart: string, bEnd: string): boolean => aStart <= bEnd && bStart <= aEnd;

export const sum = (values: number[]): number => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
