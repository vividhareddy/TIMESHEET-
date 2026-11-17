import { Router } from 'express';
import bcrypt from 'bcrypt';
import type { ClientSession } from 'mongoose';
import { withTransaction } from '../mongo.js';
import { currentUser, requireAuth, requireRole, type AuthUser } from '../auth.js';
import { EMAIL_RE, HttpError, assertId, assertValid, isISODate, isUuid, passwordProblem, str, uniqueViolation } from '../http.js';
import { lockDoc } from '../data.js';
import type { Country } from '../models/common.js';
import { EMPLOYEE_PUBLIC_FIELDS, EmployeeModel, ROLES, employeeFromDoc, type EmployeeLean, type Role } from '../models/employee.js';
import { Department, WorkLocation } from '../models/organisation.js';
import { Calendar } from '../models/calendar.js';
import { BCRYPT_ROUNDS } from './auth.js';

interface EmployeeInput {
  employeeCode: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  designation: string;
  workLocation: string;
  country: Country;
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
async function validateEmployee(session: ClientSession, user: AuthUser, body: unknown, id: string | null): Promise<EmployeeInput> {
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
  let country: Country = 'US';
  let resolvedCalendar = calendarId;
  if (department && !(await Department.exists({ organisationId: org, name: department }).session(session))) {
    errors.department = 'Select a department from the list.';
  }
  if (workLocation) {
    const l = await WorkLocation.findOne({ organisationId: org, name: workLocation }).session(session).lean<{ country: string; defaultCalendarId?: string | null }>();
    if (!l) errors.workLocation = 'Select a work location from the list.';
    else {
      country = l.country as Country;
      resolvedCalendar = calendarId ?? l.defaultCalendarId ?? null;
    }
  }
  if (calendarId) {
    const cal = isUuid(calendarId) ? await Calendar.exists({ organisationId: org, _id: calendarId }).session(session) : null;
    if (!cal) errors.calendarId = 'Unknown calendar.';
  }
  if (managerId) {
    if (managerId === id) errors.managerId = 'An employee cannot report to themselves.';
    else {
      const mgr = isUuid(managerId)
        ? await EmployeeModel.exists({ organisationId: org, _id: managerId, status: 'active', systemRole: { $in: ['manager', 'admin'] } }).session(session)
        : null;
      if (!mgr) errors.managerId = 'Select an active manager or administrator.';
    }
  }
  assertValid(errors);

  return {
    employeeCode, name, email, phone, department, designation, workLocation, country,
    calendarId: resolvedCalendar, managerId, systemRole, status, weeklyCapacity, joinDate, password,
  };
}

/** Prevents removing the organisation's last active administrator (which would lock everyone out of admin features). */
async function assertAnotherActiveAdmin(session: ClientSession, orgId: string, excludingId: string): Promise<void> {
  const n = await EmployeeModel.countDocuments({ organisationId: orgId, systemRole: 'admin', status: 'active', _id: { $ne: excludingId } }).session(session);
  if (!n) throw new HttpError(409, 'The organisation must keep at least one active administrator.');
}

function duplicateError(err: unknown): HttpError | null {
  const index = uniqueViolation(err);
  if (index === 'employees_email_key') return new HttpError(409, 'An employee with these details already exists.', { email: 'This email address is already in use.' });
  if (index === 'employees_employee_code_key') return new HttpError(409, 'An employee with these details already exists.', { employeeCode: 'This employee ID already exists.' });
  return null;
}

/** Runs fn in a transaction, translating duplicate email / employee ID errors. */
async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(fn);
  } catch (err) {
    throw duplicateError(err) ?? err;
  }
}

export const employeesRouter = Router();
employeesRouter.use(requireAuth);

/** GET /api/employees — the employee directory (needed to show names across the app). */
employeesRouter.get('/', async (_req, res) => {
  const docs = await EmployeeModel.find({ organisationId: currentUser(res).organisationId }).select(EMPLOYEE_PUBLIC_FIELDS).sort({ name: 1 }).lean<EmployeeLean[]>();
  res.json(docs.map(employeeFromDoc));
});

