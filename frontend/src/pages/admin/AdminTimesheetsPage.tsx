import { useMemo, useState } from 'react';
import { Download, Eye, RotateCcw } from 'lucide-react';
import type { Employee, ISODate, Timesheet, TimesheetStatus } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useLookups, useReferenceData } from '@/hooks/useLookups';
import { useTableState } from '@/hooks/useTableState';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { addDays, currentWeekStart, formatWeekRange, weeksBack } from '@/utils/date';
import { cn, downloadCsv, formatHours, sum } from '@/utils/format';
import { allocationsForWeek, deriveTimesheetStatus, expectedWeekHours, timesheetTotal } from '@/utils/timesheet';
import { PageHeader, PersonCell, ProgressBar, ProjectDot } from '@/components/common/Misc';
import { Card } from '@/components/common/Card';
import { Button, IconButton } from '@/components/common/Button';
import { StatusBadge } from '@/components/common/Badge';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';
import { FilterSelect, SearchInput } from '@/components/forms/FormControls';
import { TimesheetDetailModal } from '@/components/timesheet/TimesheetDetailModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

interface Row {
  key: string;
  employee: Employee;
  weekStart: ISODate;
  timesheet?: Timesheet;
  status: TimesheetStatus;
  actual: number;
  allocated: number;
  expected: number;
  approved: number;
  entries: number;
}


