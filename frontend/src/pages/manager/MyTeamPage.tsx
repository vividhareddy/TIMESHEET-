import { useState } from 'react';
import type { Employee, Timesheet } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useLookups } from '@/hooks/useLookups';
import { useTeam } from '@/hooks/useTeam';
import { useTableState } from '@/hooks/useTableState';
import { addDays, currentWeekStart, formatWeekRange, todayISO } from '@/utils/date';
import { formatHours, sum } from '@/utils/format';
import { activeAllocationsOn, allocationHealth, deriveTimesheetStatus, timesheetTotal } from '@/utils/timesheet';
import { PageHeader, PersonCell, ProjectDot } from '@/components/common/Misc';
import { Card } from '@/components/common/Card';
import { Badge, StatusBadge } from '@/components/common/Badge';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';
import { SearchInput } from '@/components/forms/FormControls';
import { TimesheetDetailModal } from '@/components/timesheet/TimesheetDetailModal';

export function MyTeamPage() {
  const { team, projectIds, directReportIds } = useTeam();
  const { allocations, timesheets } = useAppData();
  const { project, calendarOf } = useLookups();
  const [viewing, setViewing] = useState<Timesheet | null>(null);
  const active = activeAllocationsOn(allocations, todayISO());
  const lastWeek = addDays(currentWeekStart(), -7);

  const table = useTableState(team, {
    searchText: (e) => `${e.name} ${e.designation}`,
    accessors: { name: (e) => e.name, alloc: (e) => sum(active.filter((a) => a.employeeId === e.id).map((a) => a.weeklyHours)) },
    initialSort: { key: 'name', direction: 'asc' },
  });

  const columns: Column<Employee>[] = [
    {
      key: 'name',
      header: 'Team member',
      sortable: true,
      render: (e) => (
        <div className="flex items-center gap-2">
          <PersonCell name={e.name} sub={`${e.designation} · ${e.workLocation}`} />
          {directReportIds.has(e.id) && <Badge tone="blue">Direct report</Badge>}
        </div>
      ),
    },
    {
      key: 'projects',
      header: 'Your projects',
      render: (e) => (
        <div className="space-y-1">
          {active.filter((a) => a.employeeId === e.id && projectIds.includes(a.projectId)).map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-xs text-slate-700">
              <ProjectDot color={project(a.projectId)?.color ?? '#94a3b8'} /> {project(a.projectId)?.name} · {formatHours(a.weeklyHours)} <span className="text-slate-400">({a.projectRole})</span>
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'alloc',
      header: 'Total allocation',
      align: 'right',
      sortable: true,
      render: (e) => {
        const t = sum(active.filter((a) => a.employeeId === e.id).map((a) => a.weeklyHours));
        return (
          <div>
            <span className="tabular-nums">{formatHours(t)} / {formatHours(e.weeklyCapacity)}</span>
            <div className="mt-1"><StatusBadge status={allocationHealth(t, e.weeklyCapacity)} /></div>
          </div>
        );
      },
    },
    { key: 'calendar', header: 'Calendar', hideOnTablet: true, render: (e) => calendarOf(e)?.name },
    {
      key: 'lastweek',
      header: `Last week (${formatWeekRange(lastWeek)})`,
      render: (e) => {
        const ts = timesheets.find((t) => t.employeeId === e.id && t.weekStart === lastWeek);
        return (
          <button className="flex items-center gap-2 text-left disabled:cursor-default" disabled={!ts} onClick={() => ts && setViewing(ts)}>
            <span className="w-12 tabular-nums">{formatHours(timesheetTotal(ts))}</span>
            <StatusBadge status={deriveTimesheetStatus(ts)} />
          </button>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader title="My Team" description="People allocated to your projects and your direct reports." />
      <Card>
        <TableToolbar right={<span className="text-xs text-slate-500">{team.length} members</span>}>
          <SearchInput value={table.query} onChange={table.setQuery} placeholder="Search team…" />
        </TableToolbar>
        <DataTable columns={columns} rows={table.rows} rowKey={(e) => e.id} sort={table.sort} onSort={table.toggleSort} emptyTitle="No team members yet" />
      </Card>
      <TimesheetDetailModal timesheet={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
