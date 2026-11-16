import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { OvertimeRequest } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useLookups } from '@/hooks/useLookups';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { useTableState } from '@/hooks/useTableState';
import { formatDate, formatWeekRange } from '@/utils/date';
import { formatHours } from '@/utils/format';
import { DataTable, type Column } from './DataTable';
import { Badge, StatusBadge } from '@/components/common/Badge';
import { IconButton } from '@/components/common/Button';
import { PersonCell, ProjectDot } from '@/components/common/Misc';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

interface Props {
  records: OvertimeRequest[];
  /** Show approve / reject actions (the API enforces who may review). */
  reviewable?: boolean;
  showEmployee?: boolean;
  emptyTitle?: string;
}

export function OvertimeTable({ records, reviewable = false, showEmployee = true, emptyTitle = 'No overtime records' }: Props) {
  const { reviewOvertime, policy } = useAppData();
  const { employeeName, project } = useLookups();
  const { busy, run } = useAsyncAction();
  const [rejecting, setRejecting] = useState<OvertimeRequest | null>(null);
  const table = useTableState(records, {
    accessors: { week: (o) => o.weekStart, hours: (o) => o.hours, employee: (o) => employeeName(o.employeeId) },
    initialSort: { key: 'week', direction: 'desc' },
  });

  const columns: Column<OvertimeRequest>[] = [
    ...(showEmployee ? [{ key: 'employee', header: 'Employee', sortable: true, render: (o: OvertimeRequest) => <PersonCell name={employeeName(o.employeeId)} /> }] : []),
    {
      key: 'project',
      header: 'Project',
      render: (o) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <ProjectDot color={project(o.projectId)?.color ?? '#94a3b8'} /> {project(o.projectId)?.name}
        </span>
      ),
    },
    {
      key: 'week',
      header: 'Period',
      sortable: true,
      render: (o) => (
        <span className="whitespace-nowrap text-slate-600">{o.date ? formatDate(o.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : formatWeekRange(o.weekStart)}</span>
      ),
    },
    { key: 'hours', header: 'Hours', align: 'right', sortable: true, render: (o) => <span className="font-semibold tabular-nums text-slate-800">{formatHours(o.hours)}</span> },
    {
      key: 'source',
      header: 'Type',
      render: (o) => (o.source === 'timesheet' ? <Badge tone="violet">Auto-flagged</Badge> : <Badge tone="blue">Pre-approval</Badge>),
    },
    { key: 'reason', header: 'Reason', hideOnTablet: true, render: (o) => <span className="line-clamp-2 max-w-[260px] text-xs text-slate-600">{o.reason}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (o) => (
        <div>
          <StatusBadge status={o.status} />
          {o.reviewerComment && <p className="mt-1 max-w-[200px] text-xs text-slate-500">{o.reviewerComment}</p>}
        </div>
      ),
    },
    ...(reviewable
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            render: (o: OvertimeRequest) =>
              o.status === 'pending' ? (
                <div className="flex justify-end gap-0.5">
                  <IconButton icon={X} label="Reject" tone="danger" onClick={() => setRejecting(o)} />
                  <IconButton
                    icon={Check}
                    label="Approve"
                    tone="success"
                    disabled={busy}
                    onClick={() =>
                      run(() => reviewOvertime(o.id, 'approved'), {
                        title: 'Overtime approved',
                        message: `${formatHours(o.hours)} at ${policy.weekdayMultiplier}× for ${employeeName(o.employeeId)}`,
                      })
                    }
                  />
                </div>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <>
      <DataTable columns={columns} rows={table.rows} rowKey={(o) => o.id} sort={table.sort} onSort={table.toggleSort} emptyTitle={emptyTitle} />
      <ConfirmDialog
        open={!!rejecting}
        title="Reject overtime"
        tone="danger"
        confirmLabel="Reject"
        busy={busy}
        message={rejecting && `${employeeName(rejecting.employeeId)} · ${formatHours(rejecting.hours)} on ${project(rejecting.projectId)?.name}`}
        comment={{ label: 'Reason for rejection', required: true }}
        onCancel={() => setRejecting(null)}
        onConfirm={async (c) => {
          if (!rejecting) return;
          const ok = await run(() => reviewOvertime(rejecting.id, 'rejected', c), { title: 'Overtime rejected' });
          if (ok) setRejecting(null);
        }}
      />
    </>
  );
}
