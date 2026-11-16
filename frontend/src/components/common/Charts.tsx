import type { ReactNode } from 'react';
import { cn, formatHours } from '@/utils/format';

export interface BarDatum {
  label: ReactNode;
  value: number;
  color?: string;
  secondary?: number;
  suffix?: ReactNode;
}

/** Horizontal bar list. When `secondary` is set it is drawn as a target marker (e.g. allocation). */
export function BarList({ data, max, unit = 'h', legend }: { data: BarDatum[]; max?: number; unit?: 'h' | '%' | ''; legend?: { primary: string; secondary?: string } }) {
  const top = max ?? Math.max(1, ...data.map((d) => Math.max(d.value, d.secondary ?? 0)));
  const fmt = (v: number) => (unit === 'h' ? formatHours(v) : unit === '%' ? `${v}%` : String(v));
  return (
    <div className="space-y-3">
      {legend && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-brand-500" /> {legend.primary}</span>
          {legend.secondary && <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 bg-slate-700" /> {legend.secondary}</span>}
        </div>
      )}
      {data.map((d, i) => (
        <div key={i}>
          <div className="mb-1 flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-slate-700">{d.label}</span>
            <span className="shrink-0 tabular-nums text-slate-600">
              <span className="font-medium text-slate-800">{fmt(d.value)}</span>
              {d.secondary !== undefined && <span className="text-slate-400"> / {fmt(d.secondary)}</span>}
              {d.suffix}
            </span>
          </div>
          <div className="relative h-2 rounded-full bg-slate-100">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, (d.value / top) * 100)}%`, backgroundColor: d.color ?? '#3b6db3' }} />
            {d.secondary !== undefined && (
              <span className="absolute -top-1 h-4 w-0.5 rounded bg-slate-700" style={{ left: `calc(${Math.min(100, (d.secondary / top) * 100)}% - 1px)` }} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Single stacked bar showing parts of a whole (e.g. allocation split across projects). */
export function StackedBar({ segments, total, className }: { segments: Array<{ value: number; color: string; label: string }>; total: number; className?: string }) {
  const sumValues = segments.reduce((a, s) => a + s.value, 0);
  const denom = Math.max(total, sumValues) || 1;
  return (
    <div className={cn('flex h-2 w-full overflow-hidden rounded-full bg-slate-100', className)}>
      {segments.map((s, i) => (
        <div key={i} title={`${s.label}: ${formatHours(s.value)}`} style={{ width: `${(s.value / denom) * 100}%`, backgroundColor: s.color }} className="h-full border-r border-white last:border-0" />
      ))}
    </div>
  );
}

/** Vertical column chart for weekly trends. */
export function ColumnChart({ data, height = 160, target }: { data: Array<{ label: string; value: number; secondary?: number }>; height?: number; target?: number }) {
  const top = Math.max(1, target ?? 0, ...data.map((d) => Math.max(d.value, d.secondary ?? 0))) * 1.1;
  return (
    <div>
      <div className="relative flex items-end gap-3 border-b border-slate-200" style={{ height }}>
        {target !== undefined && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-slate-400" style={{ bottom: `${(target / top) * 100}%` }}>
            <span className="absolute -top-4 right-0 text-[10px] text-slate-500">Target {formatHours(target)}</span>
          </div>
        )}
        {data.map((d, i) => (
          <div key={i} className="flex h-full flex-1 items-end justify-center gap-1">
            {d.secondary !== undefined && (
              <div className="w-full max-w-[18px] rounded-t bg-slate-300" style={{ height: `${(d.secondary / top) * 100}%` }} title={`Allocated ${formatHours(d.secondary)}`} />
            )}
            <div className="w-full max-w-[18px] rounded-t bg-brand-500" style={{ height: `${(d.value / top) * 100}%` }} title={formatHours(d.value)} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-3">
        {data.map((d, i) => (
          <div key={i} className="flex-1 truncate text-center text-[11px] text-slate-500">{d.label}</div>
        ))}
      </div>
    </div>
  );
}
