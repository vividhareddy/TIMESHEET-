import { useMemo, useState } from 'react';
import { CheckCircle2, Clock, Download, Hourglass, Timer } from 'lucide-react';
import type { EntryStatus, ISODate } from '@/types';
import type { AllocationActualRow, EmployeeHoursRow, HoursReport, OvertimeSummaryRow, ProjectHoursRow, WeeklyHoursPoint } from '@/types/api';
import { useAppData } from '@/context/AppDataContext';
import { useToast } from '@/context/ToastContext';
import { useReferenceData } from '@/hooks/useLookups';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useTableState } from '@/hooks/useTableState';
import { reportService } from '@/services';
import { addDays, currentWeekStart, formatShort, formatWeekRange } from '@/utils/date';
import { cn, downloadCsv, formatHours, percent } from '@/utils/format';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { Tabs, PersonCell, ProjectDot } from '@/components/common/Misc';
import { StatCard } from '@/components/common/StatCard';
import { BarList, ColumnChart } from '@/components/common/Charts';
import { FilterSelect } from '@/components/forms/FormControls';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';
import { ErrorState, Spinner } from '@/components/common/StatusScreen';

type Period = 'last4' | 'last8' | 'last12' | 'current';
type Tab = 'employees' | 'projects' | 'allocation' | 'approvals' | 'overtime';

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: 'last4', label: 'Last 4 weeks' },
  { value: 'last8', label: 'Last 8 weeks' },
  { value: 'last12', label: 'Last 12 weeks' },
  { value: 'current', label: 'Current week' },
];

const STATUS_COLORS: Partial<Record<EntryStatus, string>> = { approved: '#10b981', pending: '#f59e0b', returned: '#8b5cf6', rejected: '#f43f5e' };

function periodRange(p: Period): { from: ISODate; to: ISODate } {
  const W = currentWeekStart();
  if (p === 'current') return { from: W, to: W };
  const n = p === 'last4' ? 4 : p === 'last8' ? 8 : 12;
  return { from: addDays(W, -7 * n), to: addDays(W, -7) };
}

/** Reports are aggregated by the API (GET /reports/hours); this component only renders them. */
export function ReportsView({ projectIds }: { projectIds?: string[] }) {
  const { projects, timesheets, allocations, overtime } = useAppData();
  const toast = useToast();
  const [period, setPeriod] = useState<Period>('last4');
  const [projectFilter, setProjectFilter] = useState('all');
  const [tab, setTab] = useState<Tab>('employees');
  const range = periodRange(period);

  const scopeProjects = useMemo(() => projects.filter((p) => !projectIds || projectIds.includes(p.id)), [projects, projectIds]);
  const report = useApiQuery(
    () => reportService.hours({ ...range, projectId: projectFilter === 'all' ? undefined : projectFilter }),
    [range.from, range.to, projectFilter, timesheets, allocations, overtime],
  );

  const exportCsv = (r: HoursReport) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const map: Record<Tab, () => Array<Array<string | number>>> = {
      employees: () => [['Employee', 'Projects', 'Expected', 'Allocated', 'Actual', 'Approved', 'Pending', 'Utilisation %'], ...r.employees.map((x) => [x.name, x.projects, x.expected, x.allocated, x.actual, x.approved, x.pending, percent(x.actual, x.expected)])],
      projects: () => [['Project', 'Manager', 'Team', 'Allocated', 'Actual', 'Approved', 'Pending', 'Variance'], ...r.projects.map((x) => [x.name, x.managerName, x.team, x.allocated, x.actual, x.approved, x.pending, x.actual - x.allocated])],
      allocation: () => [['Employee', 'Project', 'Allocated', 'Actual', 'Variance'], ...r.allocation.map((x) => [x.employeeName, x.projectName, x.allocated, x.actual, x.actual - x.allocated])],
      approvals: () => [['Week', 'Approved', 'Pending', 'Returned', 'Rejected', 'Submitted hours'], ...r.weekly.map((w) => [w.weekStart, w.counts.approved ?? 0, w.counts.pending ?? 0, w.counts.returned ?? 0, w.counts.rejected ?? 0, w.actual])],
      overtime: () => [['Employee', 'Approved', 'Pending', 'Rejected', 'Payable hours'], ...r.overtime.map((x) => [x.name, x.approved, x.pending, x.rejected, x.payable])],
    };
    downloadCsv(`${tab}-report-${stamp}.csv`, map[tab]());
    toast.success('Report exported', `${tab}-report-${stamp}.csv`);
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <FilterSelect label="Period" value={period} onChange={(v) => setPeriod(v as Period)} options={PERIODS} />
        {scopeProjects.length > 1 && (
          <FilterSelect label="Project" value={projectFilter} onChange={setProjectFilter} options={[{ value: 'all', label: 'All projects' }, ...scopeProjects.map((p) => ({ value: p.id, label: p.name }))]} />
        )}
        <span className="text-xs text-slate-500">
          {range.from === range.to ? formatWeekRange(range.from) : `${formatWeekRange(range.from).split(' – ')[0]} – ${formatWeekRange(range.to).split(' – ')[1]}`}
        </span>
        <div className="ml-auto">
          <Button variant="secondary" icon={Download} disabled={!report.data} onClick={() => report.data && exportCsv(report.data)}>
            Export CSV
          </Button>
        </div>
      </div>

      {report.error ? (
        <Card>
          <ErrorState title="Unable to load the report" message={report.error} onRetry={report.reload} />
        </Card>
      ) : !report.data ? (
        <Card>
          <div className="flex justify-center py-16"><Spinner label="Building report…" /></div>
        </Card>
      ) : (
        <ReportBody report={report.data} tab={tab} onTab={setTab} />
      )}
    </div>
  );
}

