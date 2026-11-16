/** Reference data, settings, employees, projects, allocations and calendars. */
import type { Allocation, AppSettings, Employee, Holiday, OvertimePolicy, Project, ReferenceData, WorkCalendar } from '@/types';
import type { AllocationInput, CalendarInput, EmployeeInput, HolidayInput, ProjectInput, WorkLocationInput } from '@/types/api';
import { rangesOverlap } from '@/utils/date';
import { badRequest, conflict, forbidden, newId, notFound, required, route } from '../http';
import { db, managedProjectIds, teamEmployeeIds } from './scope';

const opt = <T extends string>(value: T, label: string) => ({ value, label });

/** Enumerations are owned by the server so every client shows identical options. */
function referenceData(): ReferenceData {
  return {
    departments: [...db().departments].sort((a, b) => a.name.localeCompare(b.name)),
    workLocations: [...db().workLocations].sort((a, b) => a.name.localeCompare(b.name)),
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
    holidayTypes: [opt('public', 'Public holiday'), opt('company', 'Company holiday')],
    overtimeApprovers: [opt('project_manager', 'Project manager of the project'), opt('reporting_manager', "Employee's reporting manager"), opt('admin', 'Administrator')],
  };
}

// --------------------------------------------------------------- employees

function validateEmployee(body: EmployeeInput, id?: string): EmployeeInput {
  required(body as unknown as Record<string, unknown>, {
    employeeCode: 'Employee ID',
    name: 'Full name',
    email: 'Work email',
    department: 'Department',
    designation: 'Designation',
    workLocation: 'Work location',
  });
  const errors: Record<string, string> = {};
  const email = body.email.trim().toLowerCase();
  const code = body.employeeCode.trim().toUpperCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (!(body.weeklyCapacity > 0 && body.weeklyCapacity <= 60)) errors.weeklyCapacity = 'Enter between 1 and 60 hours.';
  if (!db().departments.some((d) => d.name === body.department)) errors.department = 'Select a department from the list.';
  const location = db().workLocations.find((l) => l.name === body.workLocation);
  if (!location) errors.workLocation = 'Select a work location from the list.';
  if (body.calendarId && !db().calendars.some((c) => c.id === body.calendarId)) errors.calendarId = 'Unknown calendar.';
  if (body.managerId && !db().employees.some((e) => e.id === body.managerId)) errors.managerId = 'Unknown manager.';
  if (body.managerId && body.managerId === id) errors.managerId = 'An employee cannot report to themselves.';
  if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields.', errors);

  const dup: Record<string, string> = {};
  if (db().employees.some((e) => e.employeeCode.toUpperCase() === code && e.id !== id)) dup.employeeCode = 'This employee ID already exists.';
  if (db().employees.some((e) => e.email.toLowerCase() === email && e.id !== id)) dup.email = 'This email address is already in use.';
  if (Object.keys(dup).length) throw conflict('An employee with these details already exists.', dup);

  if (!id && !body.password) throw badRequest('Please correct the highlighted fields.', { password: 'Set a temporary password for the new account.' });
  if (body.password && body.password.length < 8) throw badRequest('Please correct the highlighted fields.', { password: 'Use at least 8 characters.' });

  // The password is stored separately (credentials), never on the employee record.
  const { password: _password, ...details } = body;
  return {
    ...details,
    employeeCode: code,
    email,
    name: body.name.trim(),
    designation: body.designation.trim(),
    country: location!.country,
    calendarId: body.calendarId || location!.defaultCalendarId || '',
  };
}

// ----------------------------------------------------------------- projects

function validateProject(body: ProjectInput, id?: string): ProjectInput {
  required(body as unknown as Record<string, unknown>, { name: 'Project name', code: 'Project code', client: 'Client', managerId: 'Project manager', startDate: 'Start date', endDate: 'End date' });
  const errors: Record<string, string> = {};
  const manager = db().employees.find((e) => e.id === body.managerId);
  if (!manager || manager.status !== 'active' || manager.systemRole === 'associate') errors.managerId = 'Select an active project manager.';
  if (body.endDate < body.startDate) errors.endDate = 'End date must be after the start date.';
  if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields.', errors);
  const dup: Record<string, string> = {};
  if (db().projects.some((p) => p.name.toLowerCase() === body.name.trim().toLowerCase() && p.id !== id)) dup.name = 'A project with this name already exists.';
  if (db().projects.some((p) => p.code.toUpperCase() === body.code.trim().toUpperCase() && p.id !== id)) dup.code = 'This project code is already used.';
  if (Object.keys(dup).length) throw conflict('Duplicate project.', dup);
  return { ...body, name: body.name.trim(), code: body.code.trim().toUpperCase(), client: body.client.trim() };
}

