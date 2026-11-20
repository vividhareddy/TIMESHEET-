import type { Allocation, ISODate, TimesheetEntry, WorkCalendar } from '@/types';
import { DAY_SHORT, formatShort, weekDates } from '@/utils/date';
import { cn, formatHours, sum } from '@/utils/format';
import { dailyTotals, ENTRY_TYPE_LABEL, entryTotal, findHoliday } from '@/utils/timesheet';
import { useLookups } from '@/hooks/useLookups';
import { StatusBadge } from '@/components/common/Badge';
import { ProjectDot } from '@/components/common/Misc';

interface HoursTableProps {
  entries: TimesheetEntry[];
  weekStart: ISODate;
  calendar?: WorkCalendar;
  allocations?: Allocation[];
  showStatus?: boolean;
  showWeekend?: boolean;
  dailyThreshold?: number;
}

/** Read-only weekly hours grid used in approval and detail views. */
export function HoursTable({ entries, weekStart, calendar, allocations = [], showStatus = true, showWeekend, dailyThreshold = 8 }: HoursTableProps) {
  const { project } = useLookups();
  const dates = weekDates(weekStart);
  const hasWeekend = showWeekend ?? entries.some((e) => (e.hours[5] ?? 0) + (e.hours[6] ?? 0) > 0);
  const dayIdx = hasWeekend ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4];
  const totals = dailyTotals(entries);

  return (
    <div className="relative overflow-x-auto rounded-md border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Project</th>
            {dayIdx.map((i) => {
              const hol = findHoliday(calendar, dates[i]);
              return (
                <th key={i} className={cn('px-2 py-2 text-center font-semibold', (i > 4 || hol) && 'bg-slate-100/80')} title={hol?.name}>
                  <div>{DAY_SHORT[i]}</div>
                  <div className="font-normal text-slate-400">{formatShort(dates[i])}</div>
                </th>
              );
            })}
            <th className="px-3 py-2 text-right font-semibold">Total</th>
            {allocations.length > 0 && <th className="px-3 py-2 text-right font-semibold">Allocated</th>}
            {showStatus && <th className="px-3 py-2 text-left font-semibold">Status</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {entries.map((e) => {
            const p = project(e.projectId);
            const alloc = allocations.find((a) => a.projectId === e.projectId);
            return (
              <tr key={e.projectId}>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2 font-medium text-slate-800">
                    <ProjectDot color={p?.color ?? '#94a3b8'} /> {p?.name ?? e.projectId}
                  </span>
                </td>
                {dayIdx.map((i) => {
                  const changed = e.originalHours && e.originalHours[i] !== e.hours[i];
                  const type = e.entryTypes?.[i] ?? 'regular';
                  return (
                    <td key={i} className={cn('px-2 py-2 text-center tabular-nums', i > 4 && 'bg-slate-50', changed && 'font-semibold text-violet-700')} title={changed ? `Originally ${formatHours(e.originalHours![i])}` : undefined}>
                      {e.hours[i] ? formatHours(e.hours[i], false) : <span className="text-slate-300">–</span>}
                      {type !== 'regular' && <div className="text-[10px] font-medium uppercase text-brand-600">{ENTRY_TYPE_LABEL[type]}</div>}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{formatHours(entryTotal(e))}</td>
                {allocations.length > 0 && <td className="px-3 py-2 text-right tabular-nums text-slate-500">{alloc ? formatHours(alloc.weeklyHours) : '—'}</td>}
                {showStatus && (
                  <td className="px-3 py-2">
                    <StatusBadge status={e.status} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700">
          <tr>
            <td className="px-3 py-2">Daily total</td>
            {dayIdx.map((i) => (
              <td key={i} className={cn('px-2 py-2 text-center tabular-nums', totals[i] > dailyThreshold && 'text-amber-700')}>
                {formatHours(totals[i], false)}
              </td>
            ))}
            <td className="px-3 py-2 text-right tabular-nums">{formatHours(sum(totals))}</td>
            {allocations.length > 0 && <td className="px-3 py-2 text-right tabular-nums text-slate-500">{formatHours(sum(allocations.map((a) => a.weeklyHours)))}</td>}
            {showStatus && <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
