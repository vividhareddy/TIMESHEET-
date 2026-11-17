/** Reference data (lookups), organisation settings and overtime policy. */
import { Router } from 'express';
import { CASE_INSENSITIVE, type Country } from '../models/common.js';
import { Calendar } from '../models/calendar.js';
import { EmployeeModel } from '../models/employee.js';
import { Department, Organisation, WorkLocation } from '../models/organisation.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, assertId, assertValid, isUuid, str, uniqueViolation } from '../http.js';

const opt = <T extends string>(value: T, label: string) => ({ value, label });

/** System enumerations (not business data): owned by the server so every client shows identical options. */
const ENUMS = {
  countries: [opt('US', 'United States'), opt('IN', 'India')],
  roles: [opt('associate', 'Associate'), opt('manager', 'Project Manager'), opt('admin', 'Administrator')],
  employeeStatuses: [opt('active', 'Active'), opt('inactive', 'Inactive')],
  projectStatuses: [opt('active', 'Active'), opt('on_hold', 'On hold'), opt('completed', 'Completed'), opt('inactive', 'Inactive')],
  entryStatuses: [opt('draft', 'Draft'), opt('pending', 'Pending approval'), opt('approved', 'Approved'), opt('returned', 'Returned'), opt('rejected', 'Rejected')],
  timesheetStatuses: [
    opt('not_started', 'Not started'),
    opt('draft', 'Draft'),
    opt('submitted', 'Submitted'),
    opt('partially_approved', 'Partially approved'),
    opt('approved', 'Approved'),
    opt('returned', 'Returned'),
    opt('rejected', 'Rejected'),
  ],
  requestStatuses: [opt('pending', 'Pending'), opt('approved', 'Approved'), opt('rejected', 'Rejected')],
  leaveDurations: [opt('full', 'Full Day'), opt('half', 'Half Day')],
  holidayTypes: [opt('public', 'Public holiday'), opt('state', 'State holiday'), opt('company', 'Company holiday')],
  overtimeApprovers: [opt('project_manager', 'Project manager of the project'), opt('reporting_manager', "Employee's reporting manager"), opt('admin', 'Administrator')],
};
const COUNTRIES = new Set(['US', 'IN']);
const APPROVERS = new Set(['project_manager', 'reporting_manager', 'admin']);

/** Defaults used until an administrator changes them (40h week, Mon–Fri × 8h). */
const DEFAULT_SETTINGS = {
  defaultWeeklyTarget: 40,
  defaultHoursPerDay: 8,
  hourIncrement: 0.5,
  requireDescription: true,
  allowWeekendEntry: true,
  submissionDeadline: 'Monday 10:00',
  reminderEnabled: true,
};
const DEFAULT_POLICY = {
  enabled: true,
  dailyThreshold: 8,
  weeklyThreshold: 40,
  weekendApplicable: true,
  holidayApplicable: true,
  weekdayMultiplier: 1.5,
  weekendMultiplier: 2,
  maxWeeklyOvertime: 12,
  requirePreApproval: false,
  approver: 'project_manager',
  autoFlag: true,
};

const num = (v: unknown) => (typeof v === 'number' ? v : Number.NaN);
const bool = (v: unknown, field: string, errors: Record<string, string>) => {
  if (typeof v !== 'boolean') errors[field] = 'Must be true or false.';
  return v === true;
};

export const organisationRouter = Router();
// Mounted at /api, so authentication is scoped to this router's own paths.
organisationRouter.use(['/lookups', '/settings', '/policies'], requireAuth);

// ------------------------------------------------------------------ lookups

interface LocationLean {
  _id: string;
  name: string;
  country: string;
  defaultCalendarId?: string | null;
}
const toLocation = (l: LocationLean) => ({ id: l._id, name: l.name, country: l.country, defaultCalendarId: l.defaultCalendarId ?? null });
const toDepartment = (d: { _id: string; name: string }) => ({ id: d._id, name: d.name });

organisationRouter.get('/lookups', async (_req, res) => {
  const org = currentUser(res).organisationId;
  const [deps, locs] = await Promise.all([
    Department.find({ organisationId: org }).collation(CASE_INSENSITIVE).sort({ name: 1 }).lean<Array<{ _id: string; name: string }>>(),
    WorkLocation.find({ organisationId: org }).collation(CASE_INSENSITIVE).sort({ name: 1 }).lean<LocationLean[]>(),
  ]);
  res.json({ departments: deps.map(toDepartment), workLocations: locs.map(toLocation), ...ENUMS });
});

