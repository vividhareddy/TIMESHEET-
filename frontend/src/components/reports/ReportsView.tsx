import { useMemo, useState } from 'react';
import { CheckCircle2, Clock, FileSpreadsheet, FileText, Hourglass, Timer } from 'lucide-react';
import type { EntryStatus, ISODate } from '@/types';
import type {
  AllocationActualRow,
  ComplianceWeek,
  EmployeeHoursRow,
  HoursReport,
  LeaveRecordRow,
  LeaveSummaryRow,
  MissingSubmissionRow,
  OvertimeProjectRow,
  OvertimeRecordRow,
  OvertimeSummaryRow,
  PendingApprovalRow,
  ProjectHoursRow,
  ReportTimesheetStatus,
  TimesheetStatusRow,
  WeeklyHoursPoint,
} from '@/types/api';
import { useAppData } from '@/context/AppDataContext';
import { useSession } from '@/context/SessionContext';
import { useToast } from '@/context/ToastContext';
import { useReferenceData } from '@/hooks/useLookups';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useTableState } from '@/hooks/useTableState';
import { reportService } from '@/services';
import { addDays, currentWeekStart, formatShort, formatWeekRange } from '@/utils/date';
import { cn, formatHours, percent } from '@/utils/format';
import { exportExcel, exportPdf, type ExportMeta, type ExportSection } from '@/utils/reportExport';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { StatusBadge } from '@/components/common/Badge';
import { Tabs, PersonCell, ProjectDot, Segmented } from '@/components/common/Misc';
import { StatCard } from '@/components/common/StatCard';
import { BarList, ColumnChart } from '@/components/common/Charts';
import { FilterSelect } from '@/components/forms/FormControls';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';
import { ErrorState, Spinner } from '@/components/common/StatusScreen';

type Period = 'last4' | 'last8' | 'last12' | 'current';
type Tab = 'employees' | 'projects' | 'allocation' | 'timesheets' | 'overtime' | 'leave' | 'compliance';

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: 'last4', label: 'Last 4 weeks' },
  { value: 'last8', label: 'Last 8 weeks' },
  { value: 'last12', label: 'Last 12 weeks' },
  { value: 'current', label: 'Current week' },
];

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'employees', label: 'Employee-wise hours' },
  { value: 'projects', label: 'Project-wise hours' },
  { value: 'allocation', label: 'Allocation vs actual' },
  { value: 'timesheets', label: 'Timesheet status' },
  { value: 'overtime', label: 'Overtime' },
  { value: 'leave', label: 'Leave' },
  { value: 'compliance', label: 'Compliance' },
];

const STATUS_COLORS: Partial<Record<string, string>> = {
  approved: '#10b981',
  pending: '#f59e0b',
  submitted: '#3b82f6',
  partially_approved: '#14b8a6',
  returned: '#8b5cf6',
  rejected: '#f43f5e',
  draft: '#94a3b8',
  not_started: '#cbd5e1',
};
const TIMESHEET_STATUSES: ReportTimesheetStatus[] = ['not_started', 'draft', 'submitted', 'partially_approved', 'approved', 'returned', 'rejected'];
const REVIEW_STATUSES: EntryStatus[] = ['approved', 'pending', 'returned', 'rejected'];
const LEAVE_DURATION: Record<string, string> = { full: 'Full day', half: 'Half day' };
const OT_SOURCE: Record<string, string> = { timesheet: 'From timesheet', pre_approval: 'Pre-approval' };

function periodRange(p: Period): { from: ISODate; to: ISODate } {
  const W = currentWeekStart();
  if (p === 'current') return { from: W, to: W };
  const n = p === 'last4' ? 4 : p === 'last8' ? 8 : 12;
  return { from: addDays(W, -7 * n), to: addDays(W, -7) };
}

/** e.g. "Oct 19 – Nov 15, 2026" (from = first Monday, to = last Monday). */
const periodLabel = (r: { from: ISODate; to: ISODate }) => {
  if (r.from === r.to) return formatWeekRange(r.from);
  const end = addDays(r.to, 6);
  const sameYear = r.from.slice(0, 4) === end.slice(0, 4);
  return `${formatShort(r.from)}${sameYear ? '' : `, ${r.from.slice(0, 4)}`} – ${formatShort(end)}, ${end.slice(0, 4)}`;
};

