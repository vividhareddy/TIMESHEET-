/** Shared loaders and document → API mappers for the operational modules (shapes match frontend/src/types). */
import type { ClientSession, Model } from 'mongoose';
import { EMPLOYEE_PUBLIC_FIELDS, EmployeeModel, employeeFromDoc, type Employee, type EmployeeLean } from './models/employee.js';
import { Calendar as CalendarModel, Holiday } from './models/calendar.js';
import { AllocationModel } from './models/project.js';
import { LeaveRequestModel } from './models/requests.js';
import { TimesheetEvent, TimesheetModel } from './models/timesheet.js';
import type { CalendarLike } from './lib/workCalc.js';

/** The transaction a query belongs to, or null / undefined when it runs on its own. */
export type Tx = ClientSession | null | undefined;

const iso = (d: Date | null | undefined): string | undefined => (d ? d.toISOString() : undefined);
/** Omits keys whose value is undefined or null (the frontend uses optional fields, not nulls). */
const compact = <T>(o: Record<string, unknown>): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

/**
 * Takes a write lock on one document for the rest of the transaction (the equivalent of
 * SELECT … FOR UPDATE) and returns it, or null when nothing matches. A concurrent transaction
 * touching the same document conflicts and is retried after this one finishes, so checks made
 * after locking cannot be invalidated by a parallel request.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function lockDoc<T>(model: Model<any>, filter: Record<string, unknown>, session: ClientSession): Promise<T | null> {
  return model.findOneAndUpdate(filter, { $inc: { __v: 1 } }, { session, returnDocument: 'after', timestamps: false }).lean<T>().exec();
}

// ---------------------------------------------------------------- employees

export async function loadEmployees(org: string, tx?: Tx): Promise<Map<string, Employee>> {
  const docs = await EmployeeModel.find({ organisationId: org }).select(EMPLOYEE_PUBLIC_FIELDS).session(tx ?? null).lean<EmployeeLean[]>();
  return new Map(docs.map((d) => [d._id, employeeFromDoc(d)]));
}

// ---------------------------------------------------------------- calendars

export type Calendar = CalendarLike & { id: string };

export async function loadCalendars(org: string, tx?: Tx): Promise<Map<string, Calendar>> {
  const calendars = await CalendarModel.find({ organisationId: org }).session(tx ?? null).lean();
  const holidays = await Holiday.find({ calendarId: { $in: calendars.map((c) => c._id) } }).session(tx ?? null).lean();
  return new Map(
    calendars.map((c) => [
      c._id,
      {
        id: c._id,
        workingDays: c.workingDays,
        hoursPerDay: c.hoursPerDay,
        holidays: holidays.filter((h) => h.calendarId === c._id).map((h) => ({ date: h.date, name: h.name, type: h.type })),
      },
    ]),
  );
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

export interface AllocationLean {
  _id: string;
  employeeId: string;
  projectId: string;
  projectRole: string;
  weeklyHours: number;
  startDate: string;
  endDate: string;
}

export const toAllocation = (d: AllocationLean): Allocation => ({
  id: d._id,
  employeeId: d.employeeId,
  projectId: d.projectId,
  projectRole: d.projectRole,
  weeklyHours: d.weeklyHours,
  startDate: d.startDate,
  endDate: d.endDate,
});

/** Allocations overlapping [from, to] (both optional). */
export async function loadAllocations(org: string, range?: { from?: string; to?: string; employeeIds?: string[] }, tx?: Tx): Promise<Allocation[]> {
  const filter: Record<string, unknown> = { organisationId: org };
  if (range?.from) filter.endDate = { $gte: range.from };
  if (range?.to) filter.startDate = { $lte: range.to };
  if (range?.employeeIds) filter.employeeId = { $in: range.employeeIds };
  const docs = await AllocationModel.find(filter).sort({ startDate: 1, _id: 1 }).session(tx ?? null).lean<AllocationLean[]>();
  return docs.map(toAllocation);
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

export interface LeaveLean {
  _id: string;
  employeeId: string;
  date: string;
  duration: 'full' | 'half';
  hours: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  appliedOn: Date;
  reviewerId?: string | null;
  reviewerComment?: string | null;
  reviewedAt?: Date | null;
}

export const toLeave = (d: LeaveLean): LeaveRequest =>
  compact<LeaveRequest>({
    id: d._id,
    employeeId: d.employeeId,
    date: d.date,
    duration: d.duration,
    hours: d.hours,
    reason: d.reason,
    status: d.status,
    appliedOn: d.appliedOn.toISOString(),
    reviewerId: d.reviewerId,
    reviewerComment: d.reviewerComment,
    reviewedAt: iso(d.reviewedAt),
  });

/** Approved leave in [from, to] — the only leave that reduces expected hours. */
export async function loadApprovedLeaves(org: string, from: string, to: string, tx?: Tx): Promise<LeaveRequest[]> {
  const docs = await LeaveRequestModel.find({ organisationId: org, status: 'approved', date: { $gte: from, $lte: to } }).session(tx ?? null).lean<LeaveLean[]>();
  return docs.map(toLeave);
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

export interface OvertimeLean {
  _id: string;
  employeeId: string;
  projectId: string;
  weekStart: string;
  date?: string | null;
  hours: number;
  reason: string;
  source: 'timesheet' | 'pre_approval';
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
  reviewerId?: string | null;
  reviewerComment?: string | null;
  reviewedAt?: Date | null;
  timesheetId?: string | null;
}

export const toOvertime = (d: OvertimeLean): OvertimeRequest =>
  compact<OvertimeRequest>({
    id: d._id,
    employeeId: d.employeeId,
    projectId: d.projectId,
    weekStart: d.weekStart,
    date: d.date,
    hours: d.hours,
    reason: d.reason,
    source: d.source,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    reviewerId: d.reviewerId,
    reviewerComment: d.reviewerComment,
    reviewedAt: iso(d.reviewedAt),
    timesheetId: d.timesheetId,
  });

// --------------------------------------------------------------- timesheets

export type EntryStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'returned';

export type EntryType = 'regular' | 'half_day' | 'overtime' | 'leave' | 'holiday';

export interface TimesheetEntry {
  projectId: string;
  hours: number[];
  /** Per-day label (Monday..Sunday), independent of the approval `status` below. */
  entryTypes: EntryType[];
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

/** A timesheet entry as stored (embedded in its timesheet document). */
export interface EntryLean {
  projectId: string;
  hours: number[];
  entryTypes?: EntryType[] | null;
  originalHours?: number[] | null;
  description?: string;
  status: EntryStatus;
  managerComment?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
  updatedAt?: Date;
}

export interface TimesheetLean {
  _id: string;
  organisationId: string;
  employeeId: string;
  weekStart: string;
  submittedAt?: Date | null;
  updatedAt: Date;
  entries: EntryLean[];
}

interface EventLean {
  _id: string;
  timesheetId: string;
  at: Date;
  actorId: string;
  action: string;
  projectId?: string | null;
  comment?: string | null;
}

export const toEntry = (e: EntryLean): TimesheetEntry =>
  compact<TimesheetEntry>({
    projectId: e.projectId,
    hours: e.hours,
    entryTypes: e.entryTypes?.length === 7 ? e.entryTypes : Array(7).fill('regular'),
    description: e.description ?? '',
    status: e.status,
    managerComment: e.managerComment,
    originalHours: e.originalHours?.length ? e.originalHours : undefined,
    reviewedBy: e.reviewedBy,
    reviewedAt: iso(e.reviewedAt),
  });

export interface TimesheetFilter {
  ids?: string[];
  employeeIds?: string[];
  weekStart?: string;
  from?: string;
  to?: string;
}

/** Loads timesheets (entries are embedded) and their history in two queries. */
export async function fetchTimesheets(org: string, f: TimesheetFilter = {}, tx?: Tx): Promise<Timesheet[]> {
  const filter: Record<string, unknown> = { organisationId: org };
  if (f.ids) filter._id = { $in: f.ids };
  if (f.employeeIds) filter.employeeId = { $in: f.employeeIds };
  if (f.weekStart) filter.weekStart = f.weekStart;
  else if (f.from || f.to) filter.weekStart = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };

  const sheets = await TimesheetModel.find(filter).sort({ weekStart: -1, employeeId: 1 }).session(tx ?? null).lean<TimesheetLean[]>();
  if (!sheets.length) return [];
  const events = await TimesheetEvent.find({ timesheetId: { $in: sheets.map((t) => t._id) } }).sort({ at: 1, _id: 1 }).session(tx ?? null).lean<EventLean[]>();
  const history = new Map<string, ApprovalEvent[]>();
  for (const h of events) {
    const list = history.get(h.timesheetId) ?? [];
    list.push(compact<ApprovalEvent>({ id: h._id, at: h.at.toISOString(), actorId: h.actorId, action: h.action, projectId: h.projectId, comment: h.comment }));
    history.set(h.timesheetId, list);
  }
  return sheets.map((t) => ({
    ...compact<Omit<Timesheet, 'entries' | 'history'>>({ id: t._id, employeeId: t.employeeId, weekStart: t.weekStart, submittedAt: iso(t.submittedAt), updatedAt: t.updatedAt.toISOString() }),
    entries: (t.entries ?? []).map(toEntry),
    history: history.get(t._id) ?? [],
  }));
}

/** Number of timesheet entries per status among the timesheets matching `match` and entries matching `entry`. */
export async function countEntriesByStatus(match: Record<string, unknown>, entry: Record<string, unknown> = {}): Promise<Map<EntryStatus, number>> {
  const prefixed = Object.fromEntries(Object.entries(entry).map(([k, v]) => [`entries.${k}`, v]));
  const rows = await TimesheetModel.aggregate<{ _id: EntryStatus; n: number }>([
    { $match: { ...match, ...(Object.keys(entry).length ? { entries: { $elemMatch: entry } } : {}) } },
    { $unwind: '$entries' },
    ...(Object.keys(prefixed).length ? [{ $match: prefixed }] : []),
    { $group: { _id: '$entries.status', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

export const isEntryLocked = (status: EntryStatus): boolean => status === 'pending' || status === 'approved';
