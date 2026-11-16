import { useMemo, useState } from 'react';
import { Check, CheckCheck, Eye, Pencil, Undo2, X } from 'lucide-react';
import type { EntryStatus } from '@/types';
import type { ApprovalItem, ReviewAction } from '@/types/api';
import { useAppData } from '@/context/AppDataContext';
import { useLookups, useReferenceData } from '@/hooks/useLookups';
import { useTableState } from '@/hooks/useTableState';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { useApiQuery } from '@/hooks/useApiQuery';
import { approvalService } from '@/services';
import { formatWeekRange, DAY_SHORT } from '@/utils/date';
import { cn, formatHours, percent, sum } from '@/utils/format';
import { Card } from '@/components/common/Card';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';
import { Segmented, PersonCell, ProjectDot, InfoRow, Alert } from '@/components/common/Misc';
import { StatusBadge } from '@/components/common/Badge';
import { Button, IconButton } from '@/components/common/Button';
import { SearchInput, FilterSelect } from '@/components/forms/FormControls';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { ErrorState, Spinner } from '@/components/common/StatusScreen';
import { HoursTable } from './HoursTable';
import { ApprovalHistory } from './ApprovalHistory';
import { ModifyHoursModal } from './ModifyHoursModal';

type StatusFilter = Exclude<EntryStatus, 'draft'> | 'all';
const STATUS_TABS: StatusFilter[] = ['pending', 'returned', 'rejected', 'approved', 'all'];

interface ApprovalBoardProps {
  /** Projects offered in the project filter (manager: own projects; admin: omit for all). The API enforces scope. */
  projectIds?: string[];
}

const ref = (i: ApprovalItem) => ({ timesheetId: i.timesheetId, projectId: i.project.id });

