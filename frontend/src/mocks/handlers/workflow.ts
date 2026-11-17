/** Timesheet, approval, leave and overtime workflows — the rules the Express backend must enforce. */
import type { ApprovalEvent, Employee, LeaveRequest, OvertimeRequest, Timesheet, TimesheetEntry } from '@/types';
import type { ApprovalItem, LeaveApplyRequest, ModifyHoursRequest, OvertimeCreateRequest, ReviewRequest, SaveTimesheetRequest } from '@/types/api';
import { currentWeekStart, startOfWeek } from '@/utils/date';
import { sum } from '@/utils/format';
import { allocationsForWeek, computeOvertime, entryTotal, expectedWeekHours, isEntryLocked, isWorkingDay, leaveHours, timesheetTotal } from '@/utils/timesheet';
import { badRequest, conflict, forbidden, newId, notFound, required, route } from '../http';
import { calendarOf, canSee, db, managedProjectIds, visibleEmployeeIds } from './scope';
import { overtimeEligibility } from '@/utils/overtime';

const nowIso = () => new Date().toISOString();

function findTimesheet(id: string): Timesheet {
  const ts = db().timesheets.find((t) => t.id === id);
  if (!ts) throw notFound('Timesheet');
  return ts;
}

function employeeOf(id: string): Employee {
  const e = db().employees.find((x) => x.id === id);
  if (!e) throw notFound('Employee');
  return e;
}

/** Keep auto-flagged overtime records in sync with submitted hours. */
function syncOvertime(ts: Timesheet): void {
  const { policy } = db();
  if (!policy.enabled || !policy.autoFlag) return;
  const emp = employeeOf(ts.employeeId);
  if (!overtimeEligibility(emp, policy).eligible) return;
  const breakdown = computeOvertime(ts.entries.filter((e) => e.status !== 'draft'), ts.weekStart, calendarOf(emp), policy);
  for (const [projectId, hours] of Object.entries(breakdown.byProject)) {
    const existing = db().overtime.find((o) => o.timesheetId === ts.id && o.projectId === projectId && o.source === 'timesheet');
    if (existing) {
      if (existing.status === 'pending') existing.hours = hours;
      continue;
    }
    db().overtime.push({
      id: newId('ot'),
      employeeId: ts.employeeId,
      projectId,
      weekStart: ts.weekStart,
      hours,
      reason: 'Additional hours flagged automatically from the submitted timesheet.',
      source: 'timesheet',
      status: 'pending',
      createdAt: nowIso(),
      timesheetId: ts.id,
    });
  }
  db().overtime = db().overtime.filter(
    (o) => !(o.timesheetId === ts.id && o.source === 'timesheet' && o.status === 'pending' && !breakdown.byProject[o.projectId]),
  );
}

function validateHours(hours: unknown, increment: number): number[] {
  if (!Array.isArray(hours) || hours.length !== 7) throw badRequest('Each entry needs 7 daily values (Monday–Sunday).');
  return hours.map((h) => {
    const v = Number(h);
    if (!Number.isFinite(v) || v < 0 || v > 24) throw badRequest('Daily hours must be between 0 and 24.');
    if (Math.abs(v / increment - Math.round(v / increment)) > 1e-9) throw badRequest(`Hours must be in ${increment}-hour increments.`);
    return v;
  });
}

