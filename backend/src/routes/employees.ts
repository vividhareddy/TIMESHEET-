import { Router } from 'express';
import bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { currentUser, requireAuth, requireRole, type AuthUser } from '../auth.js';
import { EMAIL_RE, HttpError, assertId, assertValid, isISODate, isUuid, passwordProblem, str, uniqueViolation } from '../http.js';
import { EMPLOYEE_COLUMNS, ROLES, toEmployee, type EmployeeRow, type Role } from '../models/employee.js';
import { BCRYPT_ROUNDS } from './auth.js';

interface EmployeeInput {
  employeeCode: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  designation: string;
  workLocation: string;
  country: string;
  calendarId: string | null;
  managerId: string | null;
  systemRole: Role;
  status: 'active' | 'inactive';
  weeklyCapacity: number;
  joinDate: string;
  /** Required when creating; optional on update (resets the password). */
  password: string | null;
}

/** Validates the body and resolves location → country / default calendar. Mirrors the mock API rules. */
async function validateEmployee(db: PoolClient, user: AuthUser, body: unknown, id: string | null): Promise<EmployeeInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};

  const employeeCode = str(b.employeeCode).toUpperCase();
  const name = str(b.name);
  const email = str(b.email).toLowerCase();
  const phone = str(b.phone);
  const department = str(b.department);
  const designation = str(b.designation);
  const workLocation = str(b.workLocation);
  const calendarId = str(b.calendarId) || null;
  const managerId = str(b.managerId) || null;
  const systemRole = b.systemRole as Role;
  const status = b.status === 'inactive' ? 'inactive' : 'active';
  const weeklyCapacity = Number(b.weeklyCapacity);
  const joinDate = str(b.joinDate);
  const password = typeof b.password === 'string' && b.password !== '' ? b.password : null;

  if (!employeeCode) errors.employeeCode = 'Employee ID is required.';
  else if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(employeeCode)) errors.employeeCode = 'Use up to 20 letters, digits, "-" or "_".';
  if (!name) errors.name = 'Full name is required.';
  else if (name.length > 100) errors.name = 'Use at most 100 characters.';
  if (!email) errors.email = 'Work email is required.';
  else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (phone.length > 30) errors.phone = 'Use at most 30 characters.';
  if (!department) errors.department = 'Department is required.';
  if (!designation) errors.designation = 'Designation is required.';
  else if (designation.length > 100) errors.designation = 'Use at most 100 characters.';
  if (!workLocation) errors.workLocation = 'Work location is required.';
  if (!ROLES.includes(systemRole)) errors.systemRole = 'Select a valid role.';
  if (!(weeklyCapacity > 0 && weeklyCapacity <= 60)) errors.weeklyCapacity = 'Enter between 1 and 60 hours.';
  if (!isISODate(joinDate)) errors.joinDate = 'Enter a valid date.';
  if (id === null && !password) errors.password = 'Set a temporary password for the new account.';
  else if (password) {
    const problem = passwordProblem(password);
    if (problem) errors.password = problem;
  }

  // Reference data must exist in this organisation.
  const org = user.organisationId;
  let country = '';
  let resolvedCalendar = calendarId;
  if (department) {
    const dep = await db.query('SELECT 1 FROM departments WHERE organisation_id = $1 AND name = $2', [org, department]);
    if (!dep.rowCount) errors.department = 'Select a department from the list.';
  }
  if (workLocation) {
    const loc = await db.query<{ country: string; default_calendar_id: string | null }>(
      'SELECT country, default_calendar_id FROM work_locations WHERE organisation_id = $1 AND name = $2',
      [org, workLocation],
    );
    const l = loc.rows[0];
    if (!l) errors.workLocation = 'Select a work location from the list.';
    else {
      country = l.country;
      resolvedCalendar = calendarId ?? l.default_calendar_id;
    }
  }
  if (calendarId) {
    const cal = isUuid(calendarId) ? await db.query('SELECT 1 FROM calendars WHERE organisation_id = $1 AND id = $2', [org, calendarId]) : null;
    if (!cal?.rowCount) errors.calendarId = 'Unknown calendar.';
  }
  if (managerId) {
    if (managerId === id) errors.managerId = 'An employee cannot report to themselves.';
    else {
      const mgr = isUuid(managerId)
        ? await db.query("SELECT 1 FROM employees WHERE organisation_id = $1 AND id = $2 AND status = 'active' AND system_role IN ('manager', 'admin')", [org, managerId])
        : null;
      if (!mgr?.rowCount) errors.managerId = 'Select an active manager or administrator.';
    }
  }
  assertValid(errors);

  return {
    employeeCode, name, email, phone, department, designation, workLocation, country,
    calendarId: resolvedCalendar, managerId, systemRole, status, weeklyCapacity, joinDate, password,
  };
}

/** Prevents removing the organisation's last active administrator (which would lock everyone out of admin features). */
async function assertAnotherActiveAdmin(db: PoolClient, orgId: string, excludingId: string): Promise<void> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM employees WHERE organisation_id = $1 AND system_role = 'admin' AND status = 'active' AND id <> $2",
    [orgId, excludingId],
  );
  if (!rows[0]?.n) throw new HttpError(409, 'The organisation must keep at least one active administrator.');
}

