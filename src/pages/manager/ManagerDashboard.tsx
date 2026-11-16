import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ClipboardCheck, FolderKanban, Undo2, Users, Timer } from 'lucide-react';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups, useManagedProjects } from '@/hooks/useLookups';
import { addDays, currentWeekStart, formatDate, formatShort, formatWeekRange, todayISO, weeksBack } from '@/utils/date';
import { formatHours, sum } from '@/utils/format';
import { activeAllocationsOn, entryTotal } from '@/utils/timesheet';
import { Alert, PageHeader, PersonCell, ProjectDot } from '@/components/common/Misc';
import { SummaryStats } from '@/components/common/SummaryStats';
import { useApiQuery } from '@/hooks/useApiQuery';
import { reportService } from '@/services';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { StatusBadge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { BarList, ColumnChart } from '@/components/common/Charts';

export function ManagerDashboard() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const projects = useManagedProjects();
  const { timesheets, allocations, overtime } = useAppData();
  const summary = useApiQuery(() => reportService.managerDashboard(), [timesheets, allocations, overtime]);
  const { employeeName } = useLookups();
  const ids = new Set(projects.map((p) => p.id));
  const W = currentWeekStart();
  const lastWeek = addDays(W, -7);

  const entries = timesheets.flatMap((t) => t.entries.filter((e) => ids.has(e.projectId)).map((e) => ({ t, e })));
  const pending = entries.filter((x) => x.e.status === 'pending');
  const returned = entries.filter((x) => x.e.status === 'returned' || x.e.status === 'rejected');
  const active = activeAllocationsOn(allocations, todayISO());

  const projectSummary = projects.map((p) => {
    const lw = entries.filter((x) => x.e.projectId === p.id && x.t.weekStart === lastWeek);
    return {
      p,
      allocated: sum(active.filter((a) => a.projectId === p.id).map((a) => a.weeklyHours)),
      actual: sum(lw.map((x) => entryTotal(x.e))),
      people: active.filter((a) => a.projectId === p.id).length,
    };
  });

  const trend = weeksBack(6, lastWeek)
    .reverse()
    .map((w) => ({
      label: formatShort(w),
      value: sum(entries.filter((x) => x.t.weekStart === w && x.e.status !== 'draft').map((x) => entryTotal(x.e))),
      secondary: sum(allocations.filter((a) => ids.has(a.projectId) && a.startDate <= addDays(w, 6) && a.endDate >= w).map((a) => a.weeklyHours)),
    }));

  return (
    <div>
      <PageHeader
        title="Manager Dashboard"
        description={`${user.name} · ${projects.map((p) => p.name).join(', ') || 'No projects assigned'}`}
        actions={<Button icon={ClipboardCheck} onClick={() => navigate('/manager/approvals')}>Review approvals ({pending.length})</Button>}
      />

      <SummaryStats
        query={summary}
        className="xl:grid-cols-6"
        stats={[
          { label: 'Assigned projects', icon: FolderKanban, value: (s) => s.assignedProjects },
          { label: 'Team members', icon: Users, tone: 'slate', to: '/manager/team', value: (s) => s.teamMembers },
          { label: 'Pending approvals', icon: ClipboardCheck, tone: 'amber', to: '/manager/approvals', value: (s) => s.pendingApprovals },
          { label: 'Approved entries', icon: CheckCircle2, tone: 'green', value: (s) => s.approvedEntries },
          { label: 'Returned / rejected', icon: Undo2, tone: 'violet', value: (s) => s.returnedEntries, hint: () => 'Awaiting resubmission' },
          { label: 'Overtime pending', icon: Timer, tone: 'red', to: '/manager/overtime', value: (s) => s.pendingOvertime },
        ]}
      />
      {projects.length === 0 && (
        <Alert tone="info" className="mb-6" title="No projects assigned yet">
          An administrator needs to assign you as project manager on a project before entries appear here.
        </Alert>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Project-wise working hours" description={`Last week (${formatWeekRange(lastWeek)}) — submitted vs allocated`} />
          <CardBody>
            <BarList legend={{ primary: 'Submitted', secondary: 'Allocated' }} data={projectSummary.map((s) => ({ label: <span className="flex items-center gap-2"><ProjectDot color={s.p.color} />{s.p.name} <span className="text-xs text-slate-400">· {s.people} people</span></span>, value: s.actual, secondary: s.allocated, color: s.p.color }))} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Awaiting your approval" actions={<Link to="/manager/approvals" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600">Open <ArrowRight className="h-3 w-3" /></Link>} />
          <ul className="divide-y divide-slate-100">
            {pending.slice(0, 6).map(({ t, e }) => (
              <li key={`${t.id}-${e.projectId}`} className="flex items-center justify-between gap-3 px-5 py-3">
                <PersonCell name={employeeName(t.employeeId)} sub={`${formatWeekRange(t.weekStart)}`} />
                <span className="text-right text-sm">
                  <span className="block font-semibold tabular-nums">{formatHours(entryTotal(e))}</span>
                  <span className="text-xs text-slate-500">{projects.find((p) => p.id === e.projectId)?.name}</span>
                </span>
              </li>
            ))}
            {pending.length === 0 && <li className="px-5 py-6 text-sm text-slate-500">No pending approvals. 🎉</li>}
          </ul>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title="Weekly hours trend" description="Submitted hours across your projects (blue) vs allocation (grey)." />
          <CardBody>
            <ColumnChart data={trend} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Returned & rejected" description="Waiting for employees to correct." />
          <ul className="divide-y divide-slate-100">
            {returned.slice(0, 5).map(({ t, e }) => (
              <li key={`${t.id}-${e.projectId}`} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-800">{employeeName(t.employeeId)}</span>
                  <StatusBadge status={e.status} />
                </div>
                <p className="mt-0.5 text-xs text-slate-500">{projects.find((p) => p.id === e.projectId)?.name} · {formatWeekRange(t.weekStart)}</p>
                {e.managerComment && <p className="mt-1 line-clamp-2 text-xs text-slate-600">“{e.managerComment}”</p>}
              </li>
            ))}
            {returned.length === 0 && <li className="px-5 py-6 text-sm text-slate-500">Nothing outstanding.</li>}
          </ul>
        </Card>
      </div>
      <p className="mt-6 text-right text-xs text-slate-400">As of {formatDate(todayISO(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
    </div>
  );
}
