import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/format';

interface StatCardProps {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  hint?: ReactNode;
  tone?: 'blue' | 'green' | 'amber' | 'violet' | 'slate' | 'red';
  to?: string;
  /** Show a placeholder bar while the value is being fetched. */
  loading?: boolean;
}

const iconTones = {
  blue: 'bg-brand-50 text-brand-600',
  green: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  violet: 'bg-violet-50 text-violet-600',
  slate: 'bg-slate-100 text-slate-600',
  red: 'bg-rose-50 text-rose-600',
};

export function StatCard({ label, value, icon: Icon, hint, tone = 'blue', to, loading }: StatCardProps) {
  const content = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {loading ? (
          <div className="mt-3 h-6 w-16 animate-pulse rounded bg-slate-200" aria-label="Loading" />
        ) : (
          <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
        )}
        {hint && !loading && <p className="mt-1 truncate text-xs text-slate-500">{hint}</p>}
      </div>
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', iconTones[tone])}>
        <Icon className="h-[18px] w-[18px]" />
      </span>
    </div>
  );
  const base = 'block rounded-lg border border-slate-200 bg-white p-4 shadow-card';
  return to ? (
    <Link to={to} className={cn(base, 'transition-colors hover:border-brand-200 hover:bg-brand-50/30')}>
      {content}
    </Link>
  ) : (
    <div className={base}>{content}</div>
  );
}
