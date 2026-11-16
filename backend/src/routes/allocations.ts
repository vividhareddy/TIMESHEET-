/**
 * Resource allocations. Reads are scoped by role (associates: own; managers: their projects + team;
 * admins: all). Writes: administrators, or the project manager of the project.
 */
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../db.js';
import { currentUser, requireAuth, requireRole, type AuthUser } from '../auth.js';
import { HttpError, assertId, assertValid, isISODate, isUuid, str } from '../http.js';
import { ALLOCATION_COLUMNS, toAllocation, type AllocationRow } from '../data.js';
import { managedProjectIds, teamEmployeeIds } from '../scope.js';
import { addDays } from '../lib/dates.js';

interface AllocationInput {
  employeeId: string;
  projectId: string;
  projectRole: string;
  weeklyHours: number;
  startDate: string;
  endDate: string;
}

async function assertCanManageProject(db: PoolClient, user: AuthUser, projectId: string): Promise<void> {
  if (user.systemRole === 'admin') return;
  const { rowCount } = await db.query('SELECT 1 FROM projects WHERE organisation_id = $1 AND id = $2 AND manager_id = $3', [user.organisationId, projectId, user.id]);
  if (!rowCount) throw new HttpError(403, 'You can only allocate resources to projects you manage.');
}

/** First and last week (Monday) in which the employee recorded hours on the project within [from, to]. */
async function loggedWeeks(db: PoolClient, employeeId: string, projectId: string, from: string, to: string) {
  const { rows } = await db.query<{ first: string | null; last: string | null }>(
    `SELECT to_char(min(t.week_start), 'YYYY-MM-DD') AS first, to_char(max(t.week_start), 'YYYY-MM-DD') AS last
       FROM timesheet_entries e JOIN timesheets t ON t.id = e.timesheet_id
      WHERE t.employee_id = $1 AND e.project_id = $2 AND t.week_start BETWEEN ($3::date - 6) AND $4::date
        AND EXISTS (SELECT 1 FROM unnest(e.hours) h WHERE h > 0)`,
    [employeeId, projectId, from, to],
  );
  return rows[0] ?? { first: null, last: null };
}

/**
 * Validates an allocation. Runs inside a transaction holding a lock on the employee row, so two
 * concurrent requests cannot both create overlapping allocations.
 */
async function validateAllocation(db: PoolClient, user: AuthUser, body: unknown, id: string | null): Promise<AllocationInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const input: AllocationInput = {
    employeeId: str(b.employeeId),
    projectId: str(b.projectId),
    projectRole: str(b.projectRole) || 'Team member',
    weeklyHours: Number(b.weeklyHours),
    startDate: str(b.startDate),
    endDate: str(b.endDate),
  };
  const errors: Record<string, string> = {};
  const org = user.organisationId;

  if (!isUuid(input.projectId)) throw new HttpError(400, 'Please correct the highlighted fields.', { projectId: 'Select a project.' });
  await assertCanManageProject(db, user, input.projectId);

  const emp = isUuid(input.employeeId)
    ? (await db.query<{ status: string }>('SELECT status FROM employees WHERE organisation_id = $1 AND id = $2 FOR UPDATE', [org, input.employeeId])).rows[0]
    : undefined;
  if (!emp || emp.status !== 'active') errors.employeeId = 'Select an active employee.';

  const project = (
    await db.query<{ status: string; start_date: string; end_date: string }>(
      `SELECT status, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date FROM projects WHERE organisation_id = $1 AND id = $2`,
      [org, input.projectId],
    )
  ).rows[0];
  if (!project) errors.projectId = 'Select a project.';
  else if (project.status !== 'active' && !id) errors.projectId = 'Allocations can only be added to active projects.';

  if (input.projectRole.length > 100) errors.projectRole = 'Use at most 100 characters.';
  if (!(input.weeklyHours > 0 && input.weeklyHours <= 60)) errors.weeklyHours = 'Enter between 0.5 and 60 hours.';
  else if ((input.weeklyHours * 2) % 1 !== 0) errors.weeklyHours = 'Use 0.5-hour increments.';
  if (!isISODate(input.startDate)) errors.startDate = 'Enter a valid start date.';
  if (!isISODate(input.endDate)) errors.endDate = 'Enter a valid end date.';
  else if (isISODate(input.startDate) && input.endDate < input.startDate) errors.endDate = 'End date must be after the start date.';
  else if (project && isISODate(input.startDate) && (input.startDate < project.start_date || input.endDate > project.end_date)) {
    errors.endDate = `Must fall within the project dates (${project.start_date} to ${project.end_date}).`;
  }
  assertValid(errors);

  const overlap = await db.query(
    `SELECT 1 FROM allocations WHERE employee_id = $1 AND project_id = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)
        AND start_date <= $5::date AND end_date >= $4::date`,
    [input.employeeId, input.projectId, id, input.startDate, input.endDate],
  );
  if (overlap.rowCount) throw new HttpError(409, 'Overlapping allocation.', { projectId: 'This employee already has an overlapping allocation to this project.' });
  return input;
}