function saveOwnTimesheet(user: Employee, body: SaveTimesheetRequest, submit: boolean): Timesheet {
  required(body as unknown as Record<string, unknown>, { weekStart: 'Week' });
  const weekStart = startOfWeek(body.weekStart);
  const { settings } = db();
  const existing = db().timesheets.find((t) => t.employeeId === user.id && t.weekStart === weekStart);
  const allowedProjects = new Set([
    ...allocationsForWeek(db().allocations, user.id, weekStart).map((a) => a.projectId),
    ...(existing?.entries.map((e) => e.projectId) ?? []),
  ]);

  const entries: TimesheetEntry[] = (body.entries ?? []).map((input) => {
    if (!allowedProjects.has(input.projectId)) throw forbidden('You can only record time on projects you are allocated to for this week.');
    const prev = existing?.entries.find((e) => e.projectId === input.projectId);
    if (prev && isEntryLocked(prev.status)) return prev; // locked entries are never changed by the employee
    const hours = validateHours(input.hours, settings.hourIncrement);
    if (!settings.allowWeekendEntry && hours[5] + hours[6] > 0) throw badRequest('Weekend entries are not allowed by your organisation.');
    return { ...prev, projectId: input.projectId, hours, description: String(input.description ?? '').trim(), status: prev?.status ?? 'draft' };
  });
  // Locked entries omitted from the payload are preserved.
  for (const prev of existing?.entries ?? []) if (isEntryLocked(prev.status) && !entries.some((e) => e.projectId === prev.projectId)) entries.push(prev);

  const daily = Array.from({ length: 7 }, (_, i) => sum(entries.map((e) => e.hours[i])));
  if (daily.some((d) => d > 24)) throw badRequest('A day cannot exceed 24 hours in total.');

  if (submit) {
    if (weekStart > currentWeekStart()) throw badRequest('Future weeks can only be saved as a draft.');
    const editable = entries.filter((e) => !isEntryLocked(e.status));
    if (!editable.length) throw conflict('All entries for this week are already submitted.');
    if (sum(editable.map(entryTotal)) <= 0) throw badRequest('Enter your project hours before submitting.');
    if (settings.requireDescription) {
      const missing = editable.find((e) => entryTotal(e) > 0 && !e.description);
      if (missing) {
        const name = db().projects.find((p) => p.id === missing.projectId)?.name ?? 'a project';
        throw badRequest(`Add a work description for ${name} before submitting.`, { [missing.projectId]: 'Description required.' });
      }
    }
    for (const e of editable) {
      e.status = 'pending';
    }
  }

  const wasSubmitted = existing?.entries.some((e) => e.status !== 'draft') ?? false;
  const event: ApprovalEvent = {
    id: newId('evt'),
    at: nowIso(),
    actorId: user.id,
    action: submit ? (wasSubmitted ? 'resubmitted' : 'submitted') : 'saved',
    comment: submit ? (wasSubmitted ? 'Corrections made and timesheet resubmitted.' : 'Weekly timesheet submitted.') : 'Draft saved.',
  };
  const ts: Timesheet = {
    id: existing?.id ?? newId('ts'),
    employeeId: user.id,
    weekStart,
    entries,
    submittedAt: submit ? nowIso() : existing?.submittedAt,
    updatedAt: nowIso(),
    history: [...(existing?.history ?? []).filter((h) => !(h.action === 'saved' && event.action === 'saved')), event],
  };
  if (existing) Object.assign(existing, ts);
  else db().timesheets.push(ts);
  if (submit) syncOvertime(ts);
  return ts;
}

// ----------------------------------------------------------------- approvals

function approvableProjects(user: Employee): Set<string> | 'all' {
  return user.systemRole === 'admin' ? 'all' : managedProjectIds(user);
}

function assertCanApprove(user: Employee, projectId: string) {
  const scope = approvableProjects(user);
  if (scope !== 'all' && !scope.has(projectId)) throw forbidden('Only the project manager of this project can review these hours.');
}

function toApprovalItem(ts: Timesheet, entry: TimesheetEntry): ApprovalItem {
  const emp = employeeOf(ts.employeeId);
  const project = db().projects.find((p) => p.id === entry.projectId)!;
  const allocs = allocationsForWeek(db().allocations, emp.id, ts.weekStart);
  return {
    id: `${ts.id}|${entry.projectId}`,
    timesheetId: ts.id,
    weekStart: ts.weekStart,
    employee: { id: emp.id, name: emp.name, designation: emp.designation, weeklyCapacity: emp.weeklyCapacity, calendarId: emp.calendarId },
    project: { id: project.id, name: project.name, color: project.color },
    entry,
    total: entryTotal(entry),
    allocation: allocs.find((a) => a.projectId === entry.projectId) ?? null,
    timesheetTotal: timesheetTotal(ts),
    expectedHours: expectedWeekHours(emp, calendarOf(emp), db().leaves, ts.weekStart),
    weekAllocatedHours: sum(allocs.map((a) => a.weeklyHours)),
    weekAllocationCount: allocs.length,
    history: ts.history.filter((h) => !h.projectId || h.projectId === entry.projectId),
  };
}

