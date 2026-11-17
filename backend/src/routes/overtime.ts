/**
 * Overtime requests — stored separately from ordinary timesheet hours. Records come from two sources:
 * 'timesheet' (flagged automatically on submission, see routes/timesheets.ts) and 'pre_approval'
 * (requested in advance here). The organisation's overtime policy decides eligibility and the approver.
 */
import { Router } from 'express';
import { withTransaction } from '../mongo.js';
import { currentUser, requireAuth, requireRole, type AuthUser } from '../auth.js';
import { HttpError, assertId, assertValid, isISODate, isUuid, str } from '../http.js';
import { loadAllocations, loadCalendars, lockDoc, toOvertime, type OvertimeLean } from '../data.js';
import { EmployeeModel } from '../models/employee.js';
import { Project } from '../models/project.js';
import { OvertimeRequestModel } from '../models/requests.js';
import { directReportIds, managedProjectIds } from '../scope.js';
import { readPolicy, readSettings, type OvertimePolicy } from './organisation.js';
import { startOfWeek, sum, weekday } from '../lib/dates.js';
import { findHoliday, isScheduledDay } from '../lib/workCalc.js';

export const overtimeRouter = Router();
overtimeRouter.use(requireAuth);

/** GET /api/overtime-requests — own; managers also their projects and direct reports; admins all. */
overtimeRouter.get('/', async (_req, res) => {
  const user = currentUser(res);
  const docs = await OvertimeRequestModel.find({ organisationId: user.organisationId }).sort({ weekStart: -1, createdAt: -1 }).lean<OvertimeLean[]>();
  let list = docs.map(toOvertime);
  if (user.systemRole === 'manager') {
    const [projects, reports] = await Promise.all([managedProjectIds(user), directReportIds(user)]);
    list = list.filter((o) => o.employeeId === user.id || projects.has(o.projectId) || reports.has(o.employeeId));
  } else if (user.systemRole === 'associate') {
    list = list.filter((o) => o.employeeId === user.id);
  }
  res.json(list);
});

/** POST /api/overtime-requests — pre-approval for planned additional hours: { projectId, date, hours, reason } */
overtimeRouter.post('/', async (req, res) => {
  const user = currentUser(res);
  const org = user.organisationId;
  const projectId = str(req.body?.projectId);
  const date = str(req.body?.date);
  const hours = Number(req.body?.hours);
  const reason = str(req.body?.reason);
  const [policy, settings] = await Promise.all([readPolicy(org), readSettings(org)]);
  const max = policy.maxWeeklyOvertime;

  const errors: Record<string, string> = {};
  if (!isUuid(projectId)) errors.projectId = 'Project is required.';
  if (!isISODate(date)) errors.date = 'Date is required.';
  if (!reason) errors.reason = 'Business reason is required.';
  else if (reason.length > 1000) errors.reason = 'Use at most 1000 characters.';
  if (!(hours >= 0.5 && hours <= max) || (hours * 2) % 1 !== 0) errors.hours = `Enter between 0.5 and ${max} hours in 0.5-hour increments.`;
  if (Object.keys(errors).length) throw new HttpError(400, errors.hours && Object.keys(errors).length === 1 ? errors.hours : 'Please correct the highlighted fields.', errors);
  if (!policy.enabled) throw new HttpError(400, 'Overtime is not enabled in your organisation’s overtime policy.');

  // Eligibility of the day under the policy and settings.
  const calendar = (await loadCalendars(org)).get(user.calendarId);
  const isWeekend = [0, 6].includes(weekday(date));
  if (isWeekend && !settings.allowWeekendEntry) throw new HttpError(400, 'Weekend work is not allowed by your organisation.', { date: 'Weekend work is not allowed.' });
  if (!isScheduledDay(calendar, date) && !policy.weekendApplicable) {
    throw new HttpError(400, 'Under the overtime policy, hours on non-working days are not eligible for overtime.', { date: 'Not eligible under the overtime policy.' });
  }
  if (findHoliday(calendar, date) && !policy.holidayApplicable) {
    throw new HttpError(400, 'Under the overtime policy, hours on public holidays are not eligible for overtime.', { date: 'Not eligible under the overtime policy.' });
  }

  const weekStart = startOfWeek(date);
  const allocated = (await loadAllocations(org, { from: date, to: date, employeeIds: [user.id] })).some((a) => a.projectId === projectId);
  if (!allocated) throw new HttpError(400, 'You are not allocated to this project on that date.', { projectId: 'Select a project you are allocated to.' });

  const row = await withTransaction(async (session) => {
    // Serialise this employee's requests so the weekly maximum cannot be exceeded by concurrent submissions.
    await lockDoc(EmployeeModel, { _id: user.id }, session);
    const used = await OvertimeRequestModel.find({ employeeId: user.id, weekStart, source: 'pre_approval', status: { $ne: 'rejected' } }).select('hours').session(session).lean<Array<{ hours: number }>>();
    const already = sum(used.map((u) => u.hours));
    if (already + hours > max) {
      throw new HttpError(400, `You have already requested ${already} h of overtime for this week; the weekly maximum is ${max} h.`, { hours: `At most ${max - already} h more this week.` });
    }
    const [doc] = await OvertimeRequestModel.create([{ organisationId: org, employeeId: user.id, projectId, weekStart, date, hours, reason, source: 'pre_approval' }], { session });
    return doc!.toObject() as unknown as OvertimeLean;
  });
  res.status(201).json(toOvertime(row));
});