function duplicateError(err: unknown): HttpError | null {
  const constraint = uniqueViolation(err);
  if (constraint === 'employees_email_key') return new HttpError(409, 'An employee with these details already exists.', { email: 'This email address is already in use.' });
  if (constraint === 'employees_employee_code_key') return new HttpError(409, 'An employee with these details already exists.', { employeeCode: 'This employee ID already exists.' });
  return null;
}

/** Runs fn in a transaction on a dedicated client. */
async function inTransaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw duplicateError(err) ?? err;
  } finally {
    client.release();
  }
}

export const employeesRouter = Router();
employeesRouter.use(requireAuth);

/** GET /api/employees — the employee directory (needed to show names across the app). */
employeesRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query<EmployeeRow>(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE organisation_id = $1 ORDER BY name`,
    [currentUser(res).organisationId],
  );
  res.json(rows.map(toEmployee));
});

/** GET /api/employees/:id */
employeesRouter.get('/:id', async (req, res) => {
  const id = assertId(req.params.id, 'Employee');
  const { rows } = await pool.query<EmployeeRow>(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE organisation_id = $1 AND id = $2`,
    [currentUser(res).organisationId, id],
  );
  if (!rows[0]) throw new HttpError(404, 'Employee not found.');
  res.json(toEmployee(rows[0]));
});

/** POST /api/employees — admin creates an account (with a temporary password) and assigns its role. */
employeesRouter.post('/', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const saved = await inTransaction(async (db) => {
    const input = await validateEmployee(db, user, req.body, null);
    const hash = await bcrypt.hash(input.password!, BCRYPT_ROUNDS);
    const { rows } = await db.query<EmployeeRow>(
      `INSERT INTO employees (organisation_id, employee_code, name, email, password_hash, phone, department, designation,
         work_location, country, calendar_id, manager_id, system_role, status, weekly_capacity, join_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING ${EMPLOYEE_COLUMNS}`,
      [user.organisationId, input.employeeCode, input.name, input.email, hash, input.phone, input.department, input.designation,
        input.workLocation, input.country, input.calendarId, input.managerId, input.systemRole, input.status, input.weeklyCapacity, input.joinDate],
    );
    return rows[0]!;
  });
  console.log(`[employees] ${user.email} created ${saved.email} (${saved.system_role}).`);
  res.status(201).json(toEmployee(saved));
});

/** PUT /api/employees/:id — admin edits details, role and status; a non-empty password resets it. */
employeesRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Employee');
  const saved = await inTransaction(async (db) => {
    const current = await db.query<{ system_role: Role; status: string }>(
      'SELECT system_role, status FROM employees WHERE organisation_id = $1 AND id = $2 FOR UPDATE',
      [user.organisationId, id],
    );
    const before = current.rows[0];
    if (!before) throw new HttpError(404, 'Employee not found.');

    const input = await validateEmployee(db, user, req.body, id);
    if (id === user.id && input.systemRole !== 'admin') throw new HttpError(400, 'You cannot remove your own administrator role.', { systemRole: 'You cannot remove your own administrator role.' });
    if (id === user.id && input.status !== 'active') throw new HttpError(400, 'You cannot deactivate your own account.', { status: 'You cannot deactivate your own account.' });
    const losesAdmin = before.system_role === 'admin' && before.status === 'active' && (input.systemRole !== 'admin' || input.status !== 'active');
    if (losesAdmin) await assertAnotherActiveAdmin(db, user.organisationId, id);

    const hash = input.password ? await bcrypt.hash(input.password, BCRYPT_ROUNDS) : null;
    const { rows } = await db.query<EmployeeRow>(
      `UPDATE employees SET employee_code = $3, name = $4, email = $5, phone = $6, department = $7, designation = $8,
         work_location = $9, country = $10, calendar_id = $11, manager_id = $12, system_role = $13, status = $14,
         weekly_capacity = $15, join_date = $16, password_hash = COALESCE($17, password_hash), updated_at = now()
       WHERE organisation_id = $1 AND id = $2
       RETURNING ${EMPLOYEE_COLUMNS}`,
      [user.organisationId, id, input.employeeCode, input.name, input.email, input.phone, input.department, input.designation,
        input.workLocation, input.country, input.calendarId, input.managerId, input.systemRole, input.status, input.weeklyCapacity, input.joinDate, hash],
    );
    return rows[0]!;
  });
  res.json(toEmployee(saved));
});

/** PATCH /api/employees/:id/status — activate / deactivate an account. */
employeesRouter.patch('/:id/status', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Employee');
  const status = req.body?.status;
  if (status !== 'active' && status !== 'inactive') throw new HttpError(400, 'Status must be "active" or "inactive".');
  if (id === user.id && status === 'inactive') throw new HttpError(400, 'You cannot deactivate your own account.');

  const saved = await inTransaction(async (db) => {
    const current = await db.query<{ system_role: Role; status: string }>(
      'SELECT system_role, status FROM employees WHERE organisation_id = $1 AND id = $2 FOR UPDATE',
      [user.organisationId, id],
    );
    const before = current.rows[0];
    if (!before) throw new HttpError(404, 'Employee not found.');
    if (status === 'inactive' && before.system_role === 'admin' && before.status === 'active') await assertAnotherActiveAdmin(db, user.organisationId, id);
    const { rows } = await db.query<EmployeeRow>(
      `UPDATE employees SET status = $3, updated_at = now() WHERE organisation_id = $1 AND id = $2 RETURNING ${EMPLOYEE_COLUMNS}`,
      [user.organisationId, id, status],
    );
    return rows[0]!;
  });
  res.json(toEmployee(saved));
});
