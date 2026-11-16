import type { ReactNode } from 'react';
import { cn, titleCase } from '@/utils/format';
import { useOptionalAppData } from '@/context/AppDataContext';

export type BadgeTone = 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'teal';

const tones: Record<BadgeTone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  teal: 'bg-teal-50 text-teal-700 ring-teal-200',
};

export function Badge({ children, tone = 'slate', className, dot }: { children: ReactNode; tone?: BadgeTone; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, BadgeTone> = {
  // timesheet / entry
  not_started: 'slate',
  draft: 'slate',
  pending: 'amber',
  submitted: 'blue',
  partially_approved: 'teal',
  approved: 'green',
  returned: 'violet',
  rejected: 'red',
  // master data
  active: 'green',
  inactive: 'slate',
  on_hold: 'amber',
  completed: 'blue',
  // allocation health
  under: 'amber',
  optimal: 'green',
  over: 'red',
};

/** Labels for computed UI states only; business statuses use labels from GET /lookups. */
const UI_STATE_LABELS: Record<string, string> = {
  under: 'Under-allocated',
  over: 'Over-allocated',
  optimal: 'Fully allocated',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const data = useOptionalAppData();
  const l = data?.lookups;
  const lookupLabel = l
    ? [...l.timesheetStatuses, ...l.entryStatuses, ...l.projectStatuses, ...l.employeeStatuses, ...l.requestStatuses].find((o) => o.value === status)?.label
    : undefined;
  return (
    <Badge tone={STATUS_TONES[status] ?? 'slate'} dot>
      {label ?? lookupLabel ?? UI_STATE_LABELS[status] ?? titleCase(status)}
    </Badge>
  );
}