/** Every report as plain rows, shared by the Excel and PDF exports. */
function buildSections(r: HoursReport, label: (status: string) => string): ExportSection[] {
  return [
    {
      title: 'Employee-wise hours',
      sheet: 'Employee hours',
      description: 'Hours recorded by each employee across projects (submitted entries).',
      columns: [
        { header: 'Employee' }, { header: 'Designation' }, { header: 'Projects', type: 'number' }, { header: 'Expected', type: 'hours' },
        { header: 'Allocated', type: 'hours' }, { header: 'Actual', type: 'hours' }, { header: 'Approved', type: 'hours' },
        { header: 'Pending', type: 'hours' }, { header: 'Utilisation', type: 'percent' },
      ],
      rows: r.employees.map((x) => [x.name, x.designation, x.projects, x.expected, x.allocated, x.actual, x.approved, x.pending, x.expected ? percent(x.actual, x.expected) : null]),
    },
    {
      title: 'Project-wise hours',
      sheet: 'Project hours',
      description: 'Hours recorded against each project.',
      columns: [
        { header: 'Project' }, { header: 'Project manager' }, { header: 'Team', type: 'number' }, { header: 'Allocated', type: 'hours' },
        { header: 'Actual', type: 'hours' }, { header: 'Approved', type: 'hours' }, { header: 'Pending', type: 'hours' }, { header: 'Variance', type: 'hours' },
      ],
      rows: r.projects.map((x) => [x.name, x.managerName, x.team, x.allocated, x.actual, x.approved, x.pending, x.actual - x.allocated]),
    },
    {
      title: 'Allocation vs actual',
      sheet: 'Allocation vs actual',
      description: 'Planned allocation compared with submitted and approved hours, per employee and project.',
      columns: [
        { header: 'Employee' }, { header: 'Project' }, { header: 'Allocated', type: 'hours' }, { header: 'Actual (submitted)', type: 'hours' },
        { header: 'Variance', type: 'hours' }, { header: 'Actual / allocated', type: 'percent' },
      ],
      rows: r.allocation.map((x) => [x.employeeName, x.projectName, x.allocated, x.actual, x.actual - x.allocated, x.allocated ? percent(x.actual, x.allocated) : null]),
    },
    {
      title: 'Timesheet status',
      sheet: 'Timesheet status',
      description: 'Status of each weekly timesheet for everyone allocated to a project in scope.',
      columns: [{ header: 'Week starting', type: 'date' }, { header: 'Employee' }, { header: 'Status' }, { header: 'Hours', type: 'hours' }, { header: 'Submitted on', type: 'date' }],
      rows: r.timesheetStatus.rows.map((x) => [x.weekStart, x.name, label(x.status), x.hours, x.submittedAt ? x.submittedAt.slice(0, 10) : null]),
    },
    {
      title: 'Overtime by project',
      sheet: 'Overtime by project',
      columns: [
        { header: 'Project' }, { header: 'Employees', type: 'number' }, { header: 'Approved', type: 'hours' }, { header: 'Pending', type: 'hours' },
        { header: 'Rejected', type: 'hours' }, { header: `Payable (${r.overtimeMultiplier}×)`, type: 'hours' },
      ],
      rows: r.overtimeByProject.map((x) => [x.name, x.employees, x.approved, x.pending, x.rejected, x.payable]),
    },
    {
      title: 'Overtime by employee',
      sheet: 'Overtime by employee',
      columns: [
        { header: 'Employee' }, { header: 'Approved', type: 'hours' }, { header: 'Pending', type: 'hours' }, { header: 'Rejected', type: 'hours' },
        { header: `Payable (${r.overtimeMultiplier}×)`, type: 'hours' },
      ],
      rows: r.overtime.map((x) => [x.name, x.approved, x.pending, x.rejected, x.payable]),
    },
    {
      title: 'Overtime records',
      sheet: 'Overtime records',
      columns: [
        { header: 'Week starting', type: 'date' }, { header: 'Date', type: 'date' }, { header: 'Employee' }, { header: 'Project' },
        { header: 'Hours', type: 'hours' }, { header: 'Source' }, { header: 'Status' }, { header: 'Reason' },
      ],
      rows: r.overtimeRecords.map((x) => [x.weekStart, x.date, x.employeeName, x.projectName, x.hours, OT_SOURCE[x.source] ?? x.source, label(x.status), x.reason]),
    },
    {
      title: 'Leave summary',
      sheet: 'Leave summary',
      description: 'Leave requests with a date in the period. Balances are not tracked: no annual entitlement is configured.',
      columns: [
        { header: 'Employee' }, { header: 'Requests', type: 'number' }, { header: 'Approved days', type: 'number' }, { header: 'Approved hours', type: 'hours' },
        { header: 'Pending days', type: 'number' }, { header: 'Rejected days', type: 'number' },
      ],
      rows: r.leave.employees.map((x) => [x.name, x.requests, x.approvedDays, x.approvedHours, x.pendingDays, x.rejectedDays]),
    },
    {
      title: 'Leave requests',
      sheet: 'Leave requests',
      columns: [
        { header: 'Date', type: 'date' }, { header: 'Employee' }, { header: 'Duration' }, { header: 'Hours', type: 'hours' }, { header: 'Status' },
        { header: 'Reviewed by' }, { header: 'Reason' }, { header: 'Reviewer comment' },
      ],
      rows: r.leave.records.map((x) => [x.date, x.employeeName, LEAVE_DURATION[x.duration] ?? x.duration, x.hours, label(x.status), x.reviewerName, x.reason, x.reviewerComment]),
    },
    {
      title: 'Compliance: weekly submission',
      sheet: 'Compliance by week',
      description: 'Share of expected weekly timesheets that were submitted, and what is still waiting for approval.',
      columns: [
        { header: 'Week starting', type: 'date' }, { header: 'Expected', type: 'number' }, { header: 'Submitted', type: 'number' }, { header: 'Not submitted', type: 'number' },
        { header: 'Completion', type: 'percent' }, { header: 'Pending entries', type: 'number' }, { header: 'Pending hours', type: 'hours' },
      ],
      rows: r.compliance.weeks.map((x) => [x.weekStart, x.expected, x.submitted, x.notSubmitted, x.completion, x.pendingEntries, x.pendingHours]),
    },
    {
      title: 'Compliance: missing submissions',
      sheet: 'Missing submissions',
      columns: [{ header: 'Week starting', type: 'date' }, { header: 'Employee' }, { header: 'Status' }],
      rows: r.compliance.missing.map((x) => [x.weekStart, x.name, label(x.status)]),
    },
    {
      title: 'Compliance: pending approvals',
      sheet: 'Pending approvals',
      columns: [
        { header: 'Week starting', type: 'date' }, { header: 'Employee' }, { header: 'Project' }, { header: 'Approver' },
        { header: 'Hours', type: 'hours' }, { header: 'Submitted on', type: 'date' }, { header: 'Days waiting', type: 'number' },
      ],
      rows: r.compliance.pendingApprovals.map((x) => [x.weekStart, x.employeeName, x.projectName, x.approverName, x.hours, x.submittedOn, x.daysWaiting]),
    },
  ];
}

