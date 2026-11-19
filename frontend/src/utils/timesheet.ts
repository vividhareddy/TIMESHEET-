import type {
  Allocation,
  Employee,
  EntryStatus,
  EntryType,
  Holiday,
  ISODate,
  LeaveDuration,
  LeaveRequest,
  OvertimePolicy,
  Timesheet,
  TimesheetEntry,
  TimesheetStatus,
  WorkCalendar,
} from '@/types';
import { addDays, rangesOverlap, weekDates, weekday } from './date';
import { sum } from './format';

// ------------------------------------------------------------- Calendar math

export function findHoliday(calendar: WorkCalendar | undefined, date: ISODate): Holiday | undefined {
  return calendar?.holidays.find((h) => h.date === date);
}

export function isWorkingDay(calendar: WorkCalendar | undefined, date: ISODate): boolean {
  if (!calendar) return ![0, 6].includes(weekday(date));
  return calendar.workingDays.includes(weekday(date)) && !findHoliday(calendar, date);
}

/** Daily target derived from the employee's weekly target and calendar schedule. */
export function dailyTarget(employee: Employee, calendar: WorkCalendar | undefined): number {
  const days = calendar?.workingDays.length || 5;
  return Math.round((employee.weeklyCapacity / days) * 2) / 2;
}

/** Leave hours are computed from the calendar schedule — Full = 1 day, Half = ½ day. */
export function leaveHours(employee: Employee, calendar: WorkCalendar | undefined, duration: LeaveDuration): number {
  const daily = dailyTarget(employee, calendar);
  return duration === 'full' ? daily : daily / 2;
}

/** Preview only — the server recomputes this from the employee's own schedule on save. */
export function halfDayHours(employee: Employee, calendar: WorkCalendar | undefined): number {
  return dailyTarget(employee, calendar) / 2;
}

export const ENTRY_TYPE_LABEL: Record<EntryType, string> = {
  regular: 'Regular',
  half_day: 'Half day leave',
  overtime: 'Overtime',
  leave: 'Full day leave',
  holiday: 'Holiday',
};

export interface DayExpectation {
  date: ISODate;
  working: boolean;
  holiday?: Holiday;
  leaveHours: number;
  expected: number;
}

export function weekExpectations(
  employee: Employee,
  calendar: WorkCalendar | undefined,
  leaves: LeaveRequest[],
  weekStart: ISODate,
): DayExpectation[] {
  const daily = dailyTarget(employee, calendar);
  return weekDates(weekStart).map((date) => {
    const holiday = findHoliday(calendar, date);
    const scheduled = calendar ? calendar.workingDays.includes(weekday(date)) : ![0, 6].includes(weekday(date));
    const working = scheduled && !holiday;
    const leave = leaves
      .filter((l) => l.employeeId === employee.id && l.date === date && l.status === 'approved')
      .reduce((acc, l) => acc + l.hours, 0);
    const expected = working ? Math.max(0, daily - leave) : 0;
    return { date, working, holiday, leaveHours: working ? leave : 0, expected };
  });
}

export function expectedWeekHours(
  employee: Employee,
  calendar: WorkCalendar | undefined,
  leaves: LeaveRequest[],
  weekStart: ISODate,
): number {
  return sum(weekExpectations(employee, calendar, leaves, weekStart).map((d) => d.expected));
}

// ------------------------------------------------------------ Allocation math

export function allocationsForWeek(allocations: Allocation[], employeeId: string, weekStart: ISODate): Allocation[] {
  const end = addDays(weekStart, 6);
  return allocations.filter((a) => a.employeeId === employeeId && rangesOverlap(a.startDate, a.endDate, weekStart, end));
}

export function activeAllocationsOn(allocations: Allocation[], date: ISODate): Allocation[] {
  return allocations.filter((a) => a.startDate <= date && a.endDate >= date);
}

export type AllocationHealth = 'under' | 'optimal' | 'over';

