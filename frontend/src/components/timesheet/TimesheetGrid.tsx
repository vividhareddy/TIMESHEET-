import { Fragment, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Lock, MessageSquare, NotebookPen, Plane } from 'lucide-react';
import type { Allocation, TimesheetEntry } from '@/types';
import type { DayExpectation } from '@/utils/timesheet';
import { dailyTotals, entryTotal, isEntryLocked } from '@/utils/timesheet';
import { DAY_SHORT, formatShort } from '@/utils/date';
import { cn, formatHours, percent, roundToIncrement, sum } from '@/utils/format';
import { useLookups } from '@/hooks/useLookups';
import { StatusBadge } from '@/components/common/Badge';
import { ProjectDot } from '@/components/common/Misc';

interface TimesheetGridProps {
  entries: TimesheetEntry[];
  onChange: (entries: TimesheetEntry[]) => void;
  days: DayExpectation[];
  allocations: Allocation[];
  capacity: number;
  showWeekend: boolean;
  allowWeekendEntry: boolean;
  dailyThreshold: number;
  increment: number;
  readOnly?: boolean;
  invalidDescriptions?: Set<string>;
}

export function TimesheetGrid({
  entries,
  onChange,
  days,
  allocations,
  capacity,
  showWeekend,
  allowWeekendEntry,
  dailyThreshold,
  increment,
  readOnly,
  invalidDescriptions,
}: TimesheetGridProps) {
  const { project } = useLookups();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const dayIdx = showWeekend ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4];
  const totals = dailyTotals(entries);
  const leaveRow = days.map((d) => d.leaveHours);
  const hasLeave = leaveRow.some((h) => h > 0);
  const totalAllocated = sum(allocations.map((a) => a.weeklyHours));

  const toggle = (pid: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });

  const update = (pid: string, patch: (e: TimesheetEntry) => TimesheetEntry) => onChange(entries.map((e) => (e.projectId === pid ? patch(e) : e)));

  const setHour = (pid: string, i: number, raw: string, commit = false) => {
    let v = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (v > 24) v = 24;
    if (commit) v = roundToIncrement(v, increment);
    update(pid, (e) => {
      const hours = [...e.hours];
      hours[i] = v;
      return { ...e, hours };
    });
  };

  const colCount = dayIdx.length + 4;

  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500">
            <th className="w-[230px] px-4 py-2.5 text-left font-semibold uppercase tracking-wide">Project</th>
            <th className="px-2 py-2.5 text-right font-semibold uppercase tracking-wide">Allocated</th>
            {dayIdx.map((i) => {
              const d = days[i];
              const weekend = i > 4;
              return (
                <th key={i} className={cn('px-1.5 py-2 text-center', (weekend || d.holiday) && 'bg-slate-100/80', d.leaveHours > 0 && 'bg-teal-50/70')}>
                  <div className="font-semibold uppercase tracking-wide text-slate-600">{DAY_SHORT[i]}</div>
                  <div className="text-[11px] font-normal text-slate-400">{formatShort(d.date)}</div>
                  {d.holiday && (
                    <div className="mx-auto mt-1 max-w-[84px] truncate rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800" title={d.holiday.name}>
                      {d.holiday.name}
                    </div>
                  )}
                  {d.leaveHours > 0 && (
                    <div className="mx-auto mt-1 w-fit rounded bg-teal-100 px-1 text-[10px] font-medium text-teal-800">Leave {formatHours(d.leaveHours)}</div>
                  )}
                </th>
              );
            })}
            <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Total</th>
            <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {entries.map((e) => {
            const p = project(e.projectId);
            const alloc = allocations.find((a) => a.projectId === e.projectId);
            const locked = readOnly || isEntryLocked(e.status);
            const isOpen = expanded.has(e.projectId) || invalidDescriptions?.has(e.projectId);
            const total = entryTotal(e);
            const variance = alloc ? total - alloc.weeklyHours : 0;
            return (
              <Fragment key={e.projectId}>
                <tr className={cn(locked && 'bg-slate-50/60')}>
                  <td className="px-4 py-2.5">
                    <button onClick={() => toggle(e.projectId)} className="flex w-full items-start gap-2 text-left" aria-expanded={!!isOpen}>
                      {isOpen ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 font-medium text-slate-800">
                          <ProjectDot color={p?.color ?? '#94a3b8'} />
                          <span className="truncate">{p?.name ?? e.projectId}</span>
                          {locked && <Lock className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-label="Locked" />}
                        </span>
                        <span className={cn('mt-0.5 flex items-center gap-1 text-xs', e.description ? 'text-slate-500' : invalidDescriptions?.has(e.projectId) ? 'text-rose-600' : 'text-slate-400')}>
                          <NotebookPen className="h-3 w-3" />
                          {e.description ? 'Description added' : 'Add work description'}
                          {e.managerComment && <MessageSquare className="ml-1 h-3 w-3 text-violet-500" aria-label="Manager comment" />}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums">
                    {alloc ? (
                      <>
                        <div className="font-medium text-slate-700">{formatHours(alloc.weeklyHours)}</div>
                        <div className="text-[11px] text-slate-400">{percent(alloc.weeklyHours, capacity)}%</div>
                      </>
                    ) : (
                      <span className="text-xs text-slate-400">Not allocated</span>
                    )}
                  </td>
                  {dayIdx.map((i) => {
                    const d = days[i];
                    const weekend = i > 4;
                    const disabled = locked || (weekend && !allowWeekendEntry);
                    const value = e.hours[i] ?? 0;
                    return (
                      <td key={i} className={cn('px-1.5 py-2 text-center', (weekend || d.holiday) && 'bg-slate-50')}>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={24}
                          step={increment}
                          disabled={disabled}
                          aria-label={`${p?.name} ${DAY_SHORT[i]} hours`}
                          value={value === 0 ? '' : value}
                          placeholder="0"
                          onChange={(ev) => setHour(e.projectId, i, ev.target.value)}
                          onBlur={(ev) => setHour(e.projectId, i, ev.target.value, true)}
                          className={cn(
                            'no-spin h-9 w-full min-w-[52px] max-w-[68px] rounded-md border text-center text-sm tabular-nums transition-colors focus:outline-none focus:ring-2',
                            disabled
                              ? 'cursor-not-allowed border-transparent bg-transparent text-slate-600'
                              : 'border-slate-300 bg-white text-slate-800 focus:border-brand-500 focus:ring-brand-500/20',
                            !disabled && value % increment !== 0 && 'border-amber-400',
                          )}
                        />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <div className="font-semibold text-slate-800">{formatHours(total)}</div>
                    {alloc && variance !== 0 && (
                      <div className={cn('text-[11px]', variance > 0 ? 'text-amber-700' : 'text-slate-400')}>
                        {variance > 0 ? '+' : ''}
                        {formatHours(variance)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={e.status} />
                  </td>
                </tr>
                {isOpen && (
                  <tr className="bg-slate-50/60">
                    <td colSpan={colCount} className="px-4 pb-4 pt-1">
                      <div className="ml-6 grid gap-3 lg:grid-cols-[1fr_320px]">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-slate-600">
                            Work description for {p?.name}
                            <span className="ml-0.5 text-rose-500">*</span>
                          </label>
                          <textarea
                            rows={2}
                            disabled={locked}
                            value={e.description}
                            placeholder="Summarise the work completed this week (tickets, deliverables, meetings)…"
                            onChange={(ev) => update(e.projectId, (x) => ({ ...x, description: ev.target.value }))}
                            className={cn(
                              'block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-100 disabled:text-slate-600',
                              invalidDescriptions?.has(e.projectId) && !e.description.trim() ? 'border-rose-400' : 'border-slate-300',
                            )}
                          />
                        </div>
                        {e.managerComment && (
                          <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-800">
                            <p className="flex items-center gap-1.5 text-xs font-semibold">
                              <MessageSquare className="h-3.5 w-3.5" /> Manager comment
                            </p>
                            <p className="mt-1">{e.managerComment}</p>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}

          {hasLeave && (
            <tr className="bg-teal-50/40 text-teal-800">
              <td className="px-4 py-2.5">
                <span className="flex items-center gap-2 pl-6 font-medium">
                  <Plane className="h-3.5 w-3.5" /> Approved leave
                </span>
              </td>
              <td className="px-2 py-2.5 text-right text-xs text-teal-700">Auto</td>
              {dayIdx.map((i) => (
                <td key={i} className="px-1.5 py-2.5 text-center tabular-nums">
                  {leaveRow[i] ? formatHours(leaveRow[i], false) : <span className="text-teal-300">–</span>}
                </td>
              ))}
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{formatHours(sum(leaveRow))}</td>
              <td className="px-3 py-2.5 text-xs">From calendar</td>
            </tr>
          )}
        </tbody>
        <tfoot className="border-t-2 border-slate-200 bg-slate-50 text-sm">
          <tr>
            <td className="px-4 py-2.5 font-semibold text-slate-800">Daily total</td>
            <td className="px-2 py-2.5 text-right font-semibold tabular-nums text-slate-600">{formatHours(totalAllocated)}</td>
            {dayIdx.map((i) => {
              const over = totals[i] > (days[i].working ? dailyThreshold : 0);
              return (
                <td key={i} className="px-1.5 py-2.5 text-center">
                  <span
                    className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold tabular-nums', over ? 'bg-amber-100 text-amber-800' : 'text-slate-800')}
                    title={over ? 'Additional hours — flagged for overtime processing' : undefined}
                  >
                    {over && <AlertTriangle className="h-3 w-3" />}
                    {formatHours(totals[i], false)}
                  </span>
                </td>
              );
            })}
            <td className="px-3 py-2.5 text-right text-base font-semibold tabular-nums text-slate-900">{formatHours(sum(totals))}</td>
            <td />
          </tr>
          <tr className="text-xs text-slate-500">
            <td className="px-4 pb-3">Expected (calendar)</td>
            <td />
            {dayIdx.map((i) => (
              <td key={i} className="px-1.5 pb-3 text-center tabular-nums">
                {formatHours(days[i].expected, false)}
              </td>
            ))}
            <td className="px-3 pb-3 text-right tabular-nums">{formatHours(sum(days.map((d) => d.expected)))}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
