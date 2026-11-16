import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { LeaveRequest } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useLookups } from '@/hooks/useLookups';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { useTableState } from '@/hooks/useTableState';
import { formatDate, formatDateTime } from '@/utils/date';
import { formatHours } from '@/utils/format';
import { DataTable, type Column } from './DataTable';
import { StatusBadge } from '@/components/common/Badge';
import { IconButton } from '@/components/common/Button';
import { PersonCell } from '@/components/common/Misc';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

interface Props {
  leaves: LeaveRequest[];
  /** Show approve / reject actions (the API enforces who may review). */
  reviewable?: boolean;
  showEmployee?: boolean;
  emptyTitle?: string;
}

/** Leave requests list with approve / reject for reviewers. */
export function LeaveRequestTable({ leaves, reviewable = true, showEmployee = true, emptyTitle = 'No leave requests' }: Props) {
  const { reviewLeave } = useAppData();
  const { employee, employeeName, calendarOf } = useLookups();
  const { busy, run } = useAsyncAction();
  const [rejecting, setRejecting] = useState<LeaveRequest | null>(null);
  const table = useTableState(leaves, {
    accessors: { date: (l) => l.date, employee: (l) => employeeName(l.employeeId), status: (l) => l.status },
    initialSort: { key: 'date', direction: 'desc' },
  });

  const approve = (l: LeaveRequest) => run(() => reviewLeave(l.id, 'approved'), { title: 'Leave approved', message: `${employeeName(l.employeeId)} · ${formatDate(l.date)}` });

  const columns: Column<LeaveRequest>[] = [
    ...(showEmployee
      ? [{ key: 'employee', header: 'Employee', sortable: true, render: (l: LeaveRequest) => <PersonCell name={employeeName(l.employeeId)} sub={calendarOf(employee(l.employeeId))?.name} /> }]
      : []),
    { key: 'date', header: 'Leave date', sortable: true, render: (l) => <span className="whitespace-nowrap font-medium text-slate-800">{formatDate(l.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span> },
    { key: 'duration', header: 'Duration', render: (l) => (l.duration === 'full' ? 'Full day' : 'Half day') },
    { key: 'hours', header: 'Leave hours', align: 'right', render: (l) => <span className="tabular-nums">{formatHours(l.hours)}</span> },
    { key: 'reason', header: 'Reason', render: (l) => <span className="line-clamp-2 max-w-[260px] text-slate-600">{l.reason}</span> },
    { key: 'applied', header: 'Applied on', hideOnTablet: true, render: (l) => <span className="whitespace-nowrap text-xs text-slate-500">{formatDateTime(l.appliedOn)}</span> },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (l) => (
        <div>
          <StatusBadge status={l.status} />
          {l.reviewerComment && <p className="mt-1 max-w-[220px] text-xs text-slate-500">{l.reviewerComment}</p>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (l) =>
        l.status === 'pending' && reviewable ? (
          <div className="flex justify-end gap-0.5">
            <IconButton icon={X} label="Reject" tone="danger" onClick={() => setRejecting(l)} />
            <IconButton icon={Check} label="Approve" tone="success" onClick={() => approve(l)} disabled={busy} />
          </div>
        ) : (
          <span className="text-xs text-slate-400">{l.reviewerId ? `by ${employeeName(l.reviewerId)}` : ''}</span>
        ),
    },
  ];

  return (
    <>
      <DataTable columns={columns} rows={table.rows} rowKey={(l) => l.id} sort={table.sort} onSort={table.toggleSort} emptyTitle={emptyTitle} />
      <ConfirmDialog
        open={!!rejecting}
        title="Reject leave request"
        tone="danger"
        confirmLabel="Reject"
        busy={busy}
        message={rejecting && `${employeeName(rejecting.employeeId)} · ${formatDate(rejecting.date)} (${rejecting.duration === 'full' ? 'Full day' : 'Half day'})`}
        comment={{ label: 'Reason for rejection', required: true }}
        onCancel={() => setRejecting(null)}
        onConfirm={async (c) => {
          if (!rejecting) return;
          const ok = await run(() => reviewLeave(rejecting.id, 'rejected', c), { title: 'Leave rejected' });
          if (ok) setRejecting(null);
        }}
      />
    </>
  );
}
