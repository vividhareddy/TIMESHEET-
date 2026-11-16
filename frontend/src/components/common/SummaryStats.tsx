import type { ComponentProps } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ApiQuery } from '@/hooks/useApiQuery';
import { StatCard } from './StatCard';
import { Alert } from './Misc';
import { Button } from './Button';
import { cn } from '@/utils/format';

type StatDef<T> = Omit<ComponentProps<typeof StatCard>, 'value' | 'hint' | 'loading'> & {
  value: (data: T) => React.ReactNode;
  hint?: (data: T) => React.ReactNode;
};

/**
 * A row of stat cards backed by an API summary endpoint.
 * Shows placeholders while loading and an error (with retry) on failure — never invented numbers.
 */
export function SummaryStats<T>({ query, stats, className }: { query: ApiQuery<T>; stats: StatDef<T>[]; className?: string }) {
  if (query.error) {
    return (
      <Alert tone="danger" icon={AlertTriangle} className="mb-6" title="Summary figures are unavailable">
        <div className="flex flex-wrap items-center gap-3">
          <span>{query.error}</span>
          <Button size="sm" variant="secondary" onClick={query.reload}>Try again</Button>
        </div>
      </Alert>
    );
  }
  const data = query.data;
  return (
    <div className={cn('mb-6 grid grid-cols-2 gap-4 md:grid-cols-3', className)}>
      {stats.map(({ value, hint, ...rest }) => (
        <StatCard key={rest.label} {...rest} loading={data === undefined} value={data === undefined ? null : value(data)} hint={data === undefined || !hint ? undefined : hint(data)} />
      ))}
    </div>
  );
}
