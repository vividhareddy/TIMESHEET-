/**
 * Working-time calculations. Server-side port of frontend/src/utils/timesheet.ts so the API and the
 * UI compute expected hours, leave hours and overtime identically. The server's result is authoritative.
 */
import { addDays, rangesOverlap, sum, weekDates, weekday } from './dates.js';

export interface CalendarLike {
  workingDays: number[];
  hoursPerDay: number;
  holidays: Array<{ date: string; name: string; type: string }>;
}

export interface EmployeeLike {
  id: string;
  weeklyCapacity: number;
}

export interface LeaveLike {
  employeeId: string;
  date: string;
  hours: number;
  status: string;
}

export interface AllocationLike {
  employeeId: string;
  projectId: string;
  weeklyHours: number;
  startDate: string;
  endDate: string;
}

export interface EntryLike {
  projectId: string;
  hours: number[];
}

export interface PolicyLike {
  enabled: boolean;
  dailyThreshold: number;
  weeklyThreshold: number;
  weekendApplicable: boolean;
  holidayApplicable: boolean;
}

export const findHoliday = (cal: CalendarLike | undefined, date: string) => cal?.holidays.find((h) => h.date === date);

/** Scheduled by the calendar (or Mon–Fri when the employee has no calendar). Ignores holidays. */
export const isScheduledDay = (cal: CalendarLike | undefined, date: string): boolean =>
  cal ? cal.workingDays.includes(weekday(date)) : ![0, 6].includes(weekday(date));

export const isWorkingDay = (cal: CalendarLike | undefined, date: string): boolean => isScheduledDay(cal, date) && !findHoliday(cal, date);

/** Daily target derived from the weekly target and the number of scheduled days, rounded to 0.5 h. */
export function dailyTarget(emp: EmployeeLike, cal: CalendarLike | undefined): number {
  const days = cal?.workingDays.length || 5;
  return Math.round((emp.weeklyCapacity / days) * 2) / 2;
}

/** Full day = one daily target; half day = half of it. */
export const leaveHours = (emp: EmployeeLike, cal: CalendarLike | undefined, duration: 'full' | 'half'): number =>
  duration === 'full' ? dailyTarget(emp, cal) : dailyTarget(emp, cal) / 2;

export interface DayExpectation {
  date: string;
  working: boolean;
  leaveHours: number;
  expected: number;
}

/** Per-day expected hours: scheduled, non-holiday days at the daily target, minus approved leave. */
export function weekExpectations(emp: EmployeeLike, cal: CalendarLike | undefined, leaves: LeaveLike[], weekStart: string): DayExpectation[] {
  const daily = dailyTarget(emp, cal);
  return weekDates(weekStart).map((date) => {
    const working = isWorkingDay(cal, date);
    const leave = sum(leaves.filter((l) => l.employeeId === emp.id && l.date === date && l.status === 'approved').map((l) => l.hours));
    return { date, working, leaveHours: working ? leave : 0, expected: working ? Math.max(0, daily - leave) : 0 };
  });
}

export const expectedWeekHours = (emp: EmployeeLike, cal: CalendarLike | undefined, leaves: LeaveLike[], weekStart: string): number =>
  sum(weekExpectations(emp, cal, leaves, weekStart).map((d) => d.expected));

export function allocationsForWeek<A extends AllocationLike>(allocations: A[], employeeId: string, weekStart: string): A[] {
  const end = addDays(weekStart, 6);
  return allocations.filter((a) => a.employeeId === employeeId && rangesOverlap(a.startDate, a.endDate, weekStart, end));
}

export const overlapsWeek = (a: { startDate: string; endDate: string }, weekStart: string) => rangesOverlap(a.startDate, a.endDate, weekStart, addDays(weekStart, 6));

export const entryTotal = (e: EntryLike): number => sum(e.hours);

export const dailyTotals = (entries: EntryLike[]): number[] => Array.from({ length: 7 }, (_, i) => sum(entries.map((e) => e.hours[i] ?? 0)));

export interface OvertimeBreakdown {
  total: number;
  byDay: number[];
  byProject: Record<string, number>;
}

/**
 * Overtime = hours above the daily threshold on working days, plus (when the policy applies) all hours
 * on weekends / holidays, topped up by any weekly excess beyond the weekly threshold.
 * Each overtime hour is attributed to the project with the most hours that day.
 */
export function computeOvertime(entries: EntryLike[], weekStart: string, cal: CalendarLike | undefined, policy: PolicyLike): OvertimeBreakdown {
  const byDay = Array(7).fill(0) as number[];
  const byProject: Record<string, number> = {};
  if (!policy.enabled) return { total: 0, byDay, byProject };

  const totals = dailyTotals(entries);
  const topProject = (i: number): string | undefined => {
    let best: EntryLike | undefined;
    for (const e of entries) if (!best || (e.hours[i] ?? 0) > (best.hours[i] ?? 0)) best = e;
    return best?.projectId;
  };

  weekDates(weekStart).forEach((date, i) => {
    const total = totals[i] ?? 0;
    let ot: number;
    if (!isScheduledDay(cal, date)) ot = policy.weekendApplicable ? total : 0;
    else if (findHoliday(cal, date)) ot = policy.holidayApplicable ? total : 0;
    else ot = Math.max(0, total - policy.dailyThreshold);
    if (ot > 0) {
      byDay[i] = ot;
      const pid = topProject(i);
      if (pid) byProject[pid] = sum([byProject[pid] ?? 0, ot]);
    }
  });

  let total = sum(byDay);
  const weeklyExcess = Math.max(0, sum(totals) - policy.weeklyThreshold);
  if (weeklyExcess > total) {
    const busiest = [...entries].sort((a, b) => entryTotal(b) - entryTotal(a))[0];
    if (busiest) byProject[busiest.projectId] = sum([byProject[busiest.projectId] ?? 0, weeklyExcess - total]);
    total = weeklyExcess;
  }
  return { total, byDay, byProject };
}