function ReportBody({ report, tab, onTab }: { report: HoursReport; tab: Tab; onTab: (t: Tab) => void }) {
  const ref = useReferenceData();
  const empTable = useTableState(report.employees, { accessors: { name: (r) => r.name, actual: (r) => r.actual, util: (r) => r.actual / (r.expected || 1) }, initialSort: { key: 'actual', direction: 'desc' } });
  const projTable = useTableState(report.projects, { accessors: { name: (r) => r.name, actual: (r) => r.actual } });
  const allocTable = useTableState(report.allocation, { accessors: { employee: (r) => r.employeeName, variance: (r) => r.actual - r.allocated }, initialSort: { key: 'employee', direction: 'asc' } });
  const otTable = useTableState(report.overtime, { accessors: { name: (r) => r.name, approved: (r) => r.approved } });

  const variance = (v: number) => <span className={cn('tabular-nums', v > 0 ? 'text-amber-700' : v < 0 ? 'text-rose-600' : 'text-emerald-700')}>{v > 0 ? '+' : ''}{formatHours(v)}</span>;
  const reviewStatuses: EntryStatus[] = ['approved', 'pending', 'returned', 'rejected'];

  const empCols: Column<EmployeeHoursRow>[] = [
    { key: 'name', header: 'Employee', sortable: true, render: (r) => <PersonCell name={r.name} sub={r.designation} /> },
    { key: 'projects', header: 'Projects', align: 'right', render: (r) => r.projects },
    { key: 'expected', header: 'Expected', align: 'right', render: (r) => formatHours(r.expected) },
    { key: 'allocated', header: 'Allocated', align: 'right', render: (r) => formatHours(r.allocated) },
    { key: 'actual', header: 'Actual', align: 'right', sortable: true, render: (r) => <span className="font-semibold">{formatHours(r.actual)}</span> },
    { key: 'approved', header: 'Approved', align: 'right', render: (r) => formatHours(r.approved) },
    { key: 'pending', header: 'Pending', align: 'right', render: (r) => formatHours(r.pending) },
    { key: 'util', header: 'Utilisation', align: 'right', sortable: true, render: (r) => (r.expected ? `${percent(r.actual, r.expected)}%` : '—') },
  ];
  const projCols: Column<ProjectHoursRow>[] = [
    { key: 'name', header: 'Project', sortable: true, render: (r) => <span className="flex items-center gap-2 font-medium"><ProjectDot color={r.color} />{r.name}</span> },
    { key: 'manager', header: 'Project manager', render: (r) => r.managerName },
    { key: 'team', header: 'Team', align: 'right', render: (r) => r.team },
    { key: 'allocated', header: 'Allocated', align: 'right', render: (r) => formatHours(r.allocated) },
    { key: 'actual', header: 'Actual', align: 'right', sortable: true, render: (r) => <span className="font-semibold">{formatHours(r.actual)}</span> },
    { key: 'approved', header: 'Approved', align: 'right', render: (r) => formatHours(r.approved) },
    { key: 'pending', header: 'Pending', align: 'right', render: (r) => formatHours(r.pending) },
    { key: 'var', header: 'Variance', align: 'right', render: (r) => variance(r.actual - r.allocated) },
  ];
  const allocCols: Column<AllocationActualRow>[] = [
    { key: 'employee', header: 'Employee', sortable: true, render: (r) => <span className="font-medium text-slate-800">{r.employeeName}</span> },
    { key: 'project', header: 'Project', render: (r) => <span className="flex items-center gap-2"><ProjectDot color={r.color} />{r.projectName}</span> },
    { key: 'allocated', header: 'Allocated', align: 'right', render: (r) => formatHours(r.allocated) },
    { key: 'actual', header: 'Actual', align: 'right', render: (r) => <span className="font-semibold">{formatHours(r.actual)}</span> },
    { key: 'variance', header: 'Variance', align: 'right', sortable: true, render: (r) => variance(r.actual - r.allocated) },
    { key: 'pct', header: 'Actual / Allocated', align: 'right', render: (r) => (r.allocated ? `${percent(r.actual, r.allocated)}%` : '—') },
  ];
  const weekCols: Column<WeeklyHoursPoint>[] = [
    { key: 'week', header: 'Week', render: (r) => formatWeekRange(r.weekStart) },
    ...reviewStatuses.map<Column<WeeklyHoursPoint>>((s) => ({
      key: s,
      header: ref.label(ref.entryStatuses, s),
      align: 'right',
      render: (r) => <span className={cn('tabular-nums', !r.counts[s] && 'text-slate-300')}>{r.counts[s] ?? 0}</span>,
    })),
    { key: 'hours', header: 'Submitted hours', align: 'right', render: (r) => <span className="font-semibold">{formatHours(r.actual)}</span> },
  ];
  const otCols: Column<OvertimeSummaryRow>[] = [
    { key: 'name', header: 'Employee', sortable: true, render: (r) => <PersonCell name={r.name} /> },
    { key: 'approved', header: 'Approved', align: 'right', sortable: true, render: (r) => formatHours(r.approved) },
    { key: 'pending', header: 'Pending', align: 'right', render: (r) => formatHours(r.pending) },
    { key: 'rejected', header: 'Rejected', align: 'right', render: (r) => formatHours(r.rejected) },
    { key: 'payable', header: `Payable (${report.overtimeMultiplier}×)`, align: 'right', render: (r) => <span className="font-semibold">{formatHours(r.payable)}</span> },
  ];

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Submitted hours" value={formatHours(report.totals.actual)} icon={Clock} hint={`${report.totals.entries} project entries`} />
        <StatCard label="Approved hours" value={formatHours(report.totals.approved)} icon={CheckCircle2} tone="green" hint={report.totals.actual ? `${percent(report.totals.approved, report.totals.actual)}% of submitted` : 'Nothing submitted yet'} />
        <StatCard label="Pending approval" value={formatHours(report.totals.pending)} icon={Hourglass} tone="amber" />
        <StatCard label="Overtime hours" value={formatHours(report.totals.overtime)} icon={Timer} tone="violet" hint="Approved + pending" />
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Weekly hours: actual vs allocated" description="Submitted hours (blue) against allocated hours (grey) per week." />
          <CardBody>
            <ColumnChart data={report.weekly.map((w) => ({ label: formatShort(w.weekStart), value: w.actual, secondary: w.allocated }))} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Approval status" description="Project entries in the selected period." />
          <CardBody>
            {report.totals.entries === 0 ? (
              <p className="text-sm text-slate-500">No submitted entries in this period.</p>
            ) : (
              <BarList unit="" data={reviewStatuses.map((s) => ({ label: ref.label(ref.entryStatuses, s), value: report.statusCounts[s] ?? 0, color: STATUS_COLORS[s] }))} />
            )}
          </CardBody>
        </Card>
      </div>

      <Tabs
        value={tab}
        onChange={onTab}
        options={[
          { value: 'employees', label: 'Employee-wise hours' },
          { value: 'projects', label: 'Project-wise hours' },
          { value: 'allocation', label: 'Allocation vs actual' },
          { value: 'approvals', label: 'Approved & pending' },
          { value: 'overtime', label: 'Overtime summary' },
        ]}
      />

      {tab === 'employees' && (
        <Card>
          <DataTable columns={empCols} rows={empTable.rows} rowKey={(r) => r.employeeId} sort={empTable.sort} onSort={empTable.toggleSort} emptyTitle="No hours recorded in this period" />
        </Card>
      )}
      {tab === 'projects' && (
        <div className="grid gap-5 xl:grid-cols-[1fr_2fr]">
          <Card>
            <CardHeader title="Hours by project" />
            <CardBody>
              {report.projects.length ? (
                <BarList data={report.projects.map((r) => ({ label: r.name, value: r.actual, secondary: r.allocated, color: r.color }))} legend={{ primary: 'Actual', secondary: 'Allocated' }} />
              ) : (
                <p className="text-sm text-slate-500">No projects in scope.</p>
              )}
            </CardBody>
          </Card>
          <Card>
            <DataTable columns={projCols} rows={projTable.rows} rowKey={(r) => r.projectId} sort={projTable.sort} onSort={projTable.toggleSort} emptyTitle="No projects in scope" />
          </Card>
        </div>
      )}
      {tab === 'allocation' && (
        <Card>
          <TableToolbar>
            <span className="text-sm text-slate-500">Allocated hours are summed across the weeks in the selected period.</span>
          </TableToolbar>
          <DataTable columns={allocCols} rows={allocTable.rows} rowKey={(r) => `${r.employeeId}|${r.projectId}`} sort={allocTable.sort} onSort={allocTable.toggleSort} emptyTitle="No allocations in this period" />
        </Card>
      )}
      {tab === 'approvals' && (
        <Card>
          <DataTable columns={weekCols} rows={[...report.weekly].reverse()} rowKey={(r) => r.weekStart} />
        </Card>
      )}
      {tab === 'overtime' && (
        <Card>
          <DataTable columns={otCols} rows={otTable.rows} rowKey={(r) => r.employeeId} sort={otTable.sort} onSort={otTable.toggleSort} emptyTitle="No overtime in this period" />
        </Card>
      )}
    </>
  );
}
