/** Dashboards and reports — every figure is computed from the stored MongoDB records at request time. */
import { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, isISODate, isUuid, str } from '../http.js';
import { countEntriesByStatus, fetchTimesheets, loadAllocations, loadApprovedLeaves, loadCalendars, loadEmployees, toOvertime, type OvertimeLean, type Timesheet } from '../data.js';
import { CASE_INSENSITIVE } from '../models/common.js';
import { EmployeeModel } from '../models/employee.js';
import { AllocationModel, Project } from '../models/project.js';
import { OvertimeRequestModel } from '../models/requests.js';
import { managedProjectIds, teamEmployeeIds } from '../scope.js';
import { readPolicy } from './organisation.js';
import { addDays, currentWeekStart, startOfWeek, sum, todayISO } from '../lib/dates.js';
import { allocationsForWeek, entryTotal, expectedWeekHours, overlapsWeek } from '../lib/workCalc.js';

type EntryStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'returned';

function deriveTimesheetStatus(ts: Timesheet | undefined): string {
  if (!ts || ts.entries.length === 0) return 'not_started';
  const s = ts.entries.map((e) => e.status);
  if (s.every((x) => x === 'draft')) return 'draft';
  if (s.some((x) => x === 'returned')) return 'returned';
  if (s.some((x) => x === 'rejected')) return 'rejected';
  if (s.every((x) => x === 'approved')) return 'approved';
  if (s.some((x) => x === 'approved')) return 'partially_approved';
  return 'submitted';
}

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

/** GET /api/reports/dashboard/admin */
reportsRouter.get('/dashboard/admin', requireRole('admin'), async (_req, res) => {
  const org = currentUser(res).organisationId;
  const today = todayISO();
  const [activeEmployees, inactiveEmployees, activeProjects, totalProjects, currentAllocations, entryCounts] = await Promise.all([
    EmployeeModel.countDocuments({ organisationId: org, status: 'active' }),
    EmployeeModel.countDocuments({ organisationId: org, status: 'inactive' }),
    Project.countDocuments({ organisationId: org, status: 'active' }),
    Project.countDocuments({ organisationId: org }),
    // Allocations in force today.
    AllocationModel.find({ organisationId: org, startDate: { $lte: today }, endDate: { $gte: today } })
      .select('employeeId weeklyHours')
      .lean<Array<{ employeeId: string; weeklyHours: number }>>(),
    countEntriesByStatus({ organisationId: org }, { status: 'pending' }),
  ]);
  res.json({
    activeEmployees,
    inactiveEmployees,
    activeProjects,
    totalProjects,
    activeAllocations: currentAllocations.length,
    allocatedPeople: new Set(currentAllocations.map((a) => a.employeeId)).size,
    pendingApprovals: entryCounts.get('pending') ?? 0,
    weeklyAllocatedHours: sum(currentAllocations.map((a) => a.weeklyHours)),
  });
});

/** GET /api/reports/dashboard/manager — for the signed-in project manager's own projects. */
reportsRouter.get('/dashboard/manager', requireRole('manager', 'admin'), async (_req, res) => {
  const user = currentUser(res);
  const [projects, team] = await Promise.all([managedProjectIds(user), teamEmployeeIds(user)]);
  const ids = [...projects];
  const [counts, pendingOvertime] = await Promise.all([
    countEntriesByStatus({ organisationId: user.organisationId }, { projectId: { $in: ids } }),
    OvertimeRequestModel.countDocuments({ organisationId: user.organisationId, projectId: { $in: ids }, status: 'pending' }),
  ]);
  const count = (...statuses: EntryStatus[]) => sum(statuses.map((s) => counts.get(s) ?? 0));
  res.json({
    assignedProjects: projects.size,
    teamMembers: team.size,
    pendingApprovals: count('pending'),
    approvedEntries: count('approved'),
    returnedEntries: count('returned', 'rejected'),
    pendingOvertime,
  });
});