organisationRouter.post('/lookups/departments', requireRole('admin'), async (req, res) => {
  const name = str(req.body?.name);
  if (!name) throw new HttpError(400, 'Please correct the highlighted fields.', { name: 'Department name is required.' });
  if (name.length > 100) throw new HttpError(400, 'Please correct the highlighted fields.', { name: 'Use at most 100 characters.' });
  try {
    const doc = await Department.create({ organisationId: currentUser(res).organisationId, name });
    res.status(201).json(toDepartment(doc));
  } catch (err) {
    if (uniqueViolation(err) !== null) throw new HttpError(409, 'Duplicate department.', { name: 'This department already exists.' });
    throw err;
  }
});

organisationRouter.delete('/lookups/departments/:id', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Department');
  const dep = await Department.findOne({ organisationId: org, _id: id }).lean<{ name: string }>();
  if (!dep) throw new HttpError(404, 'Department not found.');
  const used = await EmployeeModel.countDocuments({ organisationId: org, department: dep.name });
  if (used) throw new HttpError(409, `${dep.name} is assigned to ${used} employee(s) and cannot be removed.`);
  await Department.deleteOne({ _id: id });
  res.status(204).end();
});

async function validateLocation(org: string, body: unknown, requireName: boolean) {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = str(b.name);
  const country = str(b.country);
  const defaultCalendarId = str(b.defaultCalendarId) || null;
  const errors: Record<string, string> = {};
  if (requireName && !name) errors.name = 'Location name is required.';
  else if (name.length > 100) errors.name = 'Use at most 100 characters.';
  if (!COUNTRIES.has(country)) errors.country = 'Select a country.';
  if (defaultCalendarId) {
    const cal = isUuid(defaultCalendarId) ? await Calendar.exists({ organisationId: org, _id: defaultCalendarId }) : null;
    if (!cal) errors.defaultCalendarId = 'Unknown calendar.';
  }
  assertValid(errors);
  return { name, country: country as Country, defaultCalendarId };
}

organisationRouter.post('/lookups/work-locations', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const loc = await validateLocation(org, req.body, true);
  try {
    const doc = await WorkLocation.create({ organisationId: org, ...loc });
    res.status(201).json(toLocation(doc.toObject() as unknown as LocationLean));
  } catch (err) {
    if (uniqueViolation(err) !== null) throw new HttpError(409, 'Duplicate location.', { name: 'This location already exists.' });
    throw err;
  }
});

/** Name is fixed after creation (employees reference it); country and default calendar can change. */
organisationRouter.put('/lookups/work-locations/:id', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Work location');
  const loc = await validateLocation(org, req.body, false);
  const doc = await WorkLocation.findOneAndUpdate(
    { organisationId: org, _id: id },
    { $set: { country: loc.country, defaultCalendarId: loc.defaultCalendarId } },
    { returnDocument: 'after', runValidators: true },
  ).lean<LocationLean>();
  if (!doc) throw new HttpError(404, 'Work location not found.');
  res.json(toLocation(doc));
});

organisationRouter.delete('/lookups/work-locations/:id', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Work location');
  const loc = await WorkLocation.findOne({ organisationId: org, _id: id }).lean<{ name: string }>();
  if (!loc) throw new HttpError(404, 'Work location not found.');
  const used = await EmployeeModel.countDocuments({ organisationId: org, workLocation: loc.name });
  if (used) throw new HttpError(409, `${loc.name} is assigned to ${used} employee(s) and cannot be removed.`);
  await WorkLocation.deleteOne({ _id: id });
  res.status(204).end();
});

// ----------------------------------------------------------------- settings

export type OrgSettings = typeof DEFAULT_SETTINGS & { organisationName: string };
export type OvertimePolicy = typeof DEFAULT_POLICY;

export async function readSettings(org: string): Promise<OrgSettings> {
  const row = await Organisation.findById(org).select('name settings').lean<{ name: string; settings?: Record<string, unknown> }>();
  if (!row) throw new HttpError(404, 'Organisation not found.');
  return { organisationName: row.name, ...DEFAULT_SETTINGS, ...(row.settings ?? {}) } as OrgSettings;
}

organisationRouter.get('/settings', async (_req, res) => {
  res.json(await readSettings(currentUser(res).organisationId));
});