/** Reports are aggregated by the API (GET /reports/hours); this component renders and exports them. */
export function ReportsView({ projectIds }: { projectIds?: string[] }) {
  const { projects, timesheets, allocations, overtime, leaves, settings } = useAppData();
  const { user } = useSession();
  const ref = useReferenceData();
  const toast = useToast();
  const [period, setPeriod] = useState<Period>('last4');
  const [projectFilter, setProjectFilter] = useState('all');
  const [tab, setTab] = useState<Tab>('employees');
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const range = periodRange(period);

  const scopeProjects = useMemo(() => projects.filter((p) => !projectIds || projectIds.includes(p.id)), [projects, projectIds]);
  const report = useApiQuery(
    () => reportService.hours({ ...range, projectId: projectFilter === 'all' ? undefined : projectFilter }),
    [range.from, range.to, projectFilter, timesheets, allocations, overtime, leaves],
  );

  const statusLabel = (s: string) =>
    [...ref.timesheetStatuses, ...ref.entryStatuses, ...ref.requestStatuses].find((o) => o.value === s)?.label ?? s.replace(/_/g, ' ');

  const runExport = async (format: 'excel' | 'pdf', r: HoursReport) => {
    const scope = projectFilter === 'all'
      ? projectIds ? 'Projects you manage' : 'All projects'
      : `Project: ${projects.find((p) => p.id === projectFilter)?.name ?? ''}`;
    const meta: ExportMeta = {
      title: 'Reports & Analytics',
      organisation: settings.organisationName || 'Organisation',
      period: periodLabel(range),
      scope,
      generatedBy: user?.name ?? '',
    };
    const filename = `timesheet-reports-${range.from}-to-${r.to}.${format === 'excel' ? 'xlsx' : 'pdf'}`;
    setExporting(format);
    try {
      const sections = buildSections(r, statusLabel);
      if (format === 'excel') await exportExcel(meta, sections, filename);
      else await exportPdf(meta, sections, filename);
      toast.success('Report exported', filename);
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : 'The file could not be created.');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <FilterSelect label="Period" value={period} onChange={(v) => setPeriod(v as Period)} options={PERIODS} />
        {scopeProjects.length > 1 && (
          <FilterSelect label="Project" value={projectFilter} onChange={setProjectFilter} options={[{ value: 'all', label: 'All projects' }, ...scopeProjects.map((p) => ({ value: p.id, label: p.name }))]} />
        )}
        <span className="text-xs text-slate-500">{periodLabel(range)}</span>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" icon={FileSpreadsheet} loading={exporting === 'excel'} disabled={!report.data || !!exporting} onClick={() => report.data && void runExport('excel', report.data)}>
            Export Excel
          </Button>
          <Button variant="secondary" icon={FileText} loading={exporting === 'pdf'} disabled={!report.data || !!exporting} onClick={() => report.data && void runExport('pdf', report.data)}>
            Export PDF
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
        <ReportBody report={report.data} tab={tab} onTab={setTab} statusLabel={statusLabel} />
      )}
    </div>
  );
}