// -------------------------------------------------------------- allocations

function canManageProject(user: Employee, projectId: string) {
  return user.systemRole === 'admin' || managedProjectIds(user).has(projectId);
}

function validateAllocation(user: Employee, body: AllocationInput, id?: string): AllocationInput {
  required(body as unknown as Record<string, unknown>, { employeeId: 'Employee', projectId: 'Project', startDate: 'Start date', endDate: 'End date' });
  if (!canManageProject(user, body.projectId)) throw forbidden('You can only allocate resources to projects you manage.');
  const errors: Record<string, string> = {};
  const emp = db().employees.find((e) => e.id === body.employeeId);
  const project = db().projects.find((p) => p.id === body.projectId);
  if (!emp || emp.status !== 'active') errors.employeeId = 'Select an active employee.';
  if (!project) errors.projectId = 'Select a project.';
  else if (project.status !== 'active' && !id) errors.projectId = 'Allocations can only be added to active projects.';
  if (!(body.weeklyHours > 0 && body.weeklyHours <= 60)) errors.weeklyHours = 'Enter between 0.5 and 60 hours.';
  else if ((body.weeklyHours * 2) % 1 !== 0) errors.weeklyHours = 'Use 0.5-hour increments.';
  if (body.endDate < body.startDate) errors.endDate = 'End date must be after the start date.';
  else if (project && (body.startDate < project.startDate || body.endDate > project.endDate)) errors.endDate = `Must fall within the project dates (${project.startDate} to ${project.endDate}).`;
  if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields.', errors);
  const overlap = db().allocations.some(
    (a) => a.id !== id && a.employeeId === body.employeeId && a.projectId === body.projectId && rangesOverlap(a.startDate, a.endDate, body.startDate, body.endDate),
  );
  if (overlap) throw conflict('Overlapping allocation.', { projectId: 'This employee already has an overlapping allocation to this project.' });
  return { ...body, projectRole: body.projectRole?.trim() || 'Team member' };
}

// ---------------------------------------------------------------- calendars

function validateCalendar(body: CalendarInput, id?: string): CalendarInput {
  required(body as unknown as Record<string, unknown>, { name: 'Calendar name', country: 'Country', timezone: 'Time zone' });
  const errors: Record<string, string> = {};
  if (!body.workingDays?.length) errors.workingDays = 'Select at least one working day.';
  if (!(body.hoursPerDay > 0 && body.hoursPerDay <= 12)) errors.hoursPerDay = 'Enter between 1 and 12 hours.';
  if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields.', errors);
  if (db().calendars.some((c) => c.name.toLowerCase() === body.name.trim().toLowerCase() && c.id !== id)) throw conflict('Duplicate calendar.', { name: 'A calendar with this name already exists.' });
  return { ...body, name: body.name.trim(), workingDays: [...new Set(body.workingDays)].sort() };
}

function findCalendar(id: string): WorkCalendar {
  const cal = db().calendars.find((c) => c.id === id);
  if (!cal) throw notFound('Calendar');
  return cal;
}

function validateHoliday(cal: WorkCalendar, body: HolidayInput, id?: string): HolidayInput {
  required(body as unknown as Record<string, unknown>, { date: 'Date', name: 'Holiday name', type: 'Type' });
  if (cal.holidays.some((h) => h.date === body.date && h.id !== id)) throw conflict('Duplicate holiday.', { date: 'A holiday already exists on this date.' });
  return { ...body, name: body.name.trim() };
}