function findEntry(timesheetId: string, projectId: string) {
  const ts = findTimesheet(timesheetId);
  const entry = ts.entries.find((e) => e.projectId === projectId);
  if (!entry) throw notFound('Timesheet entry');
  return { ts, entry };
}

// --------------------------------------------------------------------- leave

function canReviewLeave(user: Employee, leave: LeaveRequest): boolean {
  if (user.systemRole === 'admin') return true;
  return employeeOf(leave.employeeId).managerId === user.id;
}

// ------------------------------------------------------------------ overtime

function canReviewOvertime(user: Employee, ot: OvertimeRequest): boolean {
  if (user.systemRole === 'admin') return true;
  const { approver } = db().policy;
  if (approver === 'project_manager') return managedProjectIds(user).has(ot.projectId);
  if (approver === 'reporting_manager') return employeeOf(ot.employeeId).managerId === user.id;
  return false;
}

export const workflowRoutes = [
  // --------------------------------------------------------------- timesheets
  route('GET', '/timesheets', (req) => {
    const scope = visibleEmployeeIds(req.user!);
    return db().timesheets.filter(
      (t) => canSee(scope, t.employeeId) && (!req.query.employeeId || t.employeeId === req.query.employeeId) && (!req.query.weekStart || t.weekStart === req.query.weekStart),
    );
  }),
  route('GET', '/timesheets/:id', (req) => {
    const ts = findTimesheet(req.params.id);
    if (!canSee(visibleEmployeeIds(req.user!), ts.employeeId)) throw forbidden();
    return ts;
  }),
  route('PUT', '/timesheets/me/draft', (req) => saveOwnTimesheet(req.user!, req.body, false)),
  route('POST', '/timesheets/me/submit', (req) => saveOwnTimesheet(req.user!, req.body, true)),
  route('POST', '/timesheets/:id/reopen', (req) => {
    required(req.body, { reason: 'Reason' });
    const ts = findTimesheet(req.params.id);
    if (ts.entries.every((e) => e.status === 'draft')) throw conflict('This timesheet has not been submitted.');
    ts.entries = ts.entries.map((e) => ({ ...e, status: 'returned', managerComment: String(req.body.reason).trim() }));
    ts.history.push({ id: newId('evt'), at: nowIso(), actorId: req.user!.id, action: 'reopened', comment: String(req.body.reason).trim() });
    ts.updatedAt = nowIso();
    return ts;
  }, { roles: ['admin'] }),

  // ---------------------------------------------------------------- approvals
  route('GET', '/approvals', (req) => {
    const scope = approvableProjects(req.user!);
    const status = req.query.status ?? 'pending';
    const items: ApprovalItem[] = [];
    for (const ts of db().timesheets) {
      if (req.query.weekStart && ts.weekStart !== req.query.weekStart) continue;
      for (const entry of ts.entries) {
        if (entry.status === 'draft') continue;
        if (scope !== 'all' && !scope.has(entry.projectId)) continue;
        if (req.query.projectId && entry.projectId !== req.query.projectId) continue;
        if (status !== 'all' && entry.status !== status) continue;
        items.push(toApprovalItem(ts, entry));
      }
    }
    return items.sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.employee.name.localeCompare(b.employee.name));
  }, { roles: ['admin', 'manager'] }),

  route('POST', '/approvals/review', (req) => {
    const body = req.body as ReviewRequest;
    if (!['approved', 'rejected', 'returned'].includes(body.action)) throw badRequest('Unknown review action.');
    if (!body.items?.length) throw badRequest('Select at least one entry.');
    const comment = body.comment?.trim();
    if (body.action !== 'approved' && !comment) throw badRequest('A comment is required.', { comment: 'A comment is required.' });
    // Validate everything first so the batch is all-or-nothing.
    const targets = body.items.map(({ timesheetId, projectId }) => {
      const { ts, entry } = findEntry(timesheetId, projectId);
      assertCanApprove(req.user!, projectId);
      if (entry.status !== 'pending') throw conflict('One or more entries are no longer pending. Refresh and try again.');
      return { ts, entry };
    });
    for (const { ts, entry } of targets) {
      entry.status = body.action;
      entry.reviewedBy = req.user!.id;
      entry.reviewedAt = nowIso();
      if (comment) entry.managerComment = comment;
      ts.history.push({ id: newId('evt'), at: nowIso(), actorId: req.user!.id, action: body.action, projectId: entry.projectId, comment });
      ts.updatedAt = nowIso();
      // Rejecting hours also rejects their auto-flagged overtime.
      if (body.action === 'rejected') {
        db().overtime.filter((o) => o.timesheetId === ts.id && o.projectId === entry.projectId && o.status === 'pending').forEach((o) => {
          o.status = 'rejected';
          o.reviewerId = req.user!.id;
          o.reviewerComment = 'Underlying timesheet hours were rejected.';
        });
      }
    }
    return { updated: targets.length };
  }, { roles: ['admin', 'manager'] }),

  route('POST', '/approvals/modify', (req) => {
    const body = req.body as ModifyHoursRequest;
    if (!body.reason?.trim()) throw badRequest('A reason is required to modify hours.', { reason: 'A reason is required to modify hours.' });
    const { ts, entry } = findEntry(body.timesheetId, body.projectId);
    assertCanApprove(req.user!, body.projectId);
    if (entry.status !== 'pending') throw conflict('Only pending entries can be modified.');
    const hours = validateHours(body.hours, db().settings.hourIncrement);
    entry.originalHours = entry.originalHours ?? entry.hours;
    entry.hours = hours;
    entry.managerComment = body.reason.trim();
    ts.history.push({ id: newId('evt'), at: nowIso(), actorId: req.user!.id, action: 'modified', projectId: entry.projectId, comment: body.reason.trim() });
    ts.updatedAt = nowIso();
    syncOvertime(ts);
    return ts;
  }, { roles: ['admin', 'manager'] }),

  // -------------------------------------------------------------------- leave
  route('GET', '/leave-requests', (req) => {
    const user = req.user!;
    if (user.systemRole === 'admin') return db().leaves;
    if (user.systemRole === 'manager') {
      const reports = new Set(db().employees.filter((e) => e.managerId === user.id).map((e) => e.id));
      const scope = visibleEmployeeIds(user);
      return db().leaves.filter((l) => l.employeeId === user.id || reports.has(l.employeeId) || canSee(scope, l.employeeId));
    }
    return db().leaves.filter((l) => l.employeeId === user.id);
  }),
  route('POST', '/leave-requests', (req) => {
    const body = req.body as LeaveApplyRequest;
    required(body as unknown as Record<string, unknown>, { date: 'Leave date', duration: 'Leave duration', reason: 'Reason' });
    if (!['full', 'half'].includes(body.duration)) throw badRequest('Leave duration must be Full Day or Half Day.');
    const emp = req.user!;
    const cal = calendarOf(emp);
    if (!cal) throw badRequest('No holiday calendar is assigned to you yet. Contact your administrator.');
    if (!isWorkingDay(cal, body.date)) throw badRequest('The selected date is a weekend or holiday on your calendar — no leave is required.', { date: 'Not a working day on your calendar.' });
    if (db().leaves.some((l) => l.employeeId === emp.id && l.date === body.date && l.status !== 'rejected')) throw conflict('You already have a leave request for this date.', { date: 'A request already exists for this date.' });
    const leave: LeaveRequest = {
      id: newId('lv'),
      employeeId: emp.id,
      date: body.date,
      duration: body.duration,
      hours: leaveHours(emp, cal, body.duration),
      reason: body.reason.trim(),
      status: 'pending',
      appliedOn: nowIso(),
    };
    db().leaves.push(leave);
    return leave;
  }),
  route('POST', '/leave-requests/:id/review', (req) => {
    const leave = db().leaves.find((l) => l.id === req.params.id);
    if (!leave) throw notFound('Leave request');
    if (!canReviewLeave(req.user!, leave)) throw forbidden('Only the reporting manager or an administrator can review this request.');
    if (leave.status !== 'pending') throw conflict('This request has already been reviewed.');
    const status = req.body.status;
    if (status !== 'approved' && status !== 'rejected') throw badRequest('Invalid status.');
    if (status === 'rejected' && !req.body.comment?.trim()) throw badRequest('Add a comment when rejecting leave.', { comment: 'Required.' });
    Object.assign(leave, { status, reviewerId: req.user!.id, reviewerComment: req.body.comment?.trim() || undefined });
    return leave;
  }, { roles: ['admin', 'manager'] }),
  route('DELETE', '/leave-requests/:id', (req) => {
    const leave = db().leaves.find((l) => l.id === req.params.id);
    if (!leave) throw notFound('Leave request');
    if (leave.employeeId !== req.user!.id) throw forbidden();
    if (leave.status !== 'pending') throw conflict('Only pending requests can be withdrawn.');
    db().leaves = db().leaves.filter((l) => l.id !== leave.id);
  }),

  // ----------------------------------------------------------------- overtime
  route('GET', '/overtime-requests/eligibility', (req) => overtimeEligibility(req.user!, db().policy)),
  route('GET', '/overtime-requests', (req) => {
    const user = req.user!;
    if (user.systemRole === 'admin') return db().overtime;
    if (user.systemRole === 'manager') {
      const projects = managedProjectIds(user);
      const reports = new Set(db().employees.filter((e) => e.managerId === user.id).map((e) => e.id));
      return db().overtime.filter((o) => o.employeeId === user.id || projects.has(o.projectId) || reports.has(o.employeeId));
    }
    return db().overtime.filter((o) => o.employeeId === user.id);
  }),
  route('POST', '/overtime-requests', (req) => {
    const body = req.body as OvertimeCreateRequest;
    required(body as unknown as Record<string, unknown>, { projectId: 'Project', date: 'Date', reason: 'Business reason' });
    const eligibility = overtimeEligibility(req.user!, db().policy);
    if (!eligibility.eligible) throw forbidden(`You are not eligible for overtime. ${eligibility.reason}`);
    const weekStart = startOfWeek(body.date);
    if (!allocationsForWeek(db().allocations, req.user!.id, weekStart).some((a) => a.projectId === body.projectId)) {
      throw badRequest('You are not allocated to this project in that week.', { projectId: 'Select a project you are allocated to.' });
    }
    const max = db().policy.maxWeeklyOvertime;
    if (!(body.hours >= 0.5 && body.hours <= max) || (body.hours * 2) % 1 !== 0) throw badRequest(`Enter between 0.5 and ${max} hours in 0.5-hour increments.`, { hours: 'Invalid hours.' });
    const ot: OvertimeRequest = {
      id: newId('ot'),
      employeeId: req.user!.id,
      projectId: body.projectId,
      weekStart,
      date: body.date,
      hours: body.hours,
      reason: body.reason.trim(),
      source: 'pre_approval',
      status: 'pending',
      createdAt: nowIso(),
    };
    db().overtime.push(ot);
    return ot;
  }),
  route('POST', '/overtime-requests/:id/review', (req) => {
    const ot = db().overtime.find((o) => o.id === req.params.id);
    if (!ot) throw notFound('Overtime request');
    if (!canReviewOvertime(req.user!, ot)) throw forbidden('You are not the configured approver for this overtime.');
    if (ot.status !== 'pending') throw conflict('This request has already been reviewed.');
    const status = req.body.status;
    if (status !== 'approved' && status !== 'rejected') throw badRequest('Invalid status.');
    if (status === 'rejected' && !req.body.comment?.trim()) throw badRequest('Add a comment when rejecting overtime.', { comment: 'Required.' });
    Object.assign(ot, { status, reviewerId: req.user!.id, reviewerComment: req.body.comment?.trim() || undefined });
    return ot;
  }, { roles: ['admin', 'manager'] }),
];

