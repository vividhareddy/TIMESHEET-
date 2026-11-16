import { useMemo, useState } from 'react';
import { Info, Send, Trash2 } from 'lucide-react';
import type { LeaveDuration, LeaveRequest } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups, useReferenceData } from '@/hooks/useLookups';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { useTableState } from '@/hooks/useTableState';
import { addDays, formatDate, formatDateTime, todayISO } from '@/utils/date';
import { formatHours, sum } from '@/utils/format';
import { findHoliday, isWorkingDay, leaveHours } from '@/utils/timesheet';
import { PageHeader, Alert } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button, IconButton } from '@/components/common/Button';
import { StatusBadge } from '@/components/common/Badge';
import { Field, Input, Select, Textarea } from '@/components/forms/FormControls';
import { DataTable, type Column } from '@/components/tables/DataTable';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { StatCard } from '@/components/common/StatCard';
import { CheckCircle2, Hourglass, Plane } from 'lucide-react';

export function LeaveRequestsPage() {
  const user = useCurrentUser();
  const { leaves, applyLeave, cancelLeave } = useAppData();
  const { calendarOf, employeeName } = useLookups();
  const { busy, run } = useAsyncAction();
  const ref = useReferenceData();
  const cal = calendarOf(user);
  const [date, setDate] = useState(addDays(todayISO(), 1));
  const [duration, setDuration] = useState<LeaveDuration>('full');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [cancelling, setCancelling] = useState<LeaveRequest | null>(null);

  const mine = useMemo(() => leaves.filter((l) => l.employeeId === user.id), [leaves, user.id]);
  const hours = leaveHours(user, cal, duration);
  const holiday = findHoliday(cal, date);
  const workingDay = isWorkingDay(cal, date);
  const duplicate = mine.some((l) => l.date === date && l.status !== 'rejected');
  const dateError = !cal ? 'No holiday calendar is assigned to you yet.' : !date ? 'Select a date.' : holiday ? `${holiday.name} is a holiday on your calendar.` : !workingDay ? 'This is a non-working day on your calendar.' : duplicate ? 'You already have a request for this date.' : undefined;

  const table = useTableState(mine, { accessors: { date: (l) => l.date }, initialSort: { key: 'date', direction: 'desc' } });

  const submit = async () => {
    setTouched(true);
    if (dateError || !reason.trim()) return;
    const ok = await run(() => applyLeave({ date, duration, reason }), {
      title: 'Leave request submitted',
      message: `${formatDate(date)} · ${duration === 'full' ? 'Full day' : 'Half day'} (${formatHours(hours)}) sent to ${employeeName(user.managerId)}.`,
    });
    if (ok) {
      setReason('');
      setTouched(false);
    }
  };

  const columns: Column<LeaveRequest>[] = [
    { key: 'date', header: 'Leave date', sortable: true, render: (l) => <span className="font-medium text-slate-800">{formatDate(l.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span> },
    { key: 'duration', header: 'Duration', render: (l) => ref.label(ref.leaveDurations, l.duration) },
    { key: 'hours', header: 'Hours', align: 'right', render: (l) => <span className="tabular-nums">{formatHours(l.hours)}</span> },
    { key: 'reason', header: 'Reason', render: (l) => <span className="line-clamp-2 max-w-[240px] text-slate-600">{l.reason}</span> },
    { key: 'applied', header: 'Applied', hideOnTablet: true, render: (l) => <span className="text-xs text-slate-500">{formatDateTime(l.appliedOn)}</span> },
    {
      key: 'status',
      header: 'Approval status',
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
      render: (l) => (l.status === 'pending' ? <IconButton icon={Trash2} label="Cancel request" tone="danger" onClick={() => setCancelling(l)} /> : null),
    },
  ];

  return (
    <div>
      <PageHeader title="Leave Requests" description="Request a full or half day off. Leave hours are calculated from your calendar automatically." />

      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-3">
        <StatCard label="Approved leave" value={formatHours(sum(mine.filter((l) => l.status === 'approved').map((l) => l.hours)))} icon={CheckCircle2} tone="green" hint={`${mine.filter((l) => l.status === 'approved').length} request(s)`} />
        <StatCard label="Pending approval" value={mine.filter((l) => l.status === 'pending').length} icon={Hourglass} tone="amber" hint={`Approver: ${employeeName(user.managerId)}`} />
        <StatCard label="Calendar" value={cal?.name ?? '—'} icon={Plane} tone="slate" hint={`${formatHours(leaveHours(user, cal, 'full'))} per full day`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[380px_1fr]">
        <Card className="h-fit">
          <CardHeader title="New leave request" />
          <CardBody className="space-y-4">
            <Field label="Leave date" required error={touched || date ? dateError : undefined}>
              <Input type="date" value={date} min={addDays(todayISO(), -30)} onChange={(e) => setDate(e.target.value)} invalid={!!dateError} />
            </Field>
            <Field label="Leave duration" required>
              <Select value={duration} onChange={(e) => setDuration(e.target.value as LeaveDuration)}>
                {ref.leaveDurations.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </Select>
            </Field>
            <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
              <span className="text-sm text-slate-600">Leave hours (calculated)</span>
              <span className="text-base font-semibold tabular-nums text-slate-900">{formatHours(hours)}</span>
            </div>
            <Field label="Reason" required error={touched && !reason.trim() ? 'Please add a reason.' : undefined}>
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Brief reason for your manager" invalid={touched && !reason.trim()} />
            </Field>
            <Alert tone="info" icon={Info}>
              Based on your {cal?.name} schedule of {formatHours(leaveHours(user, cal, 'full'))} per day: Full Day = {formatHours(leaveHours(user, cal, 'full'))}, Half Day = {formatHours(leaveHours(user, cal, 'half'))}. Approved leave reduces your expected weekly hours.
            </Alert>
            {!cal && <Alert tone="warning">Leave hours are calculated from your holiday calendar. Ask your administrator to assign one before requesting leave.</Alert>}
            <Button icon={Send} className="w-full" loading={busy} disabled={!cal} onClick={submit}>Submit request</Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="My requests" description={`Approver: ${employeeName(user.managerId)}`} />
          <DataTable columns={columns} rows={table.rows} rowKey={(l) => l.id} sort={table.sort} onSort={table.toggleSort} emptyTitle="No leave requests yet" />
        </Card>
      </div>

      <ConfirmDialog
        open={!!cancelling}
        title="Cancel leave request?"
        tone="danger"
        confirmLabel="Cancel request"
        busy={busy}
        message={cancelling && `Your ${cancelling.duration === 'full' ? 'full-day' : 'half-day'} leave on ${formatDate(cancelling.date)} will be withdrawn.`}
        onCancel={() => setCancelling(null)}
        onConfirm={async () => {
          if (!cancelling) return;
          const ok = await run(() => cancelLeave(cancelling.id), { title: 'Leave request cancelled' });
          if (ok) setCancelling(null);
        }}
      />
    </div>
  );
}