export function AdminTimesheetsPage() {
  const { timesheets, employees, allocations, leaves, projects, reopenTimesheet } = useAppData();
  const { calendarOf, project } = useLookups();
  const ref = useReferenceData();
  const { busy, run } = useAsyncAction();
  const weeks = weeksBack(8, currentWeekStart());
  const [week, setWeek] = useState<string>(addDays(currentWeekStart(), -7));
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [status, setStatus] = useState('all');
  const [viewing, setViewing] = useState<Timesheet | null>(null);
  const [reopening, setReopening] = useState<Timesheet | null>(null);

  const associates = employees.filter((e) => e.systemRole === 'associate' && e.status === 'active');

  const rows = useMemo<Row[]>(() => {
    const selectedWeeks = week === 'all' ? weeks : [week];
    const out: Row[] = [];
    for (const w of selectedWeeks) {
      for (const emp of associates) {
        const allocs = allocationsForWeek(allocations, emp.id, w);
        const ts = timesheets.find((t) => t.employeeId === emp.id && t.weekStart === w);
        if (!ts && !allocs.length) continue;
        out.push({
          key: `${emp.id}|${w}`,
          employee: emp,
          weekStart: w,
          timesheet: ts,
          status: deriveTimesheetStatus(ts),
          actual: timesheetTotal(ts),
          allocated: sum(allocs.map((a) => a.weeklyHours)),
          expected: expectedWeekHours(emp, calendarOf(emp), leaves, w),
          approved: ts?.entries.filter((e) => e.status === 'approved').length ?? 0,
          entries: ts?.entries.length ?? allocs.length,
        });
      }
    }
    return out.filter(
      (r) =>
        (employeeFilter === 'all' || r.employee.id === employeeFilter) &&
        (status === 'all' || r.status === status) &&
        (projectFilter === 'all' || r.timesheet?.entries.some((e) => e.projectId === projectFilter) || allocationsForWeek(allocations, r.employee.id, r.weekStart).some((a) => a.projectId === projectFilter)),
    );
  }, [week, weeks, associates, allocations, timesheets, leaves, calendarOf, employeeFilter, status, projectFilter]);

  const table = useTableState(rows, {
    searchText: (r) => r.employee.name,
    accessors: { employee: (r) => r.employee.name, week: (r) => r.weekStart, actual: (r) => r.actual, variance: (r) => r.actual - r.expected },
    initialSort: { key: 'employee', direction: 'asc' },
  });

  const columns: Column<Row>[] = [
    { key: 'employee', header: 'Employee', sortable: true, render: (r) => <PersonCell name={r.employee.name} sub={r.employee.designation} /> },
    { key: 'week', header: 'Week', sortable: true, render: (r) => <span className="whitespace-nowrap">{formatWeekRange(r.weekStart)}</span> },
    {
      key: 'projects',
      header: 'Projects',
      hideOnTablet: true,
      render: (r) => (
        <div className="flex flex-wrap gap-1.5">
          {(r.timesheet?.entries.map((e) => e.projectId) ?? allocationsForWeek(allocations, r.employee.id, r.weekStart).map((a) => a.projectId)).map((pid) => (
            <span key={pid} className="inline-flex items-center gap-1 text-xs text-slate-600"><ProjectDot color={project(pid)?.color ?? '#94a3b8'} />{project(pid)?.name}</span>
          ))}
        </div>
      ),
    },
    { key: 'allocated', header: 'Allocated', align: 'right', render: (r) => <span className="tabular-nums text-slate-500">{formatHours(r.allocated)}</span> },
    { key: 'actual', header: 'Actual', align: 'right', sortable: true, render: (r) => <span className="font-semibold tabular-nums">{formatHours(r.actual)}</span> },
    {
      key: 'variance',
      header: 'vs Expected',
      align: 'right',
      sortable: true,
      render: (r) => {
        const v = r.actual - r.expected;
        return (
          <span className={cn('tabular-nums', v > 0 ? 'text-amber-700' : v < 0 ? 'text-rose-600' : 'text-emerald-700')} title={`Expected ${formatHours(r.expected)}`}>
            {v > 0 ? '+' : ''}{formatHours(v)}
          </span>
        );
      },
    },
    {
      key: 'progress',
      header: 'Approval progress',
      render: (r) => (
        <div className="flex min-w-[120px] items-center gap-2">
          <ProgressBar value={r.approved} max={r.entries} tone="green" className="w-20" />
          <span className="text-xs tabular-nums text-slate-500">{r.approved}/{r.entries}</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (r) => (
        <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          <IconButton icon={Eye} label="View timesheet" disabled={!r.timesheet} onClick={() => r.timesheet && setViewing(r.timesheet)} />
          <IconButton
            icon={RotateCcw}
            label="Reopen timesheet"
            tone="warning"
            disabled={!r.timesheet || r.status === 'draft' || r.status === 'returned'}
            onClick={() => r.timesheet && setReopening(r.timesheet)}
          />
        </div>
      ),
    },
  ];

  const summary = {
    total: rows.length,
    submitted: rows.filter((r) => !['not_started', 'draft'].includes(r.status)).length,
    approved: rows.filter((r) => r.status === 'approved').length,
    missing: rows.filter((r) => ['not_started', 'draft'].includes(r.status)).length,
  };

  return (
    <div>
      <PageHeader
        title="Timesheets"
        description="Consolidated weekly timesheets across all employees and projects."
        actions={
          <Button
            variant="secondary"
            icon={Download}
            onClick={() =>
              downloadCsv('timesheets.csv', [
                ['Employee', 'Week', 'Allocated', 'Actual', 'Expected', 'Status', 'Approved entries', 'Total entries'],
                ...table.rows.map((r) => [r.employee.name, r.weekStart, r.allocated, r.actual, r.expected, r.status, r.approved, r.entries]),
              ])
            }
          >
            Export
          </Button>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['Timesheets', summary.total],
          ['Submitted', summary.submitted],
          ['Fully approved', summary.approved],
          ['Not submitted', summary.missing],
        ].map(([l, v]) => (
          <div key={l} className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-card">
            <p className="text-xs text-slate-500">{l}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{v}</p>
          </div>
        ))}
      </div>

      <Card>
        <TableToolbar>
          <SearchInput value={table.query} onChange={table.setQuery} placeholder="Search employee…" />
          <FilterSelect label="Week" value={week} onChange={setWeek} options={[...weeks.map((w) => ({ value: w, label: formatWeekRange(w) })), { value: 'all', label: 'Last 8 weeks' }]} />
          <FilterSelect label="Employee" value={employeeFilter} onChange={setEmployeeFilter} options={[{ value: 'all', label: 'All employees' }, ...associates.map((e) => ({ value: e.id, label: e.name }))]} />
          <FilterSelect label="Project" value={projectFilter} onChange={setProjectFilter} options={[{ value: 'all', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
          <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All statuses' }, ...ref.timesheetStatuses]} />
        </TableToolbar>
        <DataTable
          columns={columns}
          rows={table.rows}
          rowKey={(r) => r.key}
          sort={table.sort}
          onSort={table.toggleSort}
          onRowClick={(r) => r.timesheet && setViewing(r.timesheet)}
          emptyTitle="No timesheets match these filters"
        />
      </Card>

      <TimesheetDetailModal
        timesheet={viewing}
        onClose={() => setViewing(null)}
        actions={
          viewing && !['draft', 'returned'].includes(deriveTimesheetStatus(viewing)) ? (
            <Button variant="warning" icon={RotateCcw} onClick={() => { setReopening(viewing); setViewing(null); }}>Reopen timesheet</Button>
          ) : undefined
        }
      />
      <ConfirmDialog
        open={!!reopening}
        title="Reopen timesheet?"
        tone="warning"
        confirmLabel="Reopen"
        busy={busy}
        message="All entries (including approved ones) will be unlocked and returned to the employee for correction. They will need to resubmit for approval."
        comment={{ label: 'Reason for reopening', required: true, placeholder: 'e.g. Client requested re-classification of hours for invoicing.' }}
        onCancel={() => setReopening(null)}
        onConfirm={async (reason) => {
          if (!reopening) return;
          const ok = await run(() => reopenTimesheet(reopening.id, reason), { title: 'Timesheet reopened', message: 'The employee can now edit and resubmit.' });
          if (ok) setReopening(null);
        }}
      />
    </div>
  );
}
