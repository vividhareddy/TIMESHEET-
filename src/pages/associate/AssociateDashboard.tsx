import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Bell, Briefcase, CalendarCheck, Clock, Hourglass, Target } from 'lucide-react';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups } from '@/hooks/useLookups';
import { useNotifications } from '@/hooks/useNotifications';
import { currentWeekStart, formatDate, formatWeekRange, todayISO, weeksBack } from '@/utils/date';
import { cn, formatHours, sum } from '@/utils/format';
import { allocationsForWeek, entryTotal, timesheetTotal } from '@/utils/timesheet';
import { Alert, PageHeader, ProjectDot } from '@/components/common/Misc';
import { SummaryStats } from '@/components/common/SummaryStats';
import { useApiQuery } from '@/hooks/useApiQuery';
import { reportService } from '@/services';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { StatusBadge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { BarList, ColumnChart } from '@/components/common/Charts';

export function AssociateDashboard() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const { timesheets, allocations, leaves } = useAppData();
  const summary = useApiQuery(() => reportService.associateDashboard(), [timesheets, allocations, leaves]);
  const { calendarOf, project, employeeName } = useLookups();
  const { items } = useNotifications();
  const W = currentWeekStart();
  const cal = calendarOf(user);

  const allocs = allocationsForWeek(allocations, user.id, W);
  const ts = timesheets.find((t) => t.employeeId === user.id && t.weekStart === W);
  const pendingWeeks = timesheets.filter((t) => t.employeeId === user.id && t.entries.some((e) => e.status === 'pending'));

  const trend = weeksBack(6, W)
    .reverse()
    .map((w) => ({ label: formatDate(w, { month: 'short', day: 'numeric' }), value: timesheetTotal(timesheets.find((t) => t.employeeId === user.id && t.weekStart === w)), secondary: sum(allocationsForWeek(allocations, user.id, w).map((a) => a.weeklyHours)) }));

  const upcoming = [
    ...(cal?.holidays ?? []).filter((h) => h.date >= todayISO()).slice(0, 4).map((h) => ({ date: h.date, label: h.name, kind: 'Holiday' })),
    ...leaves.filter((l) => l.employeeId === user.id && l.date >= todayISO() && l.status !== 'rejected').map((l) => ({ date: l.date, label: `${l.duration === 'full' ? 'Full day' : 'Half day'} leave`, kind: l.status === 'approved' ? 'Approved' : 'Pending' })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  return (
    <div>
      <PageHeader
        title={`Good day, ${user.name.split(' ')[0]}`}
        description={`${user.designation} · ${cal?.name} · Week of ${formatWeekRange(W)}`}
        actions={<Button icon={Clock} onClick={() => navigate('/associate/timesheet')}>Open my timesheet</Button>}
      />

      <SummaryStats
        query={summary}
        className="xl:grid-cols-5"
        stats={[
          { label: 'Assigned projects', icon: Briefcase, to: '/associate/projects', value: (s) => s.assignedProjects },
          { label: 'Weekly target', icon: Target, tone: 'slate', value: (s) => formatHours(s.weeklyTarget), hint: (s) => `Expected ${formatHours(s.expectedHours)} after holidays/leave` },
          { label: 'Hours entered', icon: Clock, tone: 'green', to: '/associate/timesheet', value: (s) => formatHours(s.enteredHours), hint: () => 'This week' },
          {
            label: 'Remaining expected',
            icon: Hourglass,
            tone: 'amber',
            value: (s) => formatHours(s.remainingHours),
            hint: (s) => (s.enteredHours > s.expectedHours ? `+${formatHours(s.enteredHours - s.expectedHours)} additional` : undefined),
          },
          { label: 'Submission status', icon: CalendarCheck, tone: 'violet', to: '/associate/submissions', value: (s) => <StatusBadge status={s.currentStatus} />, hint: (s) => `${s.entriesAwaitingApproval} entr${s.entriesAwaitingApproval === 1 ? 'y' : 'ies'} awaiting approval` },
        ]}
      />
      {!cal && (
        <Alert tone="warning" className="mb-6" title="No holiday calendar assigned">
          Holidays cannot be applied to your expected hours until an administrator assigns your calendar.
        </Alert>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="This week by project" description="Entered hours against your allocation." />
          <CardBody>
            {allocs.length ? (
              <BarList
                legend={{ primary: 'Entered', secondary: 'Allocated' }}
                data={allocs.map((a) => {
                  const e = ts?.entries.find((x) => x.projectId === a.projectId);
                  return { label: <span className="flex items-center gap-2"><ProjectDot color={project(a.projectId)?.color ?? '#94a3b8'} />{project(a.projectId)?.name}</span>, value: e ? entryTotal(e) : 0, secondary: a.weeklyHours, color: project(a.projectId)?.color };
                })}
              />
            ) : (
              <p className="text-sm text-slate-500">No allocations this week.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Notifications" actions={<Bell className="h-4 w-4 text-slate-400" />} />
          <ul className="divide-y divide-slate-100">
            {items.map((n) => (
              <li key={n.id}>
                <Link to={n.to} className="flex gap-3 px-5 py-3 hover:bg-slate-50">
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', { info: 'bg-brand-500', warning: 'bg-amber-500', success: 'bg-emerald-500', danger: 'bg-rose-500' }[n.tone])} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-800">{n.title}</span>
                    <span className="line-clamp-2 text-xs text-slate-500">{n.description}</span>
                  </span>
                </Link>
              </li>
            ))}
            {items.length === 0 && <li className="px-5 py-6 text-sm text-slate-500">You're all caught up.</li>}
          </ul>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title="Weekly hours trend" description="Logged hours (blue) vs allocation (grey), last 6 weeks." />
          <CardBody>
            <ColumnChart data={trend} target={user.weeklyCapacity} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Pending approvals" actions={<Link to="/associate/submissions" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600">All submissions <ArrowRight className="h-3 w-3" /></Link>} />
          <ul className="divide-y divide-slate-100">
            {pendingWeeks.flatMap((t) =>
              t.entries
                .filter((e) => e.status === 'pending')
                .map((e) => (
                  <li key={`${t.id}-${e.projectId}`} className="flex items-center justify-between gap-2 px-5 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 font-medium text-slate-800"><ProjectDot color={project(e.projectId)?.color ?? '#94a3b8'} />{project(e.projectId)?.name} · {formatHours(entryTotal(e))}</span>
                      <span className="text-xs text-slate-500">{formatWeekRange(t.weekStart)} · with {employeeName(project(e.projectId)?.managerId)}</span>
                    </span>
                    <StatusBadge status="pending" />
                  </li>
                )),
            )}
            {pendingWeeks.length === 0 && <li className="px-5 py-6 text-sm text-slate-500">Nothing awaiting approval.</li>}
          </ul>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader title="Upcoming holidays & leave" actions={<Link to="/associate/calendar" className="text-xs font-medium text-brand-600">My calendar</Link>} />
          <div className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-5">
            {upcoming.map((u, i) => (
              <div key={i} className="bg-white px-5 py-4">
                <p className="text-xs text-slate-500">{formatDate(u.date, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
                <p className="mt-1 text-sm font-medium text-slate-800">{u.label}</p>
                <p className={cn('mt-0.5 text-xs', u.kind === 'Holiday' ? 'text-amber-700' : u.kind === 'Approved' ? 'text-teal-700' : 'text-slate-500')}>{u.kind}</p>
              </div>
            ))}
            {upcoming.length === 0 && <p className="bg-white px-5 py-6 text-sm text-slate-500">Nothing upcoming.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