export const coreRoutes = [
  // ------------------------------------------------------------- lookups
  route('GET', '/lookups', () => referenceData()),
  route('POST', '/lookups/departments', (req) => {
    required(req.body, { name: 'Department name' });
    const name = String(req.body.name).trim();
    if (db().departments.some((d) => d.name.toLowerCase() === name.toLowerCase())) throw conflict('Duplicate department.', { name: 'This department already exists.' });
    const dep = { id: newId('dep'), name };
    db().departments.push(dep);
    return dep;
  }, { roles: ['admin'] }),
  route('DELETE', '/lookups/departments/:id', (req) => {
    const dep = db().departments.find((d) => d.id === req.params.id);
    if (!dep) throw notFound('Department');
    const used = db().employees.filter((e) => e.department === dep.name).length;
    if (used) throw conflict(`${dep.name} is assigned to ${used} employee(s) and cannot be removed.`);
    db().departments = db().departments.filter((d) => d.id !== dep.id);
  }, { roles: ['admin'] }),
  route('POST', '/lookups/work-locations', (req) => {
    const body = req.body as WorkLocationInput;
    required(body as unknown as Record<string, unknown>, { name: 'Location name', country: 'Country' });
    if (db().workLocations.some((l) => l.name.toLowerCase() === body.name.trim().toLowerCase())) throw conflict('Duplicate location.', { name: 'This location already exists.' });
    const loc = { id: newId('loc'), name: body.name.trim(), country: body.country, defaultCalendarId: body.defaultCalendarId || null };
    db().workLocations.push(loc);
    return loc;
  }, { roles: ['admin'] }),
  route('PUT', '/lookups/work-locations/:id', (req) => {
    const loc = db().workLocations.find((l) => l.id === req.params.id);
    if (!loc) throw notFound('Work location');
    const body = req.body as WorkLocationInput;
    loc.defaultCalendarId = body.defaultCalendarId || null;
    loc.country = body.country;
    return loc;
  }, { roles: ['admin'] }),
  route('DELETE', '/lookups/work-locations/:id', (req) => {
    const loc = db().workLocations.find((l) => l.id === req.params.id);
    if (!loc) throw notFound('Work location');
    const used = db().employees.filter((e) => e.workLocation === loc.name).length;
    if (used) throw conflict(`${loc.name} is assigned to ${used} employee(s) and cannot be removed.`);
    db().workLocations = db().workLocations.filter((l) => l.id !== loc.id);
  }, { roles: ['admin'] }),

  // ------------------------------------------------------------ settings
  route('GET', '/settings', () => db().settings),
  route('PUT', '/settings', (req) => {
    const s = req.body as AppSettings;
    const errors: Record<string, string> = {};
    if (!s.organisationName?.trim()) errors.organisationName = 'Organisation name is required.';
    if (!(s.defaultWeeklyTarget > 0 && s.defaultWeeklyTarget <= 60)) errors.defaultWeeklyTarget = 'Enter between 1 and 60 hours.';
    if (!(s.defaultHoursPerDay > 0 && s.defaultHoursPerDay <= 12)) errors.defaultHoursPerDay = 'Enter between 1 and 12 hours.';
    if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields.', errors);
    db().settings = { ...s, organisationName: s.organisationName.trim() };
    return db().settings;
  }, { roles: ['admin'] }),
  route('GET', '/policies/overtime', () => db().policy),
  route('PUT', '/policies/overtime', (req) => {
    const p = req.body as OvertimePolicy;
    if (!(p.dailyThreshold > 0) || !(p.weeklyThreshold > 0)) throw badRequest('Thresholds must be greater than zero.');
    db().policy = p;
    return p;
  }, { roles: ['admin'] }),

  // ----------------------------------------------------------- employees
  route('GET', '/employees', () => db().employees),
  route('GET', '/employees/:id', (req) => {
    const e = db().employees.find((x) => x.id === req.params.id);
    if (!e) throw notFound('Employee');
    return e;
  }),
  route('POST', '/employees', (req) => {
    const emp: Employee = { ...validateEmployee(req.body), id: newId('emp') };
    db().employees.push(emp);
    // Temporary password chosen by the administrator in the employee form.
    db().credentials[emp.id] = req.body.password;
    return emp;
  }, { roles: ['admin'] }),
  route('PUT', '/employees/:id', (req) => {
    const idx = db().employees.findIndex((e) => e.id === req.params.id);
    if (idx < 0) throw notFound('Employee');
    db().employees[idx] = { ...validateEmployee(req.body, req.params.id), id: req.params.id };
    if (req.body.password) db().credentials[req.params.id] = req.body.password;
    return db().employees[idx];
  }, { roles: ['admin'] }),
  route('PATCH', '/employees/:id/status', (req) => {
    const emp = db().employees.find((e) => e.id === req.params.id);
    if (!emp) throw notFound('Employee');
    if (emp.id === req.user!.id) throw badRequest('You cannot deactivate your own account.');
    emp.status = req.body.status === 'inactive' ? 'inactive' : 'active';
    return emp;
  }, { roles: ['admin'] }),

  // ------------------------------------------------------------ projects
  route('GET', '/projects', () => db().projects),
  route('POST', '/projects', (req) => {
    const p: Project = { ...validateProject(req.body), id: newId('prj') };
    db().projects.push(p);
    return p;
  }, { roles: ['admin'] }),
  route('PUT', '/projects/:id', (req) => {
    const idx = db().projects.findIndex((p) => p.id === req.params.id);
    if (idx < 0) throw notFound('Project');
    db().projects[idx] = { ...validateProject(req.body, req.params.id), id: req.params.id };
    return db().projects[idx];
  }, { roles: ['admin'] }),
  route('DELETE', '/projects/:id', (req) => {
    const p = db().projects.find((x) => x.id === req.params.id);
    if (!p) throw notFound('Project');
    const used = db().allocations.some((a) => a.projectId === p.id) || db().timesheets.some((t) => t.entries.some((e) => e.projectId === p.id));
    if (used) throw conflict('This project has allocations or timesheet records and cannot be deleted. Deactivate it instead.');
    db().projects = db().projects.filter((x) => x.id !== p.id);
  }, { roles: ['admin'] }),
  route('PATCH', '/projects/:id/status', (req) => {
    const p = db().projects.find((x) => x.id === req.params.id);
    if (!p) throw notFound('Project');
    p.status = req.body.status;
    return p;
  }, { roles: ['admin'] }),

  // --------------------------------------------------------- allocations
  route('GET', '/allocations', (req) => {
    const user = req.user!;
    let list = db().allocations;
    if (user.systemRole === 'manager') {
      // Own projects + every allocation of team members (needed to show their full capacity).
      const projects = managedProjectIds(user);
      const team = teamEmployeeIds(user);
      list = list.filter((a) => projects.has(a.projectId) || team.has(a.employeeId) || a.employeeId === user.id);
    } else if (user.systemRole === 'associate') {
      list = list.filter((a) => a.employeeId === user.id);
    }
    if (req.query.employeeId) list = list.filter((a) => a.employeeId === req.query.employeeId);
    if (req.query.projectId) list = list.filter((a) => a.projectId === req.query.projectId);
    return list;
  }),
  route('POST', '/allocations', (req) => {
    const a: Allocation = { ...validateAllocation(req.user!, req.body), id: newId('alc') };
    db().allocations.push(a);
    return a;
  }, { roles: ['admin', 'manager'] }),
  route('PUT', '/allocations/:id', (req) => {
    const idx = db().allocations.findIndex((a) => a.id === req.params.id);
    if (idx < 0) throw notFound('Allocation');
    const existing = db().allocations[idx];
    const body = { ...req.body, employeeId: existing.employeeId, projectId: existing.projectId } as AllocationInput;
    db().allocations[idx] = { ...validateAllocation(req.user!, body, existing.id), id: existing.id };
    return db().allocations[idx];
  }, { roles: ['admin', 'manager'] }),
  route('DELETE', '/allocations/:id', (req) => {
    const a = db().allocations.find((x) => x.id === req.params.id);
    if (!a) throw notFound('Allocation');
    if (!canManageProject(req.user!, a.projectId)) throw forbidden();
    db().allocations = db().allocations.filter((x) => x.id !== a.id);
  }, { roles: ['admin', 'manager'] }),

  // ----------------------------------------------------------- calendars
  route('GET', '/calendars', () => db().calendars),
  route('POST', '/calendars', (req) => {
    const cal: WorkCalendar = { ...validateCalendar(req.body), id: newId('cal'), holidays: [] };
    db().calendars.push(cal);
    return cal;
  }, { roles: ['admin'] }),
  route('PUT', '/calendars/:id', (req) => {
    const cal = findCalendar(req.params.id);
    Object.assign(cal, validateCalendar(req.body, cal.id));
    return cal;
  }, { roles: ['admin'] }),
  route('POST', '/calendars/:id/holidays', (req) => {
    const cal = findCalendar(req.params.id);
    const h: Holiday = { ...validateHoliday(cal, req.body), id: newId('hol') };
    cal.holidays = [...cal.holidays, h].sort((a, b) => a.date.localeCompare(b.date));
    return cal;
  }, { roles: ['admin'] }),
  route('PUT', '/calendars/:id/holidays/:holidayId', (req) => {
    const cal = findCalendar(req.params.id);
    if (!cal.holidays.some((h) => h.id === req.params.holidayId)) throw notFound('Holiday');
    const body = validateHoliday(cal, req.body, req.params.holidayId);
    cal.holidays = cal.holidays.map((h) => (h.id === req.params.holidayId ? { ...body, id: h.id } : h)).sort((a, b) => a.date.localeCompare(b.date));
    return cal;
  }, { roles: ['admin'] }),
  route('DELETE', '/calendars/:id/holidays/:holidayId', (req) => {
    const cal = findCalendar(req.params.id);
    cal.holidays = cal.holidays.filter((h) => h.id !== req.params.holidayId);
    return cal;
  }, { roles: ['admin'] }),
];

