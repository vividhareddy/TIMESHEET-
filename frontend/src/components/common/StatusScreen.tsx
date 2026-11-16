import type { ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { cn } from '@/utils/format';

/** Full-page loading indicator. */
export function LoadingScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <Spinner label={label} />
    </div>
  );
}

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 text-sm text-slate-500', className)} role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      {label}
    </div>
  );
}

/** Error panel — shown instead of data when an API call fails. Never falls back to fabricated values. */
export function ErrorState({ title = 'Unable to load data', message, onRetry, actions, compact }: { title?: string; message?: string; onRetry?: () => void; actions?: ReactNode; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-6 py-8' : 'px-6 py-14')}>
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-50 text-rose-500">
        <AlertTriangle className="h-5 w-5" />
      </span>
      <p className="mt-3 text-sm font-semibold text-slate-800">{title}</p>
      {message && <p className="mt-1 max-w-md text-sm text-slate-500">{message}</p>}
      <div className="mt-4 flex gap-2">
        {onRetry && (
          <Button variant="secondary" icon={RefreshCw} onClick={onRetry}>
            Try again
          </Button>
        )}
        {actions}
      </div>
    </div>
  );
}

export function ErrorScreen(props: Parameters<typeof ErrorState>[0]) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-card">
        <ErrorState {...props} />
      </div>
    </div>
  );
}

/** Wrap a section that depends on an async query. */
export function QueryBoundary<T>({ query, children, loadingLabel = 'Loading…', compact = true }: { query: { data: T | undefined; loading: boolean; error: string | null; reload: () => void }; children: (data: T) => ReactNode; loadingLabel?: string; compact?: boolean }) {
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} compact={compact} />;
  if (query.data === undefined) return <div className={cn('flex justify-center', compact ? 'py-10' : 'py-16')}><Spinner label={loadingLabel} /></div>;
  return <>{children(query.data)}</>;
}