/** GET /api/employees/:id */
employeesRouter.get('/:id', async (req, res) => {
  const id = assertId(req.params.id, 'Employee');
  const doc = await EmployeeModel.findOne({ organisationId: currentUser(res).organisationId, _id: id }).select(EMPLOYEE_PUBLIC_FIELDS).lean<EmployeeLean>();
  if (!doc) throw new HttpError(404, 'Employee not found.');
  res.json(employeeFromDoc(doc));
});

/** POST /api/employees — admin creates an account (with a temporary password) and assigns its role. */
employeesRouter.post('/', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const saved = await inTransaction(async (session) => {
    const input = await validateEmployee(session, user, req.body, null);
    const { password, ...fields } = input;
    const passwordHash = await bcrypt.hash(password!, BCRYPT_ROUNDS);
    const [doc] = await EmployeeModel.create([{ ...fields, organisationId: user.organisationId, passwordHash }], { session });
    return doc!.toObject() as unknown as EmployeeLean;
  });
  console.log(`[employees] ${user.email} created ${saved.email} (${saved.systemRole}).`);
  res.status(201).json(employeeFromDoc(saved));
});

/** PUT /api/employees/:id — admin edits details, role and status; a non-empty password resets it. */
employeesRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Employee');
  const saved = await inTransaction(async (session) => {
    const before = await lockDoc<EmployeeLean>(EmployeeModel, { organisationId: user.organisationId, _id: id }, session);
    if (!before) throw new HttpError(404, 'Employee not found.');

    const input = await validateEmployee(session, user, req.body, id);
    if (id === user.id && input.systemRole !== 'admin') throw new HttpError(400, 'You cannot remove your own administrator role.', { systemRole: 'You cannot remove your own administrator role.' });
    if (id === user.id && input.status !== 'active') throw new HttpError(400, 'You cannot deactivate your own account.', { status: 'You cannot deactivate your own account.' });
    const losesAdmin = before.systemRole === 'admin' && before.status === 'active' && (input.systemRole !== 'admin' || input.status !== 'active');
    if (losesAdmin) await assertAnotherActiveAdmin(session, user.organisationId, id);

    const { password, ...fields } = input;
    const passwordHash = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;
    const doc = await EmployeeModel.findOneAndUpdate(
      { organisationId: user.organisationId, _id: id },
      { $set: { ...fields, ...(passwordHash ? { passwordHash } : {}) } },
      { session, returnDocument: 'after', runValidators: true },
    ).select(EMPLOYEE_PUBLIC_FIELDS).lean<EmployeeLean>();
    return doc!;
  });
  res.json(employeeFromDoc(saved));
});

/** PATCH /api/employees/:id/status — activate / deactivate an account. */
employeesRouter.patch('/:id/status', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Employee');
  const status = req.body?.status;
  if (status !== 'active' && status !== 'inactive') throw new HttpError(400, 'Status must be "active" or "inactive".');
  if (id === user.id && status === 'inactive') throw new HttpError(400, 'You cannot deactivate your own account.');

  const saved = await inTransaction(async (session) => {
    const before = await lockDoc<EmployeeLean>(EmployeeModel, { organisationId: user.organisationId, _id: id }, session);
    if (!before) throw new HttpError(404, 'Employee not found.');
    if (status === 'inactive' && before.systemRole === 'admin' && before.status === 'active') await assertAnotherActiveAdmin(session, user.organisationId, id);
    const doc = await EmployeeModel.findOneAndUpdate({ organisationId: user.organisationId, _id: id }, { $set: { status } }, { session, returnDocument: 'after' })
      .select(EMPLOYEE_PUBLIC_FIELDS)
      .lean<EmployeeLean>();
    return doc!;
  });
  res.json(employeeFromDoc(saved));
});
