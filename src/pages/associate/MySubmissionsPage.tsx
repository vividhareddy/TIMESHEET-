import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Pencil } from 'lucide-react';
import type { Timesheet } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups, useReferenceData } from '@/hooks/useLookups';
import { useTableState } from '@/hooks/useTableState';
import { formatDateTime, formatWeekRange } from '@/utils/date';
import { formatHours } from '@/utils/format';
import { deriveTimesheetStatus, entryTotal, expectedWeekHours, isEntryLocked, timesheetTotal } from '@/utils/timesheet';
import { PageHeader, ProgressBar, ProjectDot } from '@/components/common/Misc';
import { Card } from '@/components/common/Card';
import { IconButton } from '@/components/common/Button';
import { StatusBadge } from '@/components/common/Badge';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';
import { FilterSelect } from '@/components/forms/FormControls';
import { TimesheetDetailModal } from '@/components/timesheet/TimesheetDetailModal';

export function MySubmissionsPage() {
  const user = useCurrentUser();
  const { timesheets, leaves } = useAppData();
  const { project, calendarOf } = useLookups();
  const ref = useReferenceData();
  const navigate = useNavigate();
  const [status, setStatus] = useState('all');
  const [viewing, setViewing] = useState<Timesheet | null>(null);

  const mine = useMemo(() => timesheets.filter((t) => t.employeeId === user.id && (status === 'all' || deriveTimesheetStatus(t) === status)), [timesheets, user.id, status]);
  const table = useTableState(mine, { accessors: { week: (t) => t.weekStart, total: timesheetTotal }, initialSort: { key: 'week', direction: 'desc' } });

  const columns: Column<Timesheet>[] = [
    { key: 'week', header: 'Week', sortable: true, render: (t) => <span className="whitespace-nowrap font-medium text-slate-800">{formatWeekRange(t.weekStart)}</span> },
    {
      key: 'projects',
      header: 'Project entries',
      render: (t) => (
        <div className="space-y-1">
          {t.entries.map((e) => (
            <div key={e.projectId} className="flex items-center gap-2 text-xs">
              <ProjectDot color={project(e.projectId)?.color ?? '#94a3b8'} />
              <span className="w-16 truncate text-slate-700">{project(e.projectId)?.name}</span>
              <span className="w-10 text-right tabular-nums text-slate-500">{formatHours(entryTotal(e))}</span>
              <StatusBadge status={e.status} />
            </div>
          ))}
        </div>
      ),
    },
    { key: 'total', header: 'Total', align: 'right', sortable: true, render: (t) => <span className="font-semibold tabular-nums">{formatHours(timesheetTotal(t))}</span> },
    { key: 'expected', header: 'Expected', align: 'right', hideOnTablet: true, render: (t) => <span className="tabular-nums text-slate-500">{formatHours(expectedWeekHours(user, calendarOf(user), leaves, t.weekStart))}</span> },
    {
      key: 'progress',
      header: 'Approval progress',
      render: (t) => {
        const ok = t.entries.filter((e) => e.status === 'approved').length;
        return (
          <div className="flex items-center gap-2">
            <ProgressBar value={ok} max={t.entries.length} tone="green" className="w-20" />
            <span className="text-xs text-slate-500">{ok}/{t.entries.length}</span>
          </div>
        );
      },
    },
    { key: 'submitted', header: 'Submitted', hideOnTablet: true, render: (t) => <span className="text-xs text-slate-500">{t.submittedAt ? formatDateTime(t.submittedAt) : '—'}</span> },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={deriveTimesheetStatus(t)} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (t) => (
        <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          <IconButton icon={Eye} label="View details" onClick={() => setViewing(t)} />
          <IconButton icon={Pencil} label="Open in timesheet" disabled={t.entries.every((e) => isEntryLocked(e.status))} onClick={() => navigate(`/associate/timesheet?week=${t.weekStart}`)} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="My Submissions" description="History of your weekly timesheets, approval progress and manager comments." />
      <Card>
        <TableToolbar>
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[{ value: 'all', label: 'All statuses' }, ...ref.timesheetStatuses.filter((o) => o.value !== 'not_started')]}
          />
        </TableToolbar>
        <DataTable columns={columns} rows={table.rows} rowKey={(t) => t.id} sort={table.sort} onSort={table.toggleSort} onRowClick={setViewing} emptyTitle="No timesheets found" />
      </Card>
      <TimesheetDetailModal timesheet={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