/** GET /api/reports/dashboard/associate — the signed-in employee's current week. */
reportsRouter.get('/dashboard/associate', async (_req, res) => {
  const user = currentUser(res);
  const org = user.organisationId;
  const W = currentWeekStart();
  const [timesheets, calendars, leaves, allocations, pending] = await Promise.all([
    fetchTimesheets(org, { employeeIds: [user.id], weekStart: W }),
    loadCalendars(org),
    loadApprovedLeaves(org, W, addDays(W, 6)),
    loadAllocations(org, { from: W, to: addDays(W, 6), employeeIds: [user.id] }),
    countEntriesByStatus({ employeeId: user.id }, { status: 'pending' }),
  ]);
  const ts = timesheets[0];
  const expected = expectedWeekHours(user, calendars.get(user.calendarId), leaves, W);
  const entered = ts ? sum(ts.entries.map(entryTotal)) : 0;
  res.json({
    assignedProjects: allocationsForWeek(allocations, user.id, W).length,
    weeklyTarget: user.weeklyCapacity,
    expectedHours: expected,
    enteredHours: entered,
    remainingHours: Math.max(0, expected - entered),
    currentStatus: deriveTimesheetStatus(ts),
    entriesAwaitingApproval: pending.get('pending') ?? 0,
  });
});