function ReportBody({ report, tab, onTab, statusLabel }: { report: HoursReport; tab: Tab; onTab: (t: Tab) => void; statusLabel: (s: string) => string }) {
  const ref = useReferenceData();
  const [statusFilter, setStatusFilter] = useState<'all' | ReportTimesheetStatus>('all');
  const [otView, setOtView] = useState<'project' | 'employee' | 'records'>('project');
  const [complianceView, setComplianceView] = useState<'weeks' | 'missing' | 'pending'>('weeks');

  const empTable = useTableState(report.employees, { accessors: { name: (r) => r.name, actual: (r) => r.actual, util: (r) => r.actual / (r.expected || 1) }, initialSort: { key: 'actual', direction: 'desc' } });
  const projTable = useTableState(report.projects, { accessors: { name: (r) => r.name, actual: (r) => r.actual } });
  const allocTable = useTableState(report.allocation, { accessors: { employee: (r) => r.employeeName, variance: (r) => r.actual - r.allocated }, initialSort: { key: 'employee', direction: 'asc' } });
  const tsRows = report.timesheetStatus.rows.filter((r) => statusFilter === 'all' || r.status === statusFilter);
  const tsTable = useTableState(tsRows, { accessors: { week: (r) => r.weekStart, name: (r) => r.name, hours: (r) => r.hours } });
  const otTable = useTableState(report.overtime, { accessors: { name: (r) => r.name, approved: (r) => r.approved } });
  const otProjTable = useTableState(report.overtimeByProject, { accessors: { name: (r) => r.name, approved: (r) => r.approved } });
  const otRecTable = useTableState(report.overtimeRecords, { accessors: { week: (r) => r.weekStart, name: (r) => r.employeeName, hours: (r) => r.hours } });
  const leaveTable = useTableState(report.leave.employees, { accessors: { name: (r) => r.name, approved: (r) => r.approvedDays } });
  const leaveRecTable = useTableState(report.leave.records, { accessors: { date: (r) => r.date, name: (r) => r.employeeName } });
  const pendingTable = useTableState(report.compliance.pendingApprovals, { accessors: { days: (r) => r.daysWaiting, name: (r) => r.employeeName }, initialSort: { key: 'days', direction: 'desc' } });

  const variance = (v: number) => <span className={cn('tabular-nums', v > 0 ? 'text-amber-700' : v < 0 ? 'text-rose-600' : 'text-emerald-700')}>{v > 0 ? '+' : ''}{formatHours(v)}</span>;
  const status = (s: string) => <StatusBadge status={s} label={statusLabel(s)} />;
  const compliance = report.compliance.weeks;
  const expectedTotal = compliance.reduce((n, w) => n + w.expected, 0);
  const submittedTotal = compliance.reduce((n, w) => n + w.submitted, 0);

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
  const tsCols: Column<TimesheetStatusRow>[] = [
    { key: 'week', header: 'Week', sortable: true, render: (r) => formatWeekRange(r.weekStart) },
    { key: 'name', header: 'Employee', sortable: true, render: (r) => <span className="font-medium text-slate-800">{r.name}</span> },
    { key: 'status', header: 'Status', render: (r) => status(r.status) },
    { key: 'hours', header: 'Hours', align: 'right', sortable: true, render: (r) => formatHours(r.hours) },
    { key: 'submitted', header: 'Submitted on', align: 'right', render: (r) => (r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : '—') },
  ];
  const weekCols: Column<WeeklyHoursPoint>[] = [
    { key: 'week', header: 'Week', render: (r) => formatWeekRange(r.weekStart) },
    ...REVIEW_STATUSES.map<Column<WeeklyHoursPoint>>((s) => ({
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
  const otProjCols: Column<OvertimeProjectRow>[] = [
    { key: 'name', header: 'Project', sortable: true, render: (r) => <span className="flex items-center gap-2 font-medium"><ProjectDot color={r.color} />{r.name}</span> },
    { key: 'employees', header: 'Employees', align: 'right', render: (r) => r.employees },
    { key: 'approved', header: 'Approved', align: 'right', sortable: true, render: (r) => formatHours(r.approved) },
    { key: 'pending', header: 'Pending', align: 'right', render: (r) => formatHours(r.pending) },
    { key: 'rejected', header: 'Rejected', align: 'right', render: (r) => formatHours(r.rejected) },
    { key: 'payable', header: `Payable (${report.overtimeMultiplier}×)`, align: 'right', render: (r) => <span className="font-semibold">{formatHours(r.payable)}</span> },
  ];
  const otRecCols: Column<OvertimeRecordRow>[] = [
    { key: 'week', header: 'Week / date', sortable: true, render: (r) => (r.date ? formatShort(r.date) : formatWeekRange(r.weekStart)) },
    { key: 'name', header: 'Employee', sortable: true, render: (r) => <span className="font-medium text-slate-800">{r.employeeName}</span> },
    { key: 'project', header: 'Project', render: (r) => r.projectName },
    { key: 'hours', header: 'Hours', align: 'right', sortable: true, render: (r) => formatHours(r.hours) },
    { key: 'source', header: 'Source', render: (r) => OT_SOURCE[r.source] ?? r.source },
    { key: 'status', header: 'Status', render: (r) => status(r.status) },
    { key: 'reason', header: 'Reason', render: (r) => <span className="line-clamp-2 max-w-xs text-slate-600">{r.reason}</span> },
  ];
  const leaveCols: Column<LeaveSummaryRow>[] = [
    { key: 'name', header: 'Employee', sortable: true, render: (r) => <PersonCell name={r.name} /> },
    { key: 'requests', header: 'Requests', align: 'right', render: (r) => r.requests },
    { key: 'approved', header: 'Approved days', align: 'right', sortable: true, render: (r) => r.approvedDays },
    { key: 'approvedHours', header: 'Approved hours', align: 'right', render: (r) => formatHours(r.approvedHours) },
    { key: 'pending', header: 'Pending days', align: 'right', render: (r) => r.pendingDays },
    { key: 'rejected', header: 'Rejected days', align: 'right', render: (r) => r.rejectedDays },
  ];
  const leaveRecCols: Column<LeaveRecordRow>[] = [
    { key: 'date', header: 'Date', sortable: true, render: (r) => formatShort(r.date) },
    { key: 'name', header: 'Employee', sortable: true, render: (r) => <span className="font-medium text-slate-800">{r.employeeName}</span> },
    { key: 'duration', header: 'Duration', render: (r) => LEAVE_DURATION[r.duration] ?? r.duration },
    { key: 'status', header: 'Outcome', render: (r) => status(r.status) },
    { key: 'reviewer', header: 'Reviewed by', render: (r) => r.reviewerName ?? '—' },
    { key: 'reason', header: 'Reason', render: (r) => <span className="line-clamp-2 max-w-xs text-slate-600">{r.reason}</span> },
  ];
  const complianceCols: Column<ComplianceWeek>[] = [
    { key: 'week', header: 'Week', render: (r) => formatWeekRange(r.weekStart) },
    { key: 'expected', header: 'Expected', align: 'right', render: (r) => r.expected },
    { key: 'submitted', header: 'Submitted', align: 'right', render: (r) => r.submitted },
    { key: 'missing', header: 'Not submitted', align: 'right', render: (r) => <span className={cn('tabular-nums', r.notSubmitted ? 'font-semibold text-rose-600' : 'text-slate-300')}>{r.notSubmitted}</span> },
    { key: 'completion', header: 'Completion', align: 'right', render: (r) => <span className={cn('font-semibold', r.completion >= 90 ? 'text-emerald-700' : r.completion >= 70 ? 'text-amber-700' : 'text-rose-600')}>{r.completion}%</span> },
    { key: 'pendingEntries', header: 'Pending entries', align: 'right', render: (r) => r.pendingEntries },
    { key: 'pendingHours', header: 'Pending hours', align: 'right', render: (r) => formatHours(r.pendingHours) },
  ];
  const missingCols: Column<MissingSubmissionRow>[] = [
    { key: 'week', header: 'Week', render: (r) => formatWeekRange(r.weekStart) },
    { key: 'name', header: 'Employee', render: (r) => <span className="font-medium text-slate-800">{r.name}</span> },
    { key: 'status', header: 'Status', render: (r) => status(r.status) },
  ];
  const pendingCols: Column<PendingApprovalRow>[] = [
    { key: 'week', header: 'Week', render: (r) => formatWeekRange(r.weekStart) },
    { key: 'name', header: 'Employee', sortable: true, render: (r) => <span className="font-medium text-slate-800">{r.employeeName}</span> },
    { key: 'project', header: 'Project', render: (r) => r.projectName },
    { key: 'approver', header: 'Approver', render: (r) => r.approverName },
    { key: 'hours', header: 'Hours', align: 'right', render: (r) => formatHours(r.hours) },
    { key: 'days', header: 'Waiting', align: 'right', sortable: true, render: (r) => <span className={cn(r.daysWaiting > 3 && 'font-semibold text-rose-600')}>{r.daysWaiting} d</span> },
  ];

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Submitted hours" value={formatHours(report.totals.actual)} icon={Clock} hint={`${report.totals.entries} project entries`} />
        <StatCard label="Approved hours" value={formatHours(report.totals.approved)} icon={CheckCircle2} tone="green" hint={report.totals.actual ? `${percent(report.totals.approved, report.totals.actual)}% of submitted` : 'Nothing submitted yet'} />
        <StatCard label="Pending approval" value={formatHours(report.totals.pending)} icon={Hourglass} tone="amber" hint={`${report.compliance.pendingApprovals.length} entries waiting`} />
        <StatCard label="Submission compliance" value={expectedTotal ? `${percent(submittedTotal, expectedTotal)}%` : '—'} icon={Timer} tone="violet" hint={`${submittedTotal} of ${expectedTotal} timesheets submitted`} />
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Weekly hours: actual vs allocated" description="Submitted hours (blue) against allocated hours (grey) per week." />
          <CardBody>
            <ColumnChart data={report.weekly.map((w) => ({ label: formatShort(w.weekStart), value: w.actual, secondary: w.allocated }))} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Timesheet status" description="Weekly timesheets in the selected period." />
          <CardBody>
            {report.timesheetStatus.rows.length === 0 ? (
              <p className="text-sm text-slate-500">No timesheets expected in this period.</p>
            ) : (
              <BarList unit="" data={TIMESHEET_STATUSES.filter((s) => report.timesheetStatus.counts[s]).map((s) => ({ label: statusLabel(s), value: report.timesheetStatus.counts[s] ?? 0, color: STATUS_COLORS[s] }))} />
            )}
          </CardBody>
        </Card>
      </div>

      <Tabs value={tab} onChange={onTab} options={TABS} />

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
            <span className="text-sm text-slate-500">Allocated hours are summed across the weeks in the selected period; actual hours are submitted entries.</span>
          </TableToolbar>
          <DataTable columns={allocCols} rows={allocTable.rows} rowKey={(r) => `${r.employeeId}|${r.projectId}`} sort={allocTable.sort} onSort={allocTable.toggleSort} emptyTitle="No allocations in this period" />
        </Card>
      )}
      {tab === 'timesheets' && (
        <div className="space-y-5">
          <Card>
            <TableToolbar>
              <Segmented
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: 'all' as const, label: 'All', count: report.timesheetStatus.rows.length },
                  ...TIMESHEET_STATUSES.filter((s) => report.timesheetStatus.counts[s]).map((s) => ({ value: s, label: statusLabel(s), count: report.timesheetStatus.counts[s] })),
                ]}
              />
            </TableToolbar>
            <DataTable columns={tsCols} rows={tsTable.rows} rowKey={(r) => `${r.employeeId}|${r.weekStart}`} sort={tsTable.sort} onSort={tsTable.toggleSort} emptyTitle="No timesheets in this view" />
          </Card>
          <Card>
            <CardHeader title="Project entries by approval status" description="Each project line on a submitted timesheet, per week." />
            <DataTable columns={weekCols} rows={[...report.weekly].reverse()} rowKey={(r) => r.weekStart} />
          </Card>
        </div>
      )}
      {tab === 'overtime' && (
        <Card>
          <TableToolbar>
            <Segmented
              value={otView}
              onChange={setOtView}
              options={[
                { value: 'project' as const, label: 'By project', count: report.overtimeByProject.length },
                { value: 'employee' as const, label: 'By employee', count: report.overtime.length },
                { value: 'records' as const, label: 'All records', count: report.overtimeRecords.length },
              ]}
            />
          </TableToolbar>
          {otView === 'project' && <DataTable columns={otProjCols} rows={otProjTable.rows} rowKey={(r) => r.projectId} sort={otProjTable.sort} onSort={otProjTable.toggleSort} emptyTitle="No overtime in this period" />}
          {otView === 'employee' && <DataTable columns={otCols} rows={otTable.rows} rowKey={(r) => r.employeeId} sort={otTable.sort} onSort={otTable.toggleSort} emptyTitle="No overtime in this period" />}
          {otView === 'records' && <DataTable columns={otRecCols} rows={otRecTable.rows} rowKey={(r) => r.id} sort={otRecTable.sort} onSort={otRecTable.toggleSort} emptyTitle="No overtime in this period" />}
        </Card>
      )}
      {tab === 'leave' && (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Leave by employee" description="Leave dated within the period. Balances are not shown because no annual leave entitlement is configured." />
            <DataTable columns={leaveCols} rows={leaveTable.rows} rowKey={(r) => r.employeeId} sort={leaveTable.sort} onSort={leaveTable.toggleSort} emptyTitle="No leave in this period" />
          </Card>
          <Card>
            <CardHeader title="Leave requests and outcomes" />
            <DataTable columns={leaveRecCols} rows={leaveRecTable.rows} rowKey={(r) => r.id} sort={leaveRecTable.sort} onSort={leaveRecTable.toggleSort} emptyTitle="No leave in this period" />
          </Card>
        </div>
      )}
      {tab === 'compliance' && (
        <Card>
          <TableToolbar>
            <Segmented
              value={complianceView}
              onChange={setComplianceView}
              options={[
                { value: 'weeks' as const, label: 'Weekly completion' },
                { value: 'missing' as const, label: 'Missing submissions', count: report.compliance.missing.length },
                { value: 'pending' as const, label: 'Pending approvals', count: report.compliance.pendingApprovals.length },
              ]}
            />
          </TableToolbar>
          {complianceView === 'weeks' && <DataTable columns={complianceCols} rows={[...compliance].reverse()} rowKey={(r) => r.weekStart} emptyTitle="No weeks in this period" />}
          {complianceView === 'missing' && <DataTable columns={missingCols} rows={report.compliance.missing} rowKey={(r) => `${r.employeeId}|${r.weekStart}`} emptyTitle="Everyone submitted" emptyDescription="All expected timesheets in this period were submitted." />}
          {complianceView === 'pending' && <DataTable columns={pendingCols} rows={pendingTable.rows} rowKey={(r) => `${r.employeeName}|${r.projectName}|${r.weekStart}`} sort={pendingTable.sort} onSort={pendingTable.toggleSort} emptyTitle="Nothing waiting for approval" />}
        </Card>
      )}
    </>
  );
}
