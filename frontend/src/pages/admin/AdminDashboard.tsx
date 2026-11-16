import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarDays, ClipboardCheck, Clock, FolderKanban, Network, Users } from 'lucide-react';
import { useAppData } from '@/context/AppDataContext';
import { useLookups } from '@/hooks/useLookups';
import { addDays, currentWeekStart, formatDate, formatDateTime, formatWeekRange, todayISO } from '@/utils/date';
import { formatHours, percent, sum } from '@/utils/format';
import { activeAllocationsOn, allocationHealth, deriveTimesheetStatus } from '@/utils/timesheet';
import { EmptyState, PageHeader, PersonCell, ProjectDot, ProgressBar } from '@/components/common/Misc';
import { SummaryStats } from '@/components/common/SummaryStats';
import { SetupChecklist } from '@/components/common/SetupChecklist';
import { useApiQuery } from '@/hooks/useApiQuery';
import { reportService } from '@/services';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { StatusBadge, Badge } from '@/components/common/Badge';
import { StackedBar } from '@/components/common/Charts';
import { ApprovalHistory } from '@/components/timesheet/ApprovalHistory';

export function AdminDashboard() {
  const { employees, projects, allocations, timesheets, calendars } = useAppData();
  const { employeeName } = useLookups();
  const today = todayISO();
  const lastWeek = addDays(currentWeekStart(), -7);

  // Headline figures are aggregated by the API; refetched whenever local records change.
  const summary = useApiQuery(() => reportService.adminDashboard(), [employees, projects, allocations, timesheets]);

  const activeEmployees = employees.filter((e) => e.status === 'active');
  const activeProjects = projects.filter((p) => p.status === 'active');
  const activeAllocs = activeAllocationsOn(allocations, today);
  const weeklyAllocated = sum(activeAllocs.map((a) => a.weeklyHours));

  const distribution = activeProjects.map((p) => {
    const allocs = activeAllocs.filter((a) => a.projectId === p.id);
    return { project: p, people: allocs.length, hours: sum(allocs.map((a) => a.weeklyHours)) };
  });

  const health = useMemo(() => {
    return activeEmployees
      .filter((e) => e.systemRole === 'associate')
      .map((e) => {
        const allocs = activeAllocs.filter((a) => a.employeeId === e.id);
        const total = sum(allocs.map((a) => a.weeklyHours));
        return { emp: e, allocs, total, state: allocationHealth(total, e.weeklyCapacity) };
      })
      .filter((x) => x.state !== 'optimal');
  }, [activeEmployees, activeAllocs]);

  const associates = activeEmployees.filter((e) => e.systemRole === 'associate');
  const lastWeekStatus = associates.map((e) => ({ emp: e, status: deriveTimesheetStatus(timesheets.find((t) => t.employeeId === e.id && t.weekStart === lastWeek)) }));
  const submittedCount = lastWeekStatus.filter((s) => !['not_started', 'draft'].includes(s.status)).length;

  const recentEvents = timesheets
    .flatMap((t) => t.history.filter((h) => h.action !== 'saved'))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 6);

  const upcomingHolidays = calendars
    .flatMap((c) => c.holidays.filter((h) => h.date >= today).map((h) => ({ ...h, calendar: c.name, country: c.country })))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 6);

  return (
    <div>
      <PageHeader title="Admin Dashboard" description={`Organisation overview · ${formatDate(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`} />

      <SetupChecklist />

      <SummaryStats
        query={summary}
        className="xl:grid-cols-5"
        stats={[
          { label: 'Total employees', icon: Users, to: '/admin/employees', value: (s) => s.activeEmployees, hint: (s) => `${s.inactiveEmployees} inactive` },
          { label: 'Active projects', icon: FolderKanban, tone: 'green', to: '/admin/projects', value: (s) => s.activeProjects, hint: (s) => `${s.totalProjects} total` },
          { label: 'Active allocations', icon: Network, tone: 'violet', to: '/admin/allocations', value: (s) => s.activeAllocations, hint: (s) => `${s.allocatedPeople} people allocated` },
          { label: 'Pending approvals', icon: ClipboardCheck, tone: 'amber', to: '/admin/approvals', value: (s) => s.pendingApprovals, hint: () => 'Entries awaiting PMs' },
          { label: 'Weekly allocation', icon: Clock, tone: 'slate', value: (s) => formatHours(s.weeklyAllocatedHours), hint: (s) => `Hours across ${s.activeProjects} projects` },
        ]}
      />

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Project-wise resource distribution" description="Active allocations by project this week." actions={<Link to="/admin/allocations" className="text-xs font-medium text-brand-600 hover:text-brand-700">Manage allocations</Link>} />
          <CardBody>
            {distribution.length === 0 ? (
              <EmptyState icon={FolderKanban} title="No active projects" description="Create projects and allocate employees to see how resources are distributed." action={<Link to="/admin/projects" className="text-sm font-medium text-brand-600">Go to Projects</Link>} />
            ) : (<>
            <StackedBar className="h-3" total={weeklyAllocated} segments={distribution.map((d) => ({ value: d.hours, color: d.project.color, label: d.project.name }))} />
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="py-2 text-left font-semibold">Project</th>
                    <th className="py-2 text-left font-semibold">Project manager</th>
                    <th className="py-2 text-right font-semibold">Resources</th>
                    <th className="py-2 text-right font-semibold">Weekly hours</th>
                    <th className="w-40 py-2 pl-4 text-left font-semibold">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {distribution.map((d) => (
                    <tr key={d.project.id}>
                      <td className="py-2.5"><span className="flex items-center gap-2 font-medium text-slate-800"><ProjectDot color={d.project.color} />{d.project.name}</span></td>
                      <td className="py-2.5 text-slate-600">{employeeName(d.project.managerId)}</td>
                      <td className="py-2.5 text-right tabular-nums">{d.people}</td>
                      <td className="py-2.5 text-right font-medium tabular-nums">{formatHours(d.hours)}</td>
                      <td className="py-2.5 pl-4">
                        <div className="flex items-center gap-2">
                          <ProgressBar value={d.hours} max={weeklyAllocated} className="flex-1" />
                          <span className="w-9 text-right text-xs tabular-nums text-slate-500">{percent(d.hours, weeklyAllocated)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>)}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Last week's submissions" description={formatWeekRange(lastWeek)} actions={<Link to="/admin/timesheets" className="text-xs font-medium text-brand-600 hover:text-brand-700">View all</Link>} />
          <CardBody>
            <div className="mb-4 flex items-end justify-between">
              <p className="text-2xl font-semibold text-slate-900">{submittedCount}<span className="text-base font-normal text-slate-400"> / {associates.length}</span></p>
              <p className="text-xs text-slate-500">timesheets submitted</p>
            </div>
            <ProgressBar value={submittedCount} max={associates.length} tone="green" />
            {associates.length === 0 && <p className="mt-4 text-sm text-slate-500">No associates yet.</p>}
            <ul className="mt-4 divide-y divide-slate-100">
              {lastWeekStatus.map(({ emp, status }) => (
                <li key={emp.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="truncate text-slate-700">{emp.name}</span>
                  <StatusBadge status={status} />
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Allocation exceptions" description="Employees not at 100% of weekly capacity." />
          <CardBody className="p-0">
            {health.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-500">{associates.length ? 'All associates are fully allocated.' : 'No associates yet.'}</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {health.map(({ emp, total, state }) => (
                  <li key={emp.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <PersonCell name={emp.name} sub={`${formatHours(total)} of ${formatHours(emp.weeklyCapacity)}`} />
                    <StatusBadge status={state} />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent approval activity" actions={<Link to="/admin/approvals" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700">Approvals <ArrowRight className="h-3 w-3" /></Link>} />
          <CardBody>
            <ApprovalHistory events={recentEvents} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Upcoming holidays" actions={<Link to="/admin/calendars" className="text-xs font-medium text-brand-600 hover:text-brand-700">Calendars</Link>} />
          <CardBody className="p-0">
            <ul className="divide-y divide-slate-100">
              {upcomingHolidays.map((h) => (
                <li key={`${h.calendar}-${h.id}`} className="flex items-center gap-3 px-5 py-3">
                  <span className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-md border border-slate-200 bg-slate-50 leading-none">
                    <span className="text-[10px] uppercase text-slate-500">{formatDate(h.date, { month: 'short' })}</span>
                    <span className="text-sm font-semibold text-slate-800">{formatDate(h.date, { day: 'numeric' })}</span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{h.name}</p>
                    <p className="text-xs text-slate-500">{formatDate(h.date, { weekday: 'long' })}</p>
                  </div>
                  <Badge>{h.calendar}</Badge>
                </li>
              ))}
              {upcomingHolidays.length === 0 && (
                <li className="flex items-center gap-2 px-5 py-6 text-sm text-slate-500"><CalendarDays className="h-4 w-4" /> No upcoming holidays.</li>
              )}
            </ul>
          </CardBody>
        </Card>
      </div>
      <p className="mt-6 text-right text-xs text-slate-400">Data refreshed {formatDateTime(new Date().toISOString())}</p>
    </div>
  );
}
