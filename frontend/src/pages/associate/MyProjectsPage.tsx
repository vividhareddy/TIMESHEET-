import { CalendarRange, Clock, UserRound } from 'lucide-react';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups } from '@/hooks/useLookups';
import { currentWeekStart, formatDate, todayISO } from '@/utils/date';
import { formatHours, percent, sum } from '@/utils/format';
import { allocationHealth, entryTotal } from '@/utils/timesheet';
import { PageHeader, ProgressBar, EmptyState, PersonCell } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Badge, StatusBadge } from '@/components/common/Badge';
import { StackedBar } from '@/components/common/Charts';

export function MyProjectsPage() {
  const user = useCurrentUser();
  const { allocations, timesheets } = useAppData();
  const { project, employee } = useLookups();
  const today = todayISO();
  const mine = allocations.filter((a) => a.employeeId === user.id).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const active = mine.filter((a) => a.startDate <= today && a.endDate >= today);
  const total = sum(active.map((a) => a.weeklyHours));
  const ts = timesheets.find((t) => t.employeeId === user.id && t.weekStart === currentWeekStart());

  const approvedTotal = (pid: string) => sum(timesheets.filter((t) => t.employeeId === user.id).flatMap((t) => t.entries.filter((e) => e.projectId === pid && e.status === 'approved').map(entryTotal)));

  return (
    <div>
      <PageHeader title="My Projects" description="Projects you are allocated to, with your weekly hours and project manager." />

      <Card className="mb-5">
        <CardBody>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-slate-800">
              Total allocation: {formatHours(total)} of {formatHours(user.weeklyCapacity)} ({percent(total, user.weeklyCapacity)}%)
            </p>
            <StatusBadge status={allocationHealth(total, user.weeklyCapacity)} />
          </div>
          <StackedBar className="h-3" total={user.weeklyCapacity} segments={active.map((a) => ({ value: a.weeklyHours, color: project(a.projectId)?.color ?? '#94a3b8', label: project(a.projectId)?.name ?? '' }))} />
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">
            {active.map((a) => (
              <span key={a.id} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: project(a.projectId)?.color }} />
                {project(a.projectId)?.name} · {percent(a.weeklyHours, user.weeklyCapacity)}%
              </span>
            ))}
          </div>
        </CardBody>
      </Card>

      {mine.length === 0 ? (
        <Card><EmptyState title="No project allocations" description="You are not currently allocated to any project." /></Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {mine.map((a) => {
            const p = project(a.projectId);
            const pm = employee(p?.managerId);
            const isActive = a.startDate <= today && a.endDate >= today;
            const thisWeek = ts?.entries.find((e) => e.projectId === a.projectId);
            const logged = thisWeek ? entryTotal(thisWeek) : 0;
            return (
              <Card key={a.id}>
                <div className="h-1 rounded-t-lg" style={{ backgroundColor: p?.color }} />
                <CardHeader title={p?.name} description={`${p?.client} · ${a.projectRole}`} actions={isActive ? <Badge tone="green" dot>Active</Badge> : <Badge>{a.startDate > today ? 'Upcoming' : 'Ended'}</Badge>} />
                <CardBody className="space-y-4">
                  <p className="text-sm text-slate-600">{p?.description}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-md bg-slate-50 px-3 py-2">
                      <p className="text-xs text-slate-500">Allocated weekly</p>
                      <p className="text-lg font-semibold text-slate-900">{formatHours(a.weeklyHours)}</p>
                    </div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">
                      <p className="text-xs text-slate-500">Allocation</p>
                      <p className="text-lg font-semibold text-slate-900">{percent(a.weeklyHours, user.weeklyCapacity)}%</p>
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-slate-500">
                      <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> This week</span>
                      <span className="tabular-nums">{formatHours(logged)} / {formatHours(a.weeklyHours)}</span>
                    </div>
                    <ProgressBar value={logged} max={a.weeklyHours} tone={logged > a.weeklyHours ? 'amber' : 'blue'} />
                  </div>
                  <div className="space-y-2 border-t border-slate-100 pt-3 text-sm">
                    <div className="flex items-center gap-2 text-slate-500"><UserRound className="h-4 w-4" /> Project manager</div>
                    {pm && <PersonCell name={pm.name} sub={pm.email} />}
                    <div className="flex items-center gap-2 pt-1 text-xs text-slate-500">
                      <CalendarRange className="h-4 w-4" /> {formatDate(a.startDate)} → {formatDate(a.endDate)}
                    </div>
                    <p className="text-xs text-slate-500">Approved to date: <span className="font-medium text-slate-700">{formatHours(approvedTotal(a.projectId))}</span></p>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