export const allocationsRouter = Router();
allocationsRouter.use(requireAuth);

/** GET /api/allocations?employeeId=&projectId= */
allocationsRouter.get('/', async (req, res) => {
  const user = currentUser(res);
  const { rows } = await pool.query<AllocationRow>(
    `SELECT ${ALLOCATION_COLUMNS} FROM allocations WHERE organisation_id = $1 ORDER BY start_date, id`,
    [user.organisationId],
  );
  let list = rows.map(toAllocation);
  if (user.systemRole === 'manager') {
    // Own projects + every allocation of team members (needed to show their full capacity).
    const [projects, team] = await Promise.all([managedProjectIds(pool, user), teamEmployeeIds(pool, user)]);
    list = list.filter((a) => projects.has(a.projectId) || team.has(a.employeeId) || a.employeeId === user.id);
  } else if (user.systemRole === 'associate') {
    list = list.filter((a) => a.employeeId === user.id);
  }
  const employeeId = str(req.query.employeeId);
  const projectId = str(req.query.projectId);
  if (employeeId) list = list.filter((a) => a.employeeId === employeeId);
  if (projectId) list = list.filter((a) => a.projectId === projectId);
  res.json(list);
});

/** POST /api/allocations */
allocationsRouter.post('/', requireRole('admin', 'manager'), async (req, res) => {
  const user = currentUser(res);
  const row = await withTransaction(async (db) => {
    const a = await validateAllocation(db, user, req.body, null);
    const { rows } = await db.query<AllocationRow>(
      `INSERT INTO allocations (organisation_id, employee_id, project_id, project_role, weekly_hours, start_date, end_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${ALLOCATION_COLUMNS}`,
      [user.organisationId, a.employeeId, a.projectId, a.projectRole, a.weeklyHours, a.startDate, a.endDate, user.id],
    );
    return rows[0]!;
  });
  res.status(201).json(toAllocation(row));
});

/** PUT /api/allocations/:id — employee and project are fixed; role, hours and dates can change. */
allocationsRouter.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Allocation');
  const row = await withTransaction(async (db) => {
    const existing = (await db.query<AllocationRow>(`SELECT ${ALLOCATION_COLUMNS} FROM allocations WHERE organisation_id = $1 AND id = $2 FOR UPDATE`, [user.organisationId, id])).rows[0];
    if (!existing) throw new HttpError(404, 'Allocation not found.');
    const a = await validateAllocation(db, user, { ...(req.body ?? {}), employeeId: existing.employee_id, projectId: existing.project_id }, id);

    // Recorded time must stay inside the allocation.
    const logged = await loggedWeeks(db, existing.employee_id, existing.project_id, existing.start_date, existing.end_date);
    if (logged.last && a.endDate < logged.last) {
      throw new HttpError(409, `Time is already recorded on this allocation in the week of ${logged.last}.`, { endDate: `Must be on or after ${logged.last}.` });
    }
    if (logged.first && a.startDate > addDays(logged.first, 6)) {
      throw new HttpError(409, `Time is already recorded on this allocation in the week of ${logged.first}.`, { startDate: `Must be on or before ${addDays(logged.first, 6)}.` });
    }

    const { rows } = await db.query<AllocationRow>(
      `UPDATE allocations SET project_role = $3, weekly_hours = $4, start_date = $5, end_date = $6, updated_at = now()
        WHERE organisation_id = $1 AND id = $2 RETURNING ${ALLOCATION_COLUMNS}`,
      [user.organisationId, id, a.projectRole, a.weeklyHours, a.startDate, a.endDate],
    );
    return rows[0]!;
  });
  res.json(toAllocation(row));
});

/** DELETE /api/allocations/:id — only while no time has been recorded against it (shorten it instead). */
allocationsRouter.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Allocation');
  await withTransaction(async (db) => {
    const a = (await db.query<AllocationRow>(`SELECT ${ALLOCATION_COLUMNS} FROM allocations WHERE organisation_id = $1 AND id = $2 FOR UPDATE`, [user.organisationId, id])).rows[0];
    if (!a) throw new HttpError(404, 'Allocation not found.');
    await assertCanManageProject(db, user, a.project_id);
    const logged = await loggedWeeks(db, a.employee_id, a.project_id, a.start_date, a.end_date);
    if (logged.first) throw new HttpError(409, 'Time has already been recorded on this allocation, so it is kept for history. Change its end date instead.');
    await db.query('DELETE FROM allocations WHERE id = $1', [id]);
  });
  res.status(204).end();
});
