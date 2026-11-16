/** Aggregations computed from database records (GROUP BY queries in the real backend). */
import type { EntryStatus } from '@/types';
import type {
  AdminDashboardSummary,
  AllocationActualRow,
  AssociateDashboardSummary,
  EmployeeHoursRow,
  HoursReport,
  ManagerDashboardSummary,
  OvertimeSummaryRow,
  ProjectHoursRow,
} from '@/types/api';
import { addDays, currentWeekStart, startOfWeek, todayISO } from '@/utils/date';
import { sum } from '@/utils/format';
import { activeAllocationsOn, allocationsForWeek, deriveTimesheetStatus, entryTotal, expectedWeekHours, timesheetTotal } from '@/utils/timesheet';
import { badRequest, forbidden, route } from '../http';
import { calendarOf, db, managedProjectIds, teamEmployeeIds } from './scope';

const overlapsWeek = (a: { startDate: string; endDate: string }, w: string) => a.startDate <= addDays(w, 6) && a.endDate >= w;

export const reportRoutes = [
  route('GET', '/reports/dashboard/admin', (): AdminDashboardSummary => {
    const d = db();
    const active = activeAllocationsOn(d.allocations, todayISO());
    return {
      activeEmployees: d.employees.filter((e) => e.status === 'active').length,
      inactiveEmployees: d.employees.filter((e) => e.status === 'inactive').length,
      activeProjects: d.projects.filter((p) => p.status === 'active').length,
      totalProjects: d.projects.length,
      activeAllocations: active.length,
      allocatedPeople: new Set(active.map((a) => a.employeeId)).size,
      pendingApprovals: d.timesheets.flatMap((t) => t.entries).filter((e) => e.status === 'pending').length,
      weeklyAllocatedHours: sum(active.map((a) => a.weeklyHours)),
    };
  }, { roles: ['admin'] }),

  route('GET', '/reports/dashboard/manager', (req): ManagerDashboardSummary => {
    const user = req.user!;
    const projects = managedProjectIds(user);
    const entries = db().timesheets.flatMap((t) => t.entries).filter((e) => projects.has(e.projectId));
    return {
      assignedProjects: projects.size,
      teamMembers: teamEmployeeIds(user).size,
      pendingApprovals: entries.filter((e) => e.status === 'pending').length,
      approvedEntries: entries.filter((e) => e.status === 'approved').length,
      returnedEntries: entries.filter((e) => e.status === 'returned' || e.status === 'rejected').length,
      pendingOvertime: db().overtime.filter((o) => projects.has(o.projectId) && o.status === 'pending').length,
    };
  }, { roles: ['manager', 'admin'] }),

  route('GET', '/reports/dashboard/associate', (req): AssociateDashboardSummary => {
    const user = req.user!;
    const W = currentWeekStart();
    const ts = db().timesheets.find((t) => t.employeeId === user.id && t.weekStart === W);
    const expected = expectedWeekHours(user, calendarOf(user), db().leaves, W);
    const entered = timesheetTotal(ts);
    return {
      assignedProjects: allocationsForWeek(db().allocations, user.id, W).length,
      weeklyTarget: user.weeklyCapacity,
      expectedHours: expected,
      enteredHours: entered,
      remainingHours: Math.max(0, expected - entered),
      currentStatus: deriveTimesheetStatus(ts),
      entriesAwaitingApproval: db().timesheets.filter((t) => t.employeeId === user.id).flatMap((t) => t.entries).filter((e) => e.status === 'pending').length,
    };
  }),

  route('GET', '/reports/hours', (req): HoursReport => {
    const user = req.user!;
    if (user.systemRole === 'associate') throw forbidden();
    const from = req.query.from ? startOfWeek(req.query.from) : '';
    const to = req.query.to ? startOfWeek(req.query.to) : '';
    if (!from || !to || to < from) throw badRequest('Provide a valid from/to week range.');
    const weeks: string[] = [];
    for (let w = from; w <= to && weeks.length < 104; w = addDays(w, 7)) weeks.push(w);
    const weekSet = new Set(weeks);

    const d = db();
    const visibleProjects = user.systemRole === 'admin' ? new Set(d.projects.map((p) => p.id)) : managedProjectIds(user);
    if (req.query.projectId && !visibleProjects.has(req.query.projectId)) throw forbidden();
    const scope = req.query.projectId ? new Set([req.query.projectId]) : visibleProjects;

    const facts = d.timesheets
      .filter((t) => weekSet.has(t.weekStart))
      .flatMap((t) => t.entries.filter((e) => e.status !== 'draft' && scope.has(e.projectId)).map((e) => ({ t, e, hours: entryTotal(e) })));
    const scopedAllocs = d.allocations.filter((a) => scope.has(a.projectId));

    // Employees
    const empIds = new Set([...facts.map((f) => f.t.employeeId), ...scopedAllocs.filter((a) => weeks.some((w) => overlapsWeek(a, w))).map((a) => a.employeeId)]);
    const employees: EmployeeHoursRow[] = [...empIds]
      .map((id) => d.employees.find((e) => e.id === id))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((emp) => {
        const mine = facts.filter((f) => f.t.employeeId === emp.id);
        return {
          employeeId: emp.id,
          name: emp.name,
          designation: emp.designation,
          projects: new Set(mine.map((f) => f.e.projectId)).size,
          expected: sum(weeks.map((w) => expectedWeekHours(emp, calendarOf(emp), d.leaves, w))),
          allocated: sum(weeks.map((w) => sum(scopedAllocs.filter((a) => a.employeeId === emp.id && overlapsWeek(a, w)).map((a) => a.weeklyHours)))),
          actual: sum(mine.map((f) => f.hours)),
          approved: sum(mine.filter((f) => f.e.status === 'approved').map((f) => f.hours)),
          pending: sum(mine.filter((f) => f.e.status === 'pending').map((f) => f.hours)),
        };
      });

    // Projects
    const projects: ProjectHoursRow[] = d.projects
      .filter((p) => scope.has(p.id))
      .map((p) => {
        const mine = facts.filter((f) => f.e.projectId === p.id);
        return {
          projectId: p.id,
          name: p.name,
          color: p.color,
          managerName: d.employees.find((e) => e.id === p.managerId)?.name ?? '—',
          team: new Set(d.allocations.filter((a) => a.projectId === p.id && weeks.some((w) => overlapsWeek(a, w))).map((a) => a.employeeId)).size,
          allocated: sum(weeks.map((w) => sum(d.allocations.filter((a) => a.projectId === p.id && overlapsWeek(a, w)).map((a) => a.weeklyHours)))),
          actual: sum(mine.map((f) => f.hours)),
          approved: sum(mine.filter((f) => f.e.status === 'approved').map((f) => f.hours)),
          pending: sum(mine.filter((f) => f.e.status === 'pending').map((f) => f.hours)),
        };
      });

    // Allocation vs actual
    const allocMap = new Map<string, AllocationActualRow>();
    for (const w of weeks) {
      for (const a of scopedAllocs.filter((x) => overlapsWeek(x, w))) {
        const key = `${a.employeeId}|${a.projectId}`;
        const p = d.projects.find((x) => x.id === a.projectId);
        const row = allocMap.get(key) ?? {
          employeeId: a.employeeId,
          employeeName: d.employees.find((e) => e.id === a.employeeId)?.name ?? '—',
          projectId: a.projectId,
          projectName: p?.name ?? '—',
          color: p?.color ?? '',
          allocated: 0,
          actual: 0,
        };
        row.allocated += a.weeklyHours;
        allocMap.set(key, row);
      }
    }
    for (const f of facts) {
      const row = allocMap.get(`${f.t.employeeId}|${f.e.projectId}`);
      if (row) row.actual += f.hours;
    }

    // Weekly series & status counts
    const statusCounts: Partial<Record<EntryStatus, number>> = {};
    facts.forEach((f) => (statusCounts[f.e.status] = (statusCounts[f.e.status] ?? 0) + 1));
    const weekly = weeks.map((w) => {
      const wk = facts.filter((f) => f.t.weekStart === w);
      const counts: Partial<Record<EntryStatus, number>> = {};
      wk.forEach((f) => (counts[f.e.status] = (counts[f.e.status] ?? 0) + 1));
      return { weekStart: w, actual: sum(wk.map((f) => f.hours)), allocated: sum(scopedAllocs.filter((a) => overlapsWeek(a, w)).map((a) => a.weeklyHours)), counts };
    });

    // Overtime
    const ot = d.overtime.filter((o) => scope.has(o.projectId) && weekSet.has(o.weekStart));
    const otMap = new Map<string, OvertimeSummaryRow>();
    for (const o of ot) {
      const row = otMap.get(o.employeeId) ?? { employeeId: o.employeeId, name: d.employees.find((e) => e.id === o.employeeId)?.name ?? '—', approved: 0, pending: 0, rejected: 0, payable: 0 };
      row[o.status] += o.hours;
      if (o.status === 'approved') row.payable += o.hours * d.policy.weekdayMultiplier;
      otMap.set(o.employeeId, row);
    }

    return {
      weeks,
      totals: {
        actual: sum(facts.map((f) => f.hours)),
        approved: sum(facts.filter((f) => f.e.status === 'approved').map((f) => f.hours)),
        pending: sum(facts.filter((f) => f.e.status === 'pending').map((f) => f.hours)),
        overtime: sum(ot.filter((o) => o.status !== 'rejected').map((o) => o.hours)),
        entries: facts.length,
      },
      statusCounts,
      weekly,
      employees,
      projects,
      allocation: [...allocMap.values()],
      overtime: [...otMap.values()],
      overtimeMultiplier: d.policy.weekdayMultiplier,
    };
  }, { roles: ['admin', 'manager'] }),
];
