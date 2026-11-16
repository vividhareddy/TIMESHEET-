import { CheckCircle2, Pencil, RotateCcw, Save, Send, Undo2, XCircle, type LucideIcon } from 'lucide-react';
import type { ApprovalEvent, HistoryAction } from '@/types';
import { useLookups } from '@/hooks/useLookups';
import { formatDateTime } from '@/utils/date';
import { cn } from '@/utils/format';

const META: Record<HistoryAction, { icon: LucideIcon; label: string; className: string }> = {
  saved: { icon: Save, label: 'saved a draft', className: 'bg-slate-100 text-slate-500' },
  submitted: { icon: Send, label: 'submitted the timesheet', className: 'bg-brand-50 text-brand-600' },
  resubmitted: { icon: Send, label: 'resubmitted the timesheet', className: 'bg-brand-50 text-brand-600' },
  approved: { icon: CheckCircle2, label: 'approved', className: 'bg-emerald-50 text-emerald-600' },
  rejected: { icon: XCircle, label: 'rejected', className: 'bg-rose-50 text-rose-600' },
  returned: { icon: Undo2, label: 'returned for correction', className: 'bg-violet-50 text-violet-600' },
  modified: { icon: Pencil, label: 'modified hours on', className: 'bg-amber-50 text-amber-700' },
  reopened: { icon: RotateCcw, label: 'reopened the timesheet', className: 'bg-slate-100 text-slate-600' },
};

export function ApprovalHistory({ events, projectId }: { events: ApprovalEvent[]; projectId?: string }) {
  const { employeeName, projectName } = useLookups();
  const list = [...events]
    .filter((e) => !projectId || !e.projectId || e.projectId === projectId)
    .sort((a, b) => b.at.localeCompare(a.at));

  if (!list.length) return <p className="text-sm text-slate-500">No activity yet.</p>;

  return (
    <ol className="relative space-y-4">
      {list.map((e, i) => {
        const meta = META[e.action];
        return (
          <li key={e.id} className="relative flex gap-3">
            {i < list.length - 1 && <span className="absolute left-[13px] top-7 h-[calc(100%-4px)] w-px bg-slate-200" />}
            <span className={cn('relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full', meta.className)}>
              <meta.icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-sm text-slate-700">
                <span className="font-medium text-slate-900">{employeeName(e.actorId)}</span> {meta.label}
                {e.projectId && <span className="font-medium text-slate-900"> {projectName(e.projectId)}</span>}
              </p>
              <p className="text-xs text-slate-400">{formatDateTime(e.at)}</p>
              {e.comment && e.action !== 'saved' && e.action !== 'submitted' && (
                <p className="mt-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">{e.comment}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
