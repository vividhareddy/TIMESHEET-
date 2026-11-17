/** Dashboards and reports — every figure is computed from PostgreSQL records at request time. */
import { Router } from 'express';
import { pool } from '../db.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, isISODate, isUuid, str } from '../http.js';
import { LEAVE_COLUMNS, toLeave, type LeaveRow, OVERTIME_COLUMNS, fetchTimesheets, loadAllocations, loadApprovedLeaves, loadCalendars, loadEmployees, toOvertime, type OvertimeRow, type Timesheet } from '../data.js';
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
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM employees WHERE organisation_id = $1 AND status = 'active')   AS active_employees,
       (SELECT count(*) FROM employees WHERE organisation_id = $1 AND status = 'inactive') AS inactive_employees,
       (SELECT count(*) FROM projects  WHERE organisation_id = $1 AND status = 'active')   AS active_projects,
       (SELECT count(*) FROM projects  WHERE organisation_id = $1)                         AS total_projects,
       (SELECT count(*) FROM allocations WHERE organisation_id = $1 AND $2::date BETWEEN start_date AND end_date) AS active_allocations,
       (SELECT count(DISTINCT employee_id) FROM allocations WHERE organisation_id = $1 AND $2::date BETWEEN start_date AND end_date) AS allocated_people,
       (SELECT COALESCE(sum(weekly_hours), 0) FROM allocations WHERE organisation_id = $1 AND $2::date BETWEEN start_date AND end_date) AS weekly_allocated_hours,
       (SELECT count(*) FROM timesheet_entries e JOIN timesheets t ON t.id = e.timesheet_id WHERE t.organisation_id = $1 AND e.status = 'pending') AS pending_approvals`,
    [org, todayISO()],
  );
  const r = rows[0]!;
  res.json({
    activeEmployees: Number(r.active_employees),
    inactiveEmployees: Number(r.inactive_employees),
    activeProjects: Number(r.active_projects),
    totalProjects: Number(r.total_projects),
    activeAllocations: Number(r.active_allocations),
    allocatedPeople: Number(r.allocated_people),
    pendingApprovals: Number(r.pending_approvals),
    weeklyAllocatedHours: Number(r.weekly_allocated_hours),
  });
});

/** GET /api/reports/dashboard/manager — for the signed-in project manager's own projects. */
reportsRouter.get('/dashboard/manager', requireRole('manager', 'admin'), async (_req, res) => {
  const user = currentUser(res);
  const [projects, team] = await Promise.all([managedProjectIds(pool, user), teamEmployeeIds(pool, user)]);
  const ids = [...projects];
  const { rows } = await pool.query<{ status: EntryStatus; n: string }>(
    `SELECT e.status, count(*) AS n FROM timesheet_entries e JOIN timesheets t ON t.id = e.timesheet_id
      WHERE t.organisation_id = $1 AND e.project_id = ANY($2::uuid[]) GROUP BY e.status`,
    [user.organisationId, ids],
  );
  const count = (...s: EntryStatus[]) => sum(rows.filter((r) => s.includes(r.status)).map((r) => Number(r.n)));
  const ot = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM overtime_requests WHERE organisation_id = $1 AND project_id = ANY($2::uuid[]) AND status = 'pending'",
    [user.organisationId, ids],
  );
  res.json({
    assignedProjects: projects.size,
    teamMembers: team.size,
    pendingApprovals: count('pending'),
    approvedEntries: count('approved'),
    returnedEntries: count('returned', 'rejected'),
    pendingOvertime: Number(ot.rows[0]?.n ?? 0),
  });
});

/** GET /api/reports/dashboard/associate — the signed-in employee's current week. */
reportsRouter.get('/dashboard/associate', async (_req, res) => {
  const user = currentUser(res);
  const org = user.organisationId;
  const W = currentWeekStart();
  const [timesheets, calendars, leaves, allocations, pending] = await Promise.all([
    fetchTimesheets(pool, org, { employeeIds: [user.id], weekStart: W }),
    loadCalendars(pool, org),
    loadApprovedLeaves(pool, org, W, addDays(W, 6)),
    loadAllocations(pool, org, { from: W, to: addDays(W, 6), employeeIds: [user.id] }),
    pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM timesheet_entries e JOIN timesheets t ON t.id = e.timesheet_id WHERE t.employee_id = $1 AND e.status = 'pending'",
      [user.id],
    ),
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
    entriesAwaitingApproval: Number(pending.rows[0]?.n ?? 0),
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

  const { rows: projectRows } = await pool.query<{ id: string; name: string; color: string; manager_id: string }>(
    'SELECT id, name, color, manager_id FROM projects WHERE organisation_id = $1 ORDER BY lower(name)',
    [org],
  );
  const visible = user.systemRole === 'admin' ? new Set(projectRows.map((p) => p.id)) : await managedProjectIds(pool, user);
  if (projectId && (!isUuid(projectId) || !visible.has(projectId))) throw new HttpError(403, 'You do not have permission to report on this project.');
  const scope = projectId ? new Set([projectId]) : visible;

  const [employees, calendars, timesheets, allocations, leaves, policy, otRows] = await Promise.all([
    loadEmployees(pool, org),
    loadCalendars(pool, org),
    fetchTimesheets(pool, org, { from, to: weeks[weeks.length - 1]! }),
    loadAllocations(pool, org, { from, to: lastDay }),
    loadApprovedLeaves(pool, org, from, lastDay),
    readPolicy(org),
    pool.query<OvertimeRow>(`SELECT ${OVERTIME_COLUMNS} FROM overtime_requests WHERE organisation_id = $1 AND week_start BETWEEN $2 AND $3`, [org, from, to]),
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
        managerName: nameOf(p.manager_id),
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
  const ot = otRows.rows.map(toOvertime).filter((o) => scope.has(o.projectId) && weekSet.has(o.weekStart));
  const otMap = new Map<string, { employeeId: string; name: string; approved: number; pending: number; rejected: number; payable: number }>();
  for (const o of ot) {
    const row = otMap.get(o.employeeId) ?? { employeeId: o.employeeId, name: nameOf(o.employeeId), approved: 0, pending: 0, rejected: 0, payable: 0 };
    row[o.status] = sum([row[o.status], o.hours]);
    if (o.status === 'approved') row.payable = sum([row.payable, o.hours * policy.weekdayMultiplier]);
    otMap.set(o.employeeId, row);
  }

  const projectName = (id: string) => projectById.get(id)?.name ?? '—';

  // Overtime by project, and the individual records behind both summaries.
  const otProjects = new Map<string, { projectId: string; name: string; color: string; employees: Set<string>; approved: number; pending: number; rejected: number; payable: number }>();
  for (const o of ot) {
    const p = projectById.get(o.projectId);
    const row = otProjects.get(o.projectId) ?? { projectId: o.projectId, name: p?.name ?? '—', color: p?.color ?? '', employees: new Set<string>(), approved: 0, pending: 0, rejected: 0, payable: 0 };
    row.employees.add(o.employeeId);
    row[o.status] = sum([row[o.status], o.hours]);
    if (o.status === 'approved') row.payable = sum([row.payable, o.hours * policy.weekdayMultiplier]);
    otProjects.set(o.projectId, row);
  }
  const overtimeByProject = [...otProjects.values()]
    .map(({ employees: people, ...r }) => ({ ...r, employees: people.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const overtimeRecords = ot
    .map((o) => ({
      id: o.id,
      employeeName: nameOf(o.employeeId),
      projectName: projectName(o.projectId),
      weekStart: o.weekStart,
      date: o.date ?? null,
      hours: o.hours,
      source: o.source,
      status: o.status,
      reason: o.reason,
    }))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.employeeName.localeCompare(b.employeeName));

  // Timesheet status: one row per employee and week for everyone allocated to a project in scope.
  // Statuses consider only the entries on in-scope projects (drafts included).
  const tsByKey = new Map(timesheets.filter((t) => weekSet.has(t.weekStart)).map((t) => [`${t.employeeId}|${t.weekStart}`, t]));
  const timesheetRows: Array<{ employeeId: string; name: string; weekStart: string; status: string; hours: number; submittedAt: string | null }> = [];
  for (const w of weeks) {
    const people = new Set(scopedAllocs.filter((a) => overlapsWeek(a, w)).map((a) => a.employeeId));
    // Anyone who logged time on an in-scope project that week is included even without an allocation.
    for (const t of timesheets) if (t.weekStart === w && t.entries.some((e) => scope.has(e.projectId))) people.add(t.employeeId);
    for (const id of people) {
      const emp = employees.get(id);
      if (!emp) continue;
      const ts = tsByKey.get(`${id}|${w}`);
      const scoped = ts ? { ...ts, entries: ts.entries.filter((e) => scope.has(e.projectId)) } : undefined;
      timesheetRows.push({
        employeeId: id,
        name: emp.name,
        weekStart: w,
        status: deriveTimesheetStatus(scoped),
        hours: scoped ? sum(scoped.entries.map(entryTotal)) : 0,
        submittedAt: scoped?.entries.some((e) => e.status !== 'draft') ? (ts?.submittedAt ?? null) : null,
      });
    }
  }
  timesheetRows.sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.name.localeCompare(b.name));
  const timesheetCounts: Record<string, number> = {};
  for (const r of timesheetRows) timesheetCounts[r.status] = (timesheetCounts[r.status] ?? 0) + 1;

  // Compliance: weekly submission completion and what is still waiting for approval.
  const NOT_SUBMITTED = new Set(['not_started', 'draft']);
  const complianceWeeks = weeks.map((w) => {
    const rows = timesheetRows.filter((r) => r.weekStart === w);
    const submitted = rows.filter((r) => !NOT_SUBMITTED.has(r.status)).length;
    const pendingFacts = facts.filter((f) => f.t.weekStart === w && f.e.status === 'pending');
    return {
      weekStart: w,
      expected: rows.length,
      submitted,
      notSubmitted: rows.length - submitted,
      completion: rows.length ? Math.round((submitted / rows.length) * 100) : 100,
      pendingEntries: pendingFacts.length,
      pendingHours: hoursOf(pendingFacts),
    };
  });
  const missingSubmissions = timesheetRows
    .filter((r) => NOT_SUBMITTED.has(r.status))
    .map((r) => ({ weekStart: r.weekStart, employeeId: r.employeeId, name: r.name, status: r.status }));
  const today = todayISO();
  const pendingApprovals = facts
    .filter((f) => f.e.status === 'pending')
    .map((f) => {
      const p = projectById.get(f.e.projectId);
      const since = f.t.submittedAt?.slice(0, 10) ?? f.t.updatedAt.slice(0, 10);
      return {
        employeeName: nameOf(f.t.employeeId),
        projectName: p?.name ?? '—',
        approverName: p ? nameOf(p.manager_id) : '—',
        weekStart: f.t.weekStart,
        hours: f.hours,
        submittedOn: since,
        daysWaiting: Math.max(0, Math.round((Date.parse(today) - Date.parse(since)) / 86_400_000)),
      };
    })
    .sort((a, b) => b.daysWaiting - a.daysWaiting);

  // Leave: requests whose date falls in the period. Admins without a project filter see everyone;
  // otherwise people allocated to in-scope projects (plus a manager's own team).
  let leaveScope: Set<string> | 'all' = 'all';
  if (projectId || user.systemRole !== 'admin') {
    leaveScope = new Set(scopedAllocs.filter((a) => weeks.some((w) => overlapsWeek(a, w))).map((a) => a.employeeId));
    if (user.systemRole === 'manager' && !projectId) for (const id of await teamEmployeeIds(pool, user)) leaveScope.add(id);
  }
  const { rows: leaveRows } = await pool.query<LeaveRow>(
    `SELECT ${LEAVE_COLUMNS} FROM leave_requests WHERE organisation_id = $1 AND status <> 'withdrawn' AND date BETWEEN $2 AND $3 ORDER BY date DESC`,
    [org, from, lastDay],
  );
  const leaveRequests = leaveRows.map(toLeave).filter((l) => leaveScope === 'all' || leaveScope.has(l.employeeId));
  const leaveDays = (d: 'full' | 'half') => (d === 'full' ? 1 : 0.5);
  const leaveMap = new Map<string, { employeeId: string; name: string; requests: number; approvedDays: number; pendingDays: number; rejectedDays: number; approvedHours: number }>();
  for (const l of leaveRequests) {
    const row = leaveMap.get(l.employeeId) ?? { employeeId: l.employeeId, name: nameOf(l.employeeId), requests: 0, approvedDays: 0, pendingDays: 0, rejectedDays: 0, approvedHours: 0 };
    row.requests += 1;
    if (l.status === 'approved') {
      row.approvedDays = sum([row.approvedDays, leaveDays(l.duration)]);
      row.approvedHours = sum([row.approvedHours, l.hours]);
    } else if (l.status === 'pending') row.pendingDays = sum([row.pendingDays, leaveDays(l.duration)]);
    else if (l.status === 'rejected') row.rejectedDays = sum([row.rejectedDays, leaveDays(l.duration)]);
    leaveMap.set(l.employeeId, row);
  }
  const leaveRecords = leaveRequests.map((l) => ({
    id: l.id,
    employeeName: nameOf(l.employeeId),
    date: l.date,
    duration: l.duration,
    hours: l.hours,
    status: l.status,
    reason: l.reason,
    reviewerName: l.reviewerId ? nameOf(l.reviewerId) : null,
    reviewerComment: l.reviewerComment ?? null,
  }));

  res.json({
    from,
    to: lastDay,
    timesheetStatus: { counts: timesheetCounts, rows: timesheetRows },
    compliance: { weeks: complianceWeeks, missing: missingSubmissions, pendingApprovals },
    overtimeByProject,
    overtimeRecords,
    leave: { employees: [...leaveMap.values()].sort((a, b) => a.name.localeCompare(b.name)), records: leaveRecords },
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