export function ApprovalBoard({ projectIds }: ApprovalBoardProps) {
  const { projects, reviewEntries, modifyEntryHours, policy } = useAppData();
  const lookups = useReferenceData();
  const { busy, run } = useAsyncAction();
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [projectFilter, setProjectFilter] = useState('all');
  const [weekFilter, setWeekFilter] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [action, setAction] = useState<{ type: ReviewAction | 'bulk'; items: ApprovalItem[] } | null>(null);
  const [modifying, setModifying] = useState<ApprovalItem | null>(null);

  const query = useApiQuery(() => approvalService.list({ status: 'all', projectId: projectFilter === 'all' ? undefined : projectFilter }), [projectFilter]);
  const allItems = useMemo(() => query.data ?? [], [query.data]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { pending: 0, returned: 0, rejected: 0, approved: 0, all: allItems.length };
    for (const i of allItems) if (i.entry.status in c) c[i.entry.status as StatusFilter] += 1;
    return c;
  }, [allItems]);

  const weeks = useMemo(() => [...new Set(allItems.map((i) => i.weekStart))].sort().reverse(), [allItems]);
  const filtered = useMemo(
    () => allItems.filter((i) => (status === 'all' || i.entry.status === status) && (weekFilter === 'all' || i.weekStart === weekFilter)),
    [allItems, status, weekFilter],
  );

  const table = useTableState(filtered, {
    searchText: (i) => `${i.employee.name} ${i.project.name} ${i.entry.description}`,
    accessors: { employee: (i) => i.employee.name, project: (i) => i.project.name, week: (i) => i.weekStart, total: (i) => i.total },
  });

  const filterProjects = projects.filter((p) => !projectIds || projectIds.includes(p.id));
  const hasWeekend = filtered.some((i) => i.entry.hours[5] + i.entry.hours[6] > 0);
  const reviewItem = allItems.find((i) => i.id === reviewing) ?? null;

  const doReview = async (type: ReviewAction, items: ApprovalItem[], comment?: string) => {
    const ok = await run(() => reviewEntries(items.map(ref), type, comment), {
      title: type === 'approved' ? `${items.length} entr${items.length === 1 ? 'y' : 'ies'} approved` : type === 'returned' ? 'Returned for correction' : 'Entry rejected',
      message: items.length === 1 ? `${items[0].employee.name} · ${items[0].project.name} · ${formatWeekRange(items[0].weekStart)}` : undefined,
    });
    // Always re-read from the API so the list reflects server state (even after a conflict).
    query.reload();
    if (ok) {
      setAction(null);
      setSelected(new Set());
      setReviewing(null);
    }
  };

  const columns: Column<ApprovalItem>[] = [
    { key: 'employee', header: 'Employee', sortable: true, render: (i) => <PersonCell name={i.employee.name} sub={i.employee.designation} /> },
    {
      key: 'project',
      header: 'Project',
      sortable: true,
      render: (i) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <ProjectDot color={i.project.color} /> {i.project.name}
        </span>
      ),
    },
    { key: 'week', header: 'Week', sortable: true, render: (i) => <span className="whitespace-nowrap text-xs text-slate-600">{formatWeekRange(i.weekStart)}</span> },
    ...[0, 1, 2, 3, 4, ...(hasWeekend ? [5, 6] : [])].map<Column<ApprovalItem>>((d) => ({
      key: `d${d}`,
      header: DAY_SHORT[d],
      align: 'center',
      hideOnTablet: true,
      className: 'px-1.5',
      render: (i) => <span className={cn('tabular-nums', !i.entry.hours[d] && 'text-slate-300')}>{i.entry.hours[d] ? formatHours(i.entry.hours[d], false) : '–'}</span>,
    })),
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      sortable: true,
      render: (i) => (
        <div className="whitespace-nowrap tabular-nums">
          <div className="font-semibold text-slate-800">{formatHours(i.total)}</div>
          {i.allocation && (
            <div className={cn('text-[11px]', i.total > i.allocation.weeklyHours ? 'text-amber-700' : 'text-slate-400')} title="Allocated weekly hours">/ {formatHours(i.allocation.weeklyHours)}</div>
          )}
        </div>
      ),
    },
    { key: 'description', header: 'Work description', hideOnTablet: 'wide', render: (i) => <p className="line-clamp-2 max-w-[260px] text-xs text-slate-500">{i.entry.description || '—'}</p> },
    { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.entry.status} label={lookups.label(lookups.entryStatuses, i.entry.status)} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      className: 'pl-2',
      render: (i) => (
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          <IconButton icon={Eye} label="View details" onClick={() => setReviewing(i.id)} />
          {i.entry.status === 'pending' && (
            <>
              <IconButton icon={Pencil} label="Modify hours" tone="warning" onClick={() => setModifying(i)} />
              <IconButton icon={Undo2} label="Return for correction" tone="warning" onClick={() => setAction({ type: 'returned', items: [i] })} />
              <IconButton icon={X} label="Reject" tone="danger" onClick={() => setAction({ type: 'rejected', items: [i] })} />
              <IconButton icon={Check} label="Approve" tone="success" onClick={() => doReview('approved', [i])} disabled={busy} />
            </>
          )}
        </div>
      ),
    },
  ];

  const selectedItems = table.rows.filter((i) => selected.has(i.id));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={status}
          onChange={(v) => {
            setStatus(v);
            setSelected(new Set());
          }}
          options={STATUS_TABS.map((s) => ({ value: s, label: s === 'all' ? 'All' : lookups.label(lookups.entryStatuses, s), count: query.data ? counts[s] : undefined }))}
        />
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">{selected.size} selected</span>
            <Button variant="success" icon={CheckCheck} loading={busy} onClick={() => setAction({ type: 'bulk', items: selectedItems })}>
              Approve selected
            </Button>
          </div>
        )}
      </div>

      <Card>
        <TableToolbar>
          <SearchInput value={table.query} onChange={table.setQuery} placeholder="Search employee, project…" />
          {filterProjects.length > 1 && (
            <FilterSelect
              label="Project"
              value={projectFilter}
              onChange={setProjectFilter}
              options={[{ value: 'all', label: 'All projects' }, ...filterProjects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          )}
          <FilterSelect label="Week" value={weekFilter} onChange={setWeekFilter} options={[{ value: 'all', label: 'All weeks' }, ...weeks.map((w) => ({ value: w, label: formatWeekRange(w) }))]} />
        </TableToolbar>
        {query.error ? (
          <ErrorState message={query.error} onRetry={query.reload} compact />
        ) : !query.data ? (
          <div className="flex justify-center py-12"><Spinner label="Loading approvals…" /></div>
        ) : (
          <DataTable
            columns={columns}
            rows={table.rows}
            rowKey={(i) => i.id}
            sort={table.sort}
            onSort={table.toggleSort}
            onRowClick={(i) => setReviewing(i.id)}
            emptyTitle={status === 'pending' ? 'Nothing waiting for approval' : 'No entries match these filters'}
            emptyDescription={status === 'pending' ? 'Submitted project hours will appear here for review.' : undefined}
            selection={
              status === 'pending' || status === 'all'
                ? {
                    selected,
                    onToggle: (id) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (n.has(id)) n.delete(id);
                        else n.add(id);
                        return n;
                      }),
                    onToggleAll: (ids) => setSelected(new Set(ids)),
                    isSelectable: (i) => i.entry.status === 'pending',
                  }
                : undefined
            }
          />
        )}
      </Card>

      {reviewItem && (
        <EntryReviewModal
          item={reviewItem}
          dailyThreshold={policy.dailyThreshold}
          onClose={() => setReviewing(null)}
          onAction={(type) => setAction({ type, items: [reviewItem] })}
          onApprove={() => doReview('approved', [reviewItem])}
          onModify={() => setModifying(reviewItem)}
          busy={busy}
        />
      )}

      <ConfirmDialog
        open={!!action && action.type === 'bulk'}
        title="Approve selected entries?"
        message={`${action?.items.length ?? 0} project entries totalling ${formatHours(sum(action?.items.map((i) => i.total) ?? []))} will be approved.`}
        confirmLabel="Approve all"
        tone="success"
        busy={busy}
        onCancel={() => setAction(null)}
        onConfirm={() => action && doReview('approved', action.items)}
      />
      <ConfirmDialog
        open={!!action && (action.type === 'returned' || action.type === 'rejected')}
        title={action?.type === 'returned' ? 'Return for correction' : 'Reject entry'}
        tone={action?.type === 'returned' ? 'warning' : 'danger'}
        confirmLabel={action?.type === 'returned' ? 'Return to employee' : 'Reject'}
        busy={busy}
        message={
          action?.items[0] && (
            <p>
              <span className="font-medium text-slate-800">{action.items[0].employee.name}</span> · {action.items[0].project.name} · {formatWeekRange(action.items[0].weekStart)} (
              {formatHours(action.items[0].total)}). {action.type === 'returned' ? 'The entry will be unlocked so the employee can correct and resubmit it.' : 'The employee will be notified that these hours were rejected.'}
            </p>
          )
        }
        comment={{ label: 'Comment to employee', required: true, placeholder: 'Explain what needs to change…' }}
        onCancel={() => setAction(null)}
        onConfirm={(comment) => action && doReview(action.type as ReviewAction, action.items, comment)}
      />
      <ModifyHoursModal
        open={!!modifying}
        entry={modifying?.entry ?? null}
        weekStart={modifying?.weekStart ?? ''}
        projectName={modifying?.project.name ?? ''}
        employeeName={modifying?.employee.name ?? ''}
        busy={busy}
        onCancel={() => setModifying(null)}
        onSave={async (hours, reason) => {
          if (!modifying) return;
          const ok = await run(() => modifyEntryHours(ref(modifying), hours, reason), {
            title: 'Hours modified',
            message: 'The change and reason were added to the approval history.',
          });
          query.reload();
          if (ok) setModifying(null);
        }}
      />
    </>
  );
}

