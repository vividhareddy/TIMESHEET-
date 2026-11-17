/**
 * Leave requests. Hours are calculated from the employee's working calendar (Full Day = one daily
 * target, Half Day = half). Reviewed by the employee's reporting manager or an administrator.
 * Withdrawn requests are kept with status 'withdrawn' for history and are not returned by the API.
 */
import { Router } from 'express';
import { withTransaction } from '../mongo.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, assertId, assertValid, isISODate, str, uniqueViolation } from '../http.js';
import { loadCalendars, lockDoc, toLeave, type LeaveLean } from '../data.js';
import { EmployeeModel } from '../models/employee.js';
import { LeaveRequestModel } from '../models/requests.js';
import { directReportIds, visibleEmployeeIds } from '../scope.js';
import { isWorkingDay, leaveHours } from '../lib/workCalc.js';

export const leaveRouter = Router();
leaveRouter.use(requireAuth);

/** GET /api/leave-requests — own; managers also see direct reports and team; admins see all. */
leaveRouter.get('/', async (_req, res) => {
  const user = currentUser(res);
  const docs = await LeaveRequestModel.find({ organisationId: user.organisationId, status: { $ne: 'withdrawn' } }).sort({ date: -1, appliedOn: -1 }).lean<LeaveLean[]>();
  let list = docs.map(toLeave);
  if (user.systemRole === 'manager') {
    const [reports, scope] = await Promise.all([directReportIds(user), visibleEmployeeIds(user)]);
    list = list.filter((l) => l.employeeId === user.id || reports.has(l.employeeId) || (scope !== 'all' && scope.has(l.employeeId)));
  } else if (user.systemRole === 'associate') {
    list = list.filter((l) => l.employeeId === user.id);
  }
  res.json(list);
});

/** POST /api/leave-requests — { date, duration: 'full' | 'half', reason } */
leaveRouter.post('/', async (req, res) => {
  const user = currentUser(res);
  const date = str(req.body?.date);
  const duration = str(req.body?.duration) as 'full' | 'half';
  const reason = str(req.body?.reason);
  const errors: Record<string, string> = {};
  if (!isISODate(date)) errors.date = 'Leave date is required.';
  if (duration !== 'full' && duration !== 'half') errors.duration = 'Leave duration must be Full Day or Half Day.';
  if (!reason) errors.reason = 'Reason is required.';
  else if (reason.length > 1000) errors.reason = 'Use at most 1000 characters.';
  assertValid(errors);

  const calendar = (await loadCalendars(user.organisationId)).get(user.calendarId);
  if (!calendar) throw new HttpError(400, 'No holiday calendar is assigned to you yet. Contact your administrator.');
  if (!isWorkingDay(calendar, date)) {
    throw new HttpError(400, 'The selected date is a weekend or holiday on your calendar — no leave is required.', { date: 'Not a working day on your calendar.' });
  }
  const hours = leaveHours(user, calendar, duration);
  try {
    const doc = await LeaveRequestModel.create({ organisationId: user.organisationId, employeeId: user.id, date, duration, hours, reason });
    res.status(201).json(toLeave(doc.toObject() as unknown as LeaveLean));
  } catch (err) {
    // The partial unique index allows only one pending / approved request per employee per day.
    if (uniqueViolation(err) !== null) throw new HttpError(409, 'You already have a leave request for this date.', { date: 'A request already exists for this date.' });
    throw err;
  }
});

/** POST /api/leave-requests/:id/review — { status: 'approved' | 'rejected', comment? } */
leaveRouter.post('/:id/review', requireRole('admin', 'manager'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Leave request');
  const status = str(req.body?.status);
  const comment = str(req.body?.comment) || null;
  if (status !== 'approved' && status !== 'rejected') throw new HttpError(400, 'Invalid status.');
  if (status === 'rejected' && !comment) throw new HttpError(400, 'Add a comment when rejecting leave.', { comment: 'Required.' });

  const row = await withTransaction(async (session) => {
    const leave = await lockDoc<LeaveLean>(LeaveRequestModel, { organisationId: user.organisationId, _id: id, status: { $ne: 'withdrawn' } }, session);
    if (!leave) throw new HttpError(404, 'Leave request not found.');
    const employee = await EmployeeModel.findById(leave.employeeId).select('managerId').session(session).lean<{ managerId?: string | null }>();
    if (user.systemRole !== 'admin' && employee?.managerId !== user.id) throw new HttpError(403, 'Only the reporting manager or an administrator can review this request.');
    if (leave.status !== 'pending') throw new HttpError(409, 'This request has already been reviewed.');
    const updated = await LeaveRequestModel.findOneAndUpdate(
      { _id: id },
      { $set: { status, reviewerId: user.id, reviewerComment: comment, reviewedAt: new Date() } },
      { session, returnDocument: 'after' },
    ).lean<LeaveLean>();
    return updated!;
  });
  res.json(toLeave(row));
});

/** DELETE /api/leave-requests/:id — the employee withdraws their own pending request (kept as 'withdrawn'). */
leaveRouter.delete('/:id', async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Leave request');
  await withTransaction(async (session) => {
    const leave = await lockDoc<LeaveLean>(LeaveRequestModel, { organisationId: user.organisationId, _id: id, status: { $ne: 'withdrawn' } }, session);
    if (!leave) throw new HttpError(404, 'Leave request not found.');
    if (leave.employeeId !== user.id) throw new HttpError(403, 'You can only withdraw your own leave requests.');
    if (leave.status !== 'pending') throw new HttpError(409, 'Only pending requests can be withdrawn.');
    await LeaveRequestModel.updateOne({ _id: id }, { $set: { status: 'withdrawn', reviewedAt: new Date() } }).session(session);
  });
  res.status(204).end();
});