/** GET /api/reports/hours?from=&to=&projectId= — weeks are inclusive Mondays (max 104). */
reportsRouter.get('/hours', requireRole('admin', 'manager'), async (req, res) => {
  const user = currentUser(res);
  const org = user.organisationId;
  const fromQ = str(req.query.from);
  const toQ = str(req.query.to);
  const projectId = str(req.query.projectId);
  if (!isISODate(fromQ) || !isISODate(toQ)) throw new HttpError(400, 'Provide a valid from/to week range.');
  const from = startOfWeek(fromQ);
  const to = startOfWeek(toQ);
  if (to < from) throw new HttpError(400, 'Provide a valid from/to week range.');
  const weeks: string[] = [];
  for (let w = from; w <= to && weeks.length < 104; w = addDays(w, 7)) weeks.push(w);
  const lastDay = addDays(weeks[weeks.length - 1]!, 6);
  const weekSet = new Set(weeks);

  const projectDocs = await Project.find({ organisationId: org })
    .select('name color managerId')
    .collation(CASE_INSENSITIVE)
    .sort({ name: 1 })
    .lean<Array<{ _id: string; name: string; color: string; managerId: string }>>();
  const projectRows = projectDocs.map((p) => ({ id: p._id, name: p.name, color: p.color, managerId: p.managerId }));
  const visible = user.systemRole === 'admin' ? new Set(projectRows.map((p) => p.id)) : await managedProjectIds(user);
  if (projectId && (!isUuid(projectId) || !visible.has(projectId))) throw new HttpError(403, 'You do not have permission to report on this project.');
  const scope = projectId ? new Set([projectId]) : visible;

  const [employees, calendars, timesheets, allocations, leaves, policy, otDocs] = await Promise.all([
    loadEmployees(org),
    loadCalendars(org),
    fetchTimesheets(org, { from, to: weeks[weeks.length - 1]! }),
    loadAllocations(org, { from, to: lastDay }),
    loadApprovedLeaves(org, from, lastDay),
    readPolicy(org),
    OvertimeRequestModel.find({ organisationId: org, weekStart: { $gte: from, $lte: to } }).lean<OvertimeLean[]>(),
  ]);

  const facts = timesheets
    .filter((t) => weekSet.has(t.weekStart))
    .flatMap((t) => t.entries.filter((e) => e.status !== 'draft' && scope.has(e.projectId)).map((e) => ({ t, e, hours: entryTotal(e) })));
  const scopedAllocs = allocations.filter((a) => scope.has(a.projectId));
  const hoursOf = (list: typeof facts, status?: EntryStatus) => sum(list.filter((f) => !status || f.e.status === status).map((f) => f.hours));
  const nameOf = (id: string) => employees.get(id)?.name ?? '—';

  // Employees
  const empIds = new Set([...facts.map((f) => f.t.employeeId), ...scopedAllocs.filter((a) => weeks.some((w) => overlapsWeek(a, w))).map((a) => a.employeeId)]);
  const employeeRows = [...empIds]
    .map((id) => employees.get(id))
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map((emp) => {
      const mine = facts.filter((f) => f.t.employeeId === emp.id);
      return {
        employeeId: emp.id,
        name: emp.name,
        designation: emp.designation,
        projects: new Set(mine.map((f) => f.e.projectId)).size,
        expected: sum(weeks.map((w) => expectedWeekHours(emp, calendars.get(emp.calendarId), leaves, w))),
        allocated: sum(weeks.map((w) => sum(scopedAllocs.filter((a) => a.employeeId === emp.id && overlapsWeek(a, w)).map((a) => a.weeklyHours)))),
        actual: hoursOf(mine),
        approved: hoursOf(mine, 'approved'),
        pending: hoursOf(mine, 'pending'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Projects
  const projects = projectRows
    .filter((p) => scope.has(p.id))
    .map((p) => {
      const mine = facts.filter((f) => f.e.projectId === p.id);
      const allocs = allocations.filter((a) => a.projectId === p.id);
      return {
        projectId: p.id,
        name: p.name,
        color: p.color,
        managerName: nameOf(p.managerId),
        team: new Set(allocs.filter((a) => weeks.some((w) => overlapsWeek(a, w))).map((a) => a.employeeId)).size,
        allocated: sum(weeks.map((w) => sum(allocs.filter((a) => overlapsWeek(a, w)).map((a) => a.weeklyHours)))),
        actual: hoursOf(mine),
        approved: hoursOf(mine, 'approved'),
        pending: hoursOf(mine, 'pending'),
      };
    });

  // Allocation vs actual (per employee × project)
  const projectById = new Map(projectRows.map((p) => [p.id, p]));
  const allocMap = new Map<string, { employeeId: string; employeeName: string; projectId: string; projectName: string; color: string; allocated: number; actual: number }>();
  for (const w of weeks) {
    for (const a of scopedAllocs.filter((x) => overlapsWeek(x, w))) {
      const key = `${a.employeeId}|${a.projectId}`;
      const p = projectById.get(a.projectId);
      const row = allocMap.get(key) ?? { employeeId: a.employeeId, employeeName: nameOf(a.employeeId), projectId: a.projectId, projectName: p?.name ?? '—', color: p?.color ?? '', allocated: 0, actual: 0 };
      row.allocated = sum([row.allocated, a.weeklyHours]);
      allocMap.set(key, row);
    }
  }
  for (const f of facts) {
    const row = allocMap.get(`${f.t.employeeId}|${f.e.projectId}`);
    if (row) row.actual = sum([row.actual, f.hours]);
  }

  // Weekly series & status counts
  const countStatuses = (list: typeof facts) => {
    const counts: Partial<Record<EntryStatus, number>> = {};
    list.forEach((f) => (counts[f.e.status] = (counts[f.e.status] ?? 0) + 1));
    return counts;
  };
  const weekly = weeks.map((w) => {
    const wk = facts.filter((f) => f.t.weekStart === w);
    return { weekStart: w, actual: hoursOf(wk), allocated: sum(scopedAllocs.filter((a) => overlapsWeek(a, w)).map((a) => a.weeklyHours)), counts: countStatuses(wk) };
  });

  // Overtime
  const ot = otDocs.map(toOvertime).filter((o) => scope.has(o.projectId) && weekSet.has(o.weekStart));
  const otMap = new Map<string, { employeeId: string; name: string; approved: number; pending: number; rejected: number; payable: number }>();
  for (const o of ot) {
    const row = otMap.get(o.employeeId) ?? { employeeId: o.employeeId, name: nameOf(o.employeeId), approved: 0, pending: 0, rejected: 0, payable: 0 };
    row[o.status] = sum([row[o.status], o.hours]);
    if (o.status === 'approved') row.payable = sum([row.payable, o.hours * policy.weekdayMultiplier]);
    otMap.set(o.employeeId, row);
  }

  res.json({
    weeks,
    totals: {
      actual: hoursOf(facts),
      approved: hoursOf(facts, 'approved'),
      pending: hoursOf(facts, 'pending'),
      overtime: sum(ot.filter((o) => o.status !== 'rejected').map((o) => o.hours)),
      entries: facts.length,
    },
    statusCounts: countStatuses(facts),
    weekly,
    employees: employeeRows,
    projects,
    allocation: [...allocMap.values()],
    overtime: [...otMap.values()],
    overtimeMultiplier: policy.weekdayMultiplier,
  });
});