function EntryReviewModal({
  item,
  dailyThreshold,
  onClose,
  onAction,
  onApprove,
  onModify,
  busy,
}: {
  item: ApprovalItem;
  dailyThreshold: number;
  onClose: () => void;
  onAction: (type: ReviewAction) => void;
  onApprove: () => void;
  onModify: () => void;
  busy: boolean;
}) {
  const { calendar, employeeName } = useLookups();
  const lookups = useReferenceData();
  const pending = item.entry.status === 'pending';

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${item.employee.name} · ${item.project.name}`}
      description={`Week of ${formatWeekRange(item.weekStart)}`}
      footer={
        pending ? (
          <>
            <Button variant="secondary" icon={Pencil} onClick={onModify}>Modify hours</Button>
            <Button variant="warning" icon={Undo2} onClick={() => onAction('returned')}>Return</Button>
            <Button variant="danger" icon={X} onClick={() => onAction('rejected')}>Reject</Button>
            <Button variant="success" icon={Check} onClick={onApprove} loading={busy}>Approve</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={item.entry.status} label={lookups.label(lookups.entryStatuses, item.entry.status)} />
          {item.entry.reviewedBy && <span className="text-xs text-slate-500">Reviewed by {employeeName(item.entry.reviewedBy)}</span>}
          {item.entry.originalHours && <span className="text-xs font-medium text-violet-700">Hours modified by manager</span>}
        </div>

        <HoursTable entries={[item.entry]} weekStart={item.weekStart} calendar={calendar(item.employee.calendarId)} allocations={item.allocation ? [item.allocation] : []} showStatus={false} dailyThreshold={dailyThreshold} />

        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-sm font-semibold text-slate-800">Allocation details</h4>
            <div className="divide-y divide-slate-100 rounded-md border border-slate-200 px-4">
              <InfoRow label="Project role">{item.allocation?.projectRole ?? '—'}</InfoRow>
              <InfoRow label="Allocated (this project)">
                {item.allocation ? `${formatHours(item.allocation.weeklyHours)} · ${percent(item.allocation.weeklyHours, item.employee.weeklyCapacity)}%` : 'Not allocated'}
              </InfoRow>
              <InfoRow label="Actual (this project)">{formatHours(item.total)}</InfoRow>
              <InfoRow label="All projects this week">
                {formatHours(item.timesheetTotal)} of {formatHours(item.expectedHours)} expected
              </InfoRow>
              <InfoRow label="Total allocation">{formatHours(item.weekAllocatedHours)} across {item.weekAllocationCount} project(s)</InfoRow>
            </div>
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold text-slate-800">Work description</h4>
            <p className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">{item.entry.description || 'No description provided.'}</p>
            {item.allocation && item.total > item.allocation.weeklyHours && (
              <Alert tone="warning" className="mt-3">
                Actual hours exceed the allocation by {formatHours(item.total - item.allocation.weeklyHours)}.
              </Alert>
            )}
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-sm font-semibold text-slate-800">Approval history & comments</h4>
          <ApprovalHistory events={item.history} />
        </div>
      </div>
    </Modal>
  );
}
