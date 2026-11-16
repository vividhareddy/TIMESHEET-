/**
 * Leave requests. Hours are calculated from the employee's working calendar (Full Day = one daily
 * target, Half Day = half). Reviewed by the employee's reporting manager or an administrator.
 * Withdrawn requests are kept with status 'withdrawn' for history and are not returned by the API.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, assertId, assertValid, isISODate, str, uniqueViolation } from '../http.js';
import { LEAVE_COLUMNS, loadCalendars, toLeave, type LeaveRow } from '../data.js';
import { directReportIds, visibleEmployeeIds } from '../scope.js';
import { isWorkingDay, leaveHours } from '../lib/workCalc.js';

export const leaveRouter = Router();
leaveRouter.use(requireAuth);

/** GET /api/leave-requests — own; managers also see direct reports and team; admins see all. */
leaveRouter.get('/', async (_req, res) => {
  const user = currentUser(res);
  const { rows } = await pool.query<LeaveRow>(
    `SELECT ${LEAVE_COLUMNS} FROM leave_requests WHERE organisation_id = $1 AND status <> 'withdrawn' ORDER BY date DESC, applied_on DESC`,
    [user.organisationId],
  );
  let list = rows.map(toLeave);
  if (user.systemRole === 'manager') {
    const [reports, scope] = await Promise.all([directReportIds(pool, user), visibleEmployeeIds(pool, user)]);
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
  const duration = str(req.body?.duration);
  const reason = str(req.body?.reason);
  const errors: Record<string, string> = {};
  if (!isISODate(date)) errors.date = 'Leave date is required.';
  if (duration !== 'full' && duration !== 'half') errors.duration = 'Leave duration must be Full Day or Half Day.';
  if (!reason) errors.reason = 'Reason is required.';
  else if (reason.length > 1000) errors.reason = 'Use at most 1000 characters.';
  assertValid(errors);

  const calendar = (await loadCalendars(pool, user.organisationId)).get(user.calendarId);
  if (!calendar) throw new HttpError(400, 'No holiday calendar is assigned to you yet. Contact your administrator.');
  if (!isWorkingDay(calendar, date)) {
    throw new HttpError(400, 'The selected date is a weekend or holiday on your calendar — no leave is required.', { date: 'Not a working day on your calendar.' });
  }
  const hours = leaveHours(user, calendar, duration as 'full' | 'half');
  try {
    const { rows } = await pool.query<LeaveRow>(
      `INSERT INTO leave_requests (organisation_id, employee_id, date, duration, hours, reason) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${LEAVE_COLUMNS}`,
      [user.organisationId, user.id, date, duration, hours, reason],
    );
    res.status(201).json(toLeave(rows[0]!));
  } catch (err) {
    if (uniqueViolation(err)) throw new HttpError(409, 'You already have a leave request for this date.', { date: 'A request already exists for this date.' });
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

  const row = await withTransaction(async (db) => {
    const { rows } = await db.query<{ status: string; employee_id: string; manager_id: string | null }>(
      `SELECT l.status, l.employee_id, e.manager_id FROM leave_requests l JOIN employees e ON e.id = l.employee_id
        WHERE l.organisation_id = $1 AND l.id = $2 AND l.status <> 'withdrawn' FOR UPDATE OF l`,
      [user.organisationId, id],
    );
    const leave = rows[0];
    if (!leave) throw new HttpError(404, 'Leave request not found.');
    if (user.systemRole !== 'admin' && leave.manager_id !== user.id) throw new HttpError(403, 'Only the reporting manager or an administrator can review this request.');
    if (leave.status !== 'pending') throw new HttpError(409, 'This request has already been reviewed.');
    const updated = await db.query<LeaveRow>(
      `UPDATE leave_requests SET status = $2, reviewer_id = $3, reviewer_comment = $4, reviewed_at = now() WHERE id = $1 RETURNING ${LEAVE_COLUMNS}`,
      [id, status, user.id, comment],
    );
    return updated.rows[0]!;
  });
  res.json(toLeave(row));
});

/** DELETE /api/leave-requests/:id — the employee withdraws their own pending request (kept as 'withdrawn'). */
leaveRouter.delete('/:id', async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Leave request');
  await withTransaction(async (db) => {
    const { rows } = await db.query<{ status: string; employee_id: string }>(
      "SELECT status, employee_id FROM leave_requests WHERE organisation_id = $1 AND id = $2 AND status <> 'withdrawn' FOR UPDATE",
      [user.organisationId, id],
    );
    const leave = rows[0];
    if (!leave) throw new HttpError(404, 'Leave request not found.');
    if (leave.employee_id !== user.id) throw new HttpError(403, 'You can only withdraw your own leave requests.');
    if (leave.status !== 'pending') throw new HttpError(409, 'Only pending requests can be withdrawn.');
    await db.query("UPDATE leave_requests SET status = 'withdrawn', reviewed_at = now() WHERE id = $1", [id]);
  });
  res.status(204).end();
});
