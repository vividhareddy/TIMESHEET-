/** Shared loaders and row → API mappers for the operational modules (shapes match frontend/src/types). */
import type { Db } from './db.js';
import { EMPLOYEE_COLUMNS, toEmployee, type Employee, type EmployeeRow } from './models/employee.js';
import type { CalendarLike } from './lib/workCalc.js';

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const iso = (d: Date | null | undefined): string | undefined => (d ? d.toISOString() : undefined);
/** Omits keys whose value is undefined (the frontend uses optional fields, not nulls). */
const compact = <T>(o: Record<string, unknown>): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

// ---------------------------------------------------------------- employees

export async function loadEmployees(db: Db, org: string): Promise<Map<string, Employee>> {
  const { rows } = await db.query<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE organisation_id = $1`, [org]);
  return new Map(rows.map((r) => [r.id, toEmployee(r)]));
}

// ---------------------------------------------------------------- calendars

export type Calendar = CalendarLike & { id: string };

export async function loadCalendars(db: Db, org: string): Promise<Map<string, Calendar>> {
  const { rows } = await db.query<{ id: string; working_days: number[]; hours_per_day: string; holidays: Calendar['holidays'] }>(
    `SELECT c.id, c.working_days, c.hours_per_day,
            COALESCE(json_agg(json_build_object('date', to_char(h.date, 'YYYY-MM-DD'), 'name', h.name, 'type', h.type)) FILTER (WHERE h.id IS NOT NULL), '[]') AS holidays
       FROM calendars c LEFT JOIN holidays h ON h.calendar_id = c.id
      WHERE c.organisation_id = $1 GROUP BY c.id`,
    [org],
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, workingDays: r.working_days, hoursPerDay: num(r.hours_per_day), holidays: r.holidays }]));
}

// -------------------------------------------------------------- allocations

export interface Allocation {
  id: string;
  employeeId: string;
  projectId: string;
  projectRole: string;
  weeklyHours: number;
  startDate: string;
  endDate: string;
}

export const ALLOCATION_COLUMNS = `id, employee_id, project_id, project_role, weekly_hours,
  to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date`;

export interface AllocationRow {
  id: string;
  employee_id: string;
  project_id: string;
  project_role: string;
  weekly_hours: string;
  start_date: string;
  end_date: string;
}

export const toAllocation = (r: AllocationRow): Allocation => ({
  id: r.id,
  employeeId: r.employee_id,
  projectId: r.project_id,
  projectRole: r.project_role,
  weeklyHours: num(r.weekly_hours),
  startDate: r.start_date,
  endDate: r.end_date,
});

/** Allocations overlapping [from, to] (both optional). */
export async function loadAllocations(db: Db, org: string, range?: { from?: string; to?: string; employeeIds?: string[] }): Promise<Allocation[]> {
  const { rows } = await db.query<AllocationRow>(
    `SELECT ${ALLOCATION_COLUMNS} FROM allocations
      WHERE organisation_id = $1
        AND ($2::date IS NULL OR end_date >= $2::date)
        AND ($3::date IS NULL OR start_date <= $3::date)
        AND ($4::uuid[] IS NULL OR employee_id = ANY($4::uuid[]))
      ORDER BY start_date, id`,
    [org, range?.from ?? null, range?.to ?? null, range?.employeeIds ?? null],
  );
  return rows.map(toAllocation);
}

// -------------------------------------------------------------------- leave

export interface LeaveRequest {
  id: string;
  employeeId: string;
  date: string;
  duration: 'full' | 'half';
  hours: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  appliedOn: string;
  reviewerId?: string;
  reviewerComment?: string;
  reviewedAt?: string;
}

export const LEAVE_COLUMNS = `id, employee_id, to_char(date, 'YYYY-MM-DD') AS date, duration, hours, reason, status, applied_on,
  reviewer_id, reviewer_comment, reviewed_at`;

export interface LeaveRow {
  id: string;
  employee_id: string;
  date: string;
  duration: 'full' | 'half';
  hours: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  applied_on: Date;
  reviewer_id: string | null;
  reviewer_comment: string | null;
  reviewed_at: Date | null;
}

export const toLeave = (r: LeaveRow): LeaveRequest =>
  compact<LeaveRequest>({
    id: r.id,
    employeeId: r.employee_id,
    date: r.date,
    duration: r.duration,
    hours: num(r.hours),
    reason: r.reason,
    status: r.status,
    appliedOn: r.applied_on.toISOString(),
    reviewerId: r.reviewer_id ?? undefined,
    reviewerComment: r.reviewer_comment ?? undefined,
    reviewedAt: iso(r.reviewed_at),
  });

/** Approved leave in [from, to] — the only leave that reduces expected hours. */
export async function loadApprovedLeaves(db: Db, org: string, from: string, to: string): Promise<LeaveRequest[]> {
  const { rows } = await db.query<LeaveRow>(
    `SELECT ${LEAVE_COLUMNS} FROM leave_requests WHERE organisation_id = $1 AND status = 'approved' AND date BETWEEN $2 AND $3`,
    [org, from, to],
  );
  return rows.map(toLeave);
}

// ----------------------------------------------------------------- overtime

export interface OvertimeRequest {
  id: string;
  employeeId: string;
  projectId: string;
  weekStart: string;
  date?: string;
  hours: number;
  reason: string;
  source: 'timesheet' | 'pre_approval';
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewerId?: string;
  reviewerComment?: string;
  reviewedAt?: string;
  timesheetId?: string;
}

export const OVERTIME_COLUMNS = `id, employee_id, project_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, to_char(date, 'YYYY-MM-DD') AS date,
  hours, reason, source, status, created_at, reviewer_id, reviewer_comment, reviewed_at, timesheet_id`;

export interface OvertimeRow {
  id: string;
  employee_id: string;
  project_id: string;
  week_start: string;
  date: string | null;
  hours: string;
  reason: string;
  source: 'timesheet' | 'pre_approval';
  status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
  reviewer_id: string | null;
  reviewer_comment: string | null;
  reviewed_at: Date | null;
  timesheet_id: string | null;
}

export const toOvertime = (r: OvertimeRow): OvertimeRequest =>
  compact<OvertimeRequest>({
    id: r.id,
    employeeId: r.employee_id,
    projectId: r.project_id,
    weekStart: r.week_start,
    date: r.date ?? undefined,
    hours: num(r.hours),
    reason: r.reason,
    source: r.source,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    reviewerId: r.reviewer_id ?? undefined,
    reviewerComment: r.reviewer_comment ?? undefined,
    reviewedAt: iso(r.reviewed_at),
    timesheetId: r.timesheet_id ?? undefined,
  });

// --------------------------------------------------------------- timesheets

export type EntryStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'returned';

export interface TimesheetEntry {
  projectId: string;
  hours: number[];
  description: string;
  status: EntryStatus;
  managerComment?: string;
  originalHours?: number[];
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface ApprovalEvent {
  id: string;
  at: string;
  actorId: string;
  action: string;
  projectId?: string;
  comment?: string;
}

export interface Timesheet {
  id: string;
  employeeId: string;
  weekStart: string;
  entries: TimesheetEntry[];
  submittedAt?: string;
  updatedAt: string;
  history: ApprovalEvent[];
}

export interface TimesheetFilter {
  ids?: string[];
  employeeIds?: string[];
  weekStart?: string;
  from?: string;
  to?: string;
}

/** Loads timesheets with their entries and history in three queries. */
export async function fetchTimesheets(db: Db, org: string, f: TimesheetFilter = {}): Promise<Timesheet[]> {
  const ts = await db.query<{ id: string; employee_id: string; week_start: string; submitted_at: Date | null; updated_at: Date }>(
    `SELECT id, employee_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, submitted_at, updated_at
       FROM timesheets
      WHERE organisation_id = $1
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
        AND ($3::uuid[] IS NULL OR employee_id = ANY($3::uuid[]))
        AND ($4::date IS NULL OR week_start = $4::date)
        AND ($5::date IS NULL OR week_start >= $5::date)
        AND ($6::date IS NULL OR week_start <= $6::date)
      ORDER BY week_start DESC, employee_id`,
    [org, f.ids ?? null, f.employeeIds ?? null, f.weekStart ?? null, f.from ?? null, f.to ?? null],
  );
  if (!ts.rows.length) return [];
  const ids = ts.rows.map((r) => r.id);
  const [entries, events] = await Promise.all([
    db.query<{
      timesheet_id: string; project_id: string; hours: string[]; original_hours: string[] | null; description: string; status: EntryStatus;
      manager_comment: string | null; reviewed_by: string | null; reviewed_at: Date | null;
    }>(
      `SELECT timesheet_id, project_id, hours, original_hours, description, status, manager_comment, reviewed_by, reviewed_at
         FROM timesheet_entries WHERE timesheet_id = ANY($1::uuid[]) ORDER BY position, project_id`,
      [ids],
    ),
    db.query<{ id: string; timesheet_id: string; at: Date; actor_id: string; action: string; project_id: string | null; comment: string | null }>(
      'SELECT id, timesheet_id, at, actor_id, action, project_id, comment FROM timesheet_events WHERE timesheet_id = ANY($1::uuid[]) ORDER BY at, id',
      [ids],
    ),
  ]);
  return ts.rows.map((t) => ({
    ...compact<Omit<Timesheet, "entries" | "history">>({ id: t.id, employeeId: t.employee_id, weekStart: t.week_start, submittedAt: iso(t.submitted_at), updatedAt: t.updated_at.toISOString() }),
    entries: entries.rows
      .filter((e) => e.timesheet_id === t.id)
      .map((e) =>
        compact<TimesheetEntry>({
          projectId: e.project_id,
          hours: e.hours.map(Number),
          description: e.description,
          status: e.status,
          managerComment: e.manager_comment ?? undefined,
          originalHours: e.original_hours?.map(Number),
          reviewedBy: e.reviewed_by ?? undefined,
          reviewedAt: iso(e.reviewed_at),
        }),
      ),
    history: events.rows
      .filter((h) => h.timesheet_id === t.id)
      .map((h) => compact<ApprovalEvent>({ id: h.id, at: h.at.toISOString(), actorId: h.actor_id, action: h.action, projectId: h.project_id ?? undefined, comment: h.comment ?? undefined })),
  }));
}

export const isEntryLocked = (status: EntryStatus): boolean => status === 'pending' || status === 'approved';