export function allocationHealth(allocated: number, capacity: number): AllocationHealth {
  if (allocated > capacity) return 'over';
  if (allocated < capacity) return 'under';
  return 'optimal';
}

// ------------------------------------------------------------- Timesheet math

export function entryTotal(entry: TimesheetEntry): number {
  return sum(entry.hours);
}

export function dailyTotals(entries: TimesheetEntry[]): number[] {
  return Array.from({ length: 7 }, (_, i) => sum(entries.map((e) => e.hours[i] ?? 0)));
}

export function timesheetTotal(ts: Timesheet | undefined): number {
  if (!ts) return 0;
  return sum(ts.entries.map(entryTotal));
}

export function isEntryLocked(status: EntryStatus): boolean {
  return status === 'pending' || status === 'approved';
}

export function deriveTimesheetStatus(ts: Timesheet | undefined): TimesheetStatus {
  if (!ts || ts.entries.length === 0) return 'not_started';
  const statuses = ts.entries.map((e) => e.status);
  if (statuses.every((s) => s === 'draft')) return 'draft';
  if (statuses.some((s) => s === 'returned')) return 'returned';
  if (statuses.some((s) => s === 'rejected')) return 'rejected';
  if (statuses.every((s) => s === 'approved')) return 'approved';
  if (statuses.some((s) => s === 'approved')) return 'partially_approved';
  return 'submitted';
}

export function approvalProgress(ts: Timesheet | undefined): { approved: number; total: number } {
  if (!ts) return { approved: 0, total: 0 };
  const submittedEntries = ts.entries.filter((e) => e.status !== 'draft');
  return { approved: submittedEntries.filter((e) => e.status === 'approved').length, total: ts.entries.length };
}

// ------------------------------------------------------------------ Overtime

export interface OvertimeBreakdown {
  total: number;
  byDay: number[];
  byProject: Record<string, number>;
}

/**
 * Overtime = hours above the daily threshold on working days,
 * plus (if the policy applies) all hours on weekends / holidays,
 * topped up by any weekly excess beyond the weekly threshold.
 * Each overtime hour is attributed to the project with the most hours that day.
 */
export function computeOvertime(
  entries: TimesheetEntry[],
  weekStart: ISODate,
  calendar: WorkCalendar | undefined,
  policy: OvertimePolicy,
): OvertimeBreakdown {
  const byDay = Array(7).fill(0) as number[];
  const byProject: Record<string, number> = {};
  if (!policy.enabled) return { total: 0, byDay, byProject };

  const dates = weekDates(weekStart);
  const totals = dailyTotals(entries);
  const topProject = (dayIndex: number): string | undefined => {
    let best: TimesheetEntry | undefined;
    for (const e of entries) if (!best || (e.hours[dayIndex] ?? 0) > (best.hours[dayIndex] ?? 0)) best = e;
    return best?.projectId;
  };

  dates.forEach((date, i) => {
    const scheduled = calendar ? calendar.workingDays.includes(weekday(date)) : i < 5;
    const holiday = findHoliday(calendar, date);
    let ot = 0;
    if (!scheduled) ot = policy.weekendApplicable ? totals[i] : 0;
    else if (holiday) ot = policy.holidayApplicable ? totals[i] : 0;
    else ot = Math.max(0, totals[i] - policy.dailyThreshold);
    if (ot > 0) {
      byDay[i] = ot;
      const pid = topProject(i);
      if (pid) byProject[pid] = (byProject[pid] ?? 0) + ot;
    }
  });

  let total = sum(byDay);
  const weeklyExcess = Math.max(0, sum(totals) - policy.weeklyThreshold);
  if (weeklyExcess > total) {
    const extra = weeklyExcess - total;
    const busiest = [...entries].sort((a, b) => entryTotal(b) - entryTotal(a))[0];
    if (busiest) byProject[busiest.projectId] = (byProject[busiest.projectId] ?? 0) + extra;
    total = weeklyExcess;
  }
  return { total, byDay, byProject };
}