organisationRouter.put('/settings', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const organisationName = str(b.organisationName);
  if (!organisationName) errors.organisationName = 'Organisation name is required.';
  else if (organisationName.length < 2 || organisationName.length > 150) errors.organisationName = 'Use between 2 and 150 characters.';
  const settings = {
    defaultWeeklyTarget: num(b.defaultWeeklyTarget),
    defaultHoursPerDay: num(b.defaultHoursPerDay),
    hourIncrement: num(b.hourIncrement),
    requireDescription: bool(b.requireDescription, 'requireDescription', errors),
    allowWeekendEntry: bool(b.allowWeekendEntry, 'allowWeekendEntry', errors),
    submissionDeadline: str(b.submissionDeadline),
    reminderEnabled: bool(b.reminderEnabled, 'reminderEnabled', errors),
  };
  if (!(settings.defaultWeeklyTarget > 0 && settings.defaultWeeklyTarget <= 60)) errors.defaultWeeklyTarget = 'Enter between 1 and 60 hours.';
  if (!(settings.defaultHoursPerDay > 0 && settings.defaultHoursPerDay <= 12)) errors.defaultHoursPerDay = 'Enter between 1 and 12 hours.';
  if (![0.25, 0.5, 1].includes(settings.hourIncrement)) errors.hourIncrement = 'Use 0.25, 0.5 or 1 hour.';
  if (settings.submissionDeadline.length > 50) errors.submissionDeadline = 'Use at most 50 characters.';
  assertValid(errors);
  try {
    await Organisation.updateOne({ _id: org }, { $set: { name: organisationName, settings } }, { runValidators: true });
  } catch (err) {
    if (uniqueViolation(err) !== null) throw new HttpError(409, 'This organisation name is already in use.', { organisationName: 'This organisation name is already in use.' });
    throw err;
  }
  res.json(await readSettings(org));
});

// ---------------------------------------------------------- overtime policy

export async function readPolicy(org: string): Promise<OvertimePolicy> {
  const row = await Organisation.findById(org).select('overtimePolicy').lean<{ overtimePolicy?: Record<string, unknown> }>();
  if (!row) throw new HttpError(404, 'Organisation not found.');
  return { ...DEFAULT_POLICY, ...(row.overtimePolicy ?? {}) } as OvertimePolicy;
}

organisationRouter.get('/policies/overtime', async (_req, res) => {
  res.json(await readPolicy(currentUser(res).organisationId));
});

organisationRouter.put('/policies/overtime', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const policy = {
    enabled: bool(b.enabled, 'enabled', errors),
    dailyThreshold: num(b.dailyThreshold),
    weeklyThreshold: num(b.weeklyThreshold),
    weekendApplicable: bool(b.weekendApplicable, 'weekendApplicable', errors),
    holidayApplicable: bool(b.holidayApplicable, 'holidayApplicable', errors),
    weekdayMultiplier: num(b.weekdayMultiplier),
    weekendMultiplier: num(b.weekendMultiplier),
    maxWeeklyOvertime: num(b.maxWeeklyOvertime),
    requirePreApproval: bool(b.requirePreApproval, 'requirePreApproval', errors),
    approver: str(b.approver),
    autoFlag: bool(b.autoFlag, 'autoFlag', errors),
  };
  if (!(policy.dailyThreshold > 0 && policy.dailyThreshold <= 24)) errors.dailyThreshold = 'Enter between 1 and 24 hours.';
  if (!(policy.weeklyThreshold > 0 && policy.weeklyThreshold <= 168)) errors.weeklyThreshold = 'Enter between 1 and 168 hours.';
  if (!(policy.weekdayMultiplier >= 1 && policy.weekdayMultiplier <= 5)) errors.weekdayMultiplier = 'Enter between 1 and 5.';
  if (!(policy.weekendMultiplier >= 1 && policy.weekendMultiplier <= 5)) errors.weekendMultiplier = 'Enter between 1 and 5.';
  if (!(policy.maxWeeklyOvertime >= 0 && policy.maxWeeklyOvertime <= 60)) errors.maxWeeklyOvertime = 'Enter between 0 and 60 hours.';
  if (!APPROVERS.has(policy.approver)) errors.approver = 'Select an approver.';
  if (Object.keys(errors).length) throw new HttpError(400, 'Please correct the highlighted policy values.', errors);
  await Organisation.updateOne({ _id: org }, { $set: { overtimePolicy: policy } });
  res.json(await readPolicy(org));
});
