/**
 * Pure PostgreSQL row → MongoDB document transforms used by the migration script.
 *
 * Row shapes are what node-postgres returns for the queries in migratePgToMongo.ts:
 * uuid → string, numeric → string, numeric[] → string[], smallint[] → number[], jsonb → object,
 * timestamptz → Date, and calendar dates are selected with to_char(…, 'YYYY-MM-DD') so they arrive
 * as strings. Every document keeps the original UUID as its _id.
 */

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, unknown> & { _id: string };

const num = (v: unknown): number => Number(v);
const nums = (v: unknown): number[] => (v as unknown[]).map(Number);
const orNull = <T>(v: T | null | undefined): T | null => v ?? null;
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export const organisation = (r: Row): Doc => ({
  _id: r.id,
  name: r.name,
  settings: r.settings ?? {},
  overtimePolicy: r.overtime_policy ?? {},
  createdAt: r.created_at,
  __v: 0,
});

export const department = (r: Row): Doc => ({ _id: r.id, organisationId: r.organisation_id, name: r.name, __v: 0 });

export const workLocation = (r: Row): Doc => ({
  _id: r.id,
  organisationId: r.organisation_id,
  name: r.name,
  country: text(r.country),
  defaultCalendarId: orNull(r.default_calendar_id),
  __v: 0,
});

export const calendar = (r: Row): Doc => ({
  _id: r.id,
  organisationId: r.organisation_id,
  name: r.name,
  country: text(r.country),
  timezone: r.timezone,
  workingDays: nums(r.working_days),
  hoursPerDay: num(r.hours_per_day),
  createdAt: r.created_at,
  __v: 0,
});

export const holiday = (r: Row): Doc => ({ _id: r.id, calendarId: r.calendar_id, date: r.date, name: r.name, type: r.type, __v: 0 });

export const employee = (r: Row): Doc => ({
  _id: r.id,
  organisationId: r.organisation_id,
  employeeCode: r.employee_code,
  name: r.name,
  // PostgreSQL enforced uniqueness on lower(email); MongoDB stores the email lower-cased.
  email: String(r.email).toLowerCase(),
  // bcrypt hashes are copied verbatim, so every existing password keeps working.
  passwordHash: r.password_hash,
  phone: r.phone ?? '',
  department: r.department ?? '',
  designation: r.designation ?? '',
  workLocation: r.work_location ?? '',
  country: text(r.country) || 'US',
  calendarId: orNull(r.calendar_id),
  managerId: orNull(r.manager_id),
  systemRole: r.system_role,
  status: r.status,
  weeklyCapacity: num(r.weekly_capacity),
  joinDate: r.join_date,
  lastLoginAt: orNull(r.last_login_at),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  __v: 0,
});

export const project = (r: Row): Doc => ({
  _id: r.id,
  organisationId: r.organisation_id,
  // PostgreSQL enforced uniqueness on upper(code); MongoDB stores the code upper-cased.
  code: String(r.code).toUpperCase(),
  name: r.name,
  client: r.client,
  description: r.description ?? '',
  managerId: r.manager_id,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
  billable: r.billable,
  color: text(r.color),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  __v: 0,
});

export const allocation = (r: Row): Doc => ({
  _id: r.id,
  organisationId: r.organisation_id,
  employeeId: r.employee_id,
  projectId: r.project_id,
  projectRole: r.project_role,
  weeklyHours: num(r.weekly_hours),
  startDate: r.start_date,
  endDate: r.end_date,
  createdBy: orNull(r.created_by),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  __v: 0,
});

/** timesheet_entries rows become the timesheet's embedded `entries` array, in display order. */
export function timesheet(r: Row, entryRows: Row[]): Doc {
  const entries = [...entryRows]
    .sort((a, b) => Number(a.position) - Number(b.position) || String(a.project_id).localeCompare(String(b.project_id)))
    .map((e) => ({
      projectId: e.project_id,
      hours: nums(e.hours),
      ...(e.original_hours ? { originalHours: nums(e.original_hours) } : {}),
      description: e.description ?? '',
      status: e.status,
      managerComment: orNull(e.manager_comment),
      reviewedBy: orNull(e.reviewed_by),
      reviewedAt: orNull(e.reviewed_at),
      updatedAt: e.updated_at,
    }));
  return {
    _id: r.id,
    organisationId: r.organisation_id,
    employeeId: r.employee_id,
    weekStart: r.week_start,
    submittedAt: orNull(r.submitted_at),
    entries,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    __v: 0,
  };
}

export const timesheetEvent = (r: Row): Doc => ({
  _id: r.id,
  timesheetId: r.timesheet_id,
  at: r.at,
  actorId: r.actor_id,
  action: r.action,
  projectId: orNull(r.project_id),
  comment: orNull(r.comment),
  __v: 0,
});

export const leaveRequest = (r: Row): Doc => ({
  _id: r.id,
  organisationId: r.organisation_id,
  employeeId: r.employee_id,
  date: r.date,
  duration: r.duration,
  hours: num(r.hours),
  reason: r.reason,
  status: r.status,
  appliedOn: r.applied_on,
  reviewerId: orNull(r.reviewer_id),
  reviewerComment: orNull(r.reviewer_comment),
  reviewedAt: orNull(r.reviewed_at),
  __v: 0,
});

export const overtimeRequest = (r: Row): Doc => ({
  _id: r.id,
  organisationId: r.organisation_id,
  employeeId: r.employee_id,
  projectId: r.project_id,
  weekStart: r.week_start,
  date: orNull(r.date),
  hours: num(r.hours),
  reason: r.reason,
  source: r.source,
  status: r.status,
  timesheetId: orNull(r.timesheet_id),
  createdAt: r.created_at,
  reviewerId: orNull(r.reviewer_id),
  reviewerComment: orNull(r.reviewer_comment),
  reviewedAt: orNull(r.reviewed_at),
  __v: 0,
});

export const revokedToken = (r: Row): Doc => ({ _id: r.jti, expiresAt: r.expires_at, __v: 0 });