/** Who may review: the configured approver (project manager / reporting manager) or an administrator. Never one's own request. */
function canReview(user: AuthUser, policy: OvertimePolicy, ot: { employeeId: string; projectManagerId: string | null; reportingManagerId: string | null }): boolean {
  if (user.systemRole === 'admin') return true;
  if (ot.employeeId === user.id) return false;
  if (policy.approver === 'project_manager') return ot.projectManagerId === user.id;
  if (policy.approver === 'reporting_manager') return ot.reportingManagerId === user.id;
  return false;
}

/** POST /api/overtime-requests/:id/review — { status: 'approved' | 'rejected', comment? } */
overtimeRouter.post('/:id/review', requireRole('admin', 'manager'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Overtime request');
  const status = str(req.body?.status);
  const comment = str(req.body?.comment) || null;
  if (status !== 'approved' && status !== 'rejected') throw new HttpError(400, 'Invalid status.');
  if (status === 'rejected' && !comment) throw new HttpError(400, 'Add a comment when rejecting overtime.', { comment: 'Required.' });
  assertValid(comment && comment.length > 1000 ? { comment: 'Use at most 1000 characters.' } : {});
  const policy = await readPolicy(user.organisationId);

  const row = await withTransaction(async (session) => {
    const ot = await lockDoc<OvertimeLean>(OvertimeRequestModel, { organisationId: user.organisationId, _id: id }, session);
    if (!ot) throw new HttpError(404, 'Overtime request not found.');
    // Sequential on purpose: a session cannot run operations in parallel inside a transaction.
    const project = await Project.findById(ot.projectId).select('managerId').session(session).lean<{ managerId: string }>();
    const employee = await EmployeeModel.findById(ot.employeeId).select('managerId').session(session).lean<{ managerId?: string | null }>();
    const context = { employeeId: ot.employeeId, projectManagerId: project?.managerId ?? null, reportingManagerId: employee?.managerId ?? null };
    if (!canReview(user, policy, context)) throw new HttpError(403, 'You are not the configured approver for this overtime.');
    if (ot.status !== 'pending') throw new HttpError(409, 'This request has already been reviewed.');
    const updated = await OvertimeRequestModel.findOneAndUpdate(
      { _id: id },
      { $set: { status, reviewerId: user.id, reviewerComment: comment, reviewedAt: new Date() } },
      { session, returnDocument: 'after' },
    ).lean<OvertimeLean>();
    return updated!;
  });
  res.json(toOvertime(row));
});
