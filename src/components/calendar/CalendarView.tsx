import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ISODate } from '@/types';
import { addDays, DAY_SHORT, DAY_LONG, formatShort, monthMatrix, MONTHS, parseISO, startOfWeek, todayISO, toISO, weekDates, weekday, formatWeekRange } from '@/utils/date';
import { cn } from '@/utils/format';
import { Segmented } from '@/components/common/Misc';
import { Button } from '@/components/common/Button';

export type CalendarEventTone = 'holiday' | 'company' | 'leave' | 'leave-pending' | 'overtime' | 'info';

export interface CalendarEvent {
  id: string;
  date: ISODate;
  label: string;
  tone: CalendarEventTone;
  detail?: string;
}

const toneClass: Record<CalendarEventTone, string> = {
  holiday: 'bg-amber-100 text-amber-900 border-amber-200',
  company: 'bg-orange-50 text-orange-800 border-orange-200',
  leave: 'bg-teal-100 text-teal-900 border-teal-200',
  'leave-pending': 'bg-white text-teal-800 border-teal-300 border-dashed',
  overtime: 'bg-violet-50 text-violet-800 border-violet-200',
  info: 'bg-brand-50 text-brand-700 border-brand-200',
};

const LEGEND: Array<{ tone: CalendarEventTone; label: string }> = [
  { tone: 'holiday', label: 'Public holiday' },
  { tone: 'company', label: 'Company holiday' },
  { tone: 'leave', label: 'Approved leave' },
  { tone: 'leave-pending', label: 'Pending leave' },
];

interface CalendarViewProps {
  events: CalendarEvent[];
  /** JS weekdays (0=Sun) that are working days. */
  workingDays?: number[];
  title?: string;
  onDayClick?: (date: ISODate) => void;
  legend?: Array<{ tone: CalendarEventTone; label: string }>;
}

export function CalendarView({ events, workingDays = [1, 2, 3, 4, 5], onDayClick, legend = LEGEND }: CalendarViewProps) {
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [cursor, setCursor] = useState<ISODate>(todayISO());
  const today = todayISO();
  const c = parseISO(cursor);
  const byDate = (d: ISODate) => events.filter((e) => e.date === d);

  const move = (dir: -1 | 1) => {
    if (mode === 'week') setCursor(addDays(cursor, 7 * dir));
    else setCursor(toISO(new Date(c.getFullYear(), c.getMonth() + dir, 1)));
  };

  const title = mode === 'month' ? `${MONTHS[c.getMonth()]} ${c.getFullYear()}` : formatWeekRange(startOfWeek(cursor));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border border-slate-300">
            <button onClick={() => move(-1)} className="flex h-8 w-8 items-center justify-center text-slate-500 hover:bg-slate-50" aria-label="Previous">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={() => move(1)} className="flex h-8 w-8 items-center justify-center border-l border-slate-200 text-slate-500 hover:bg-slate-50" aria-label="Next">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <h3 className="min-w-[150px] text-sm font-semibold text-slate-800">{title}</h3>
          <Button variant="ghost" size="sm" onClick={() => setCursor(today)}>Today</Button>
        </div>
        <Segmented value={mode} onChange={setMode} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]} />
      </div>

      {mode === 'month' ? (
        <div className="p-3">
          <div className="grid grid-cols-7 gap-px text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {DAY_SHORT.map((d) => (
              <div key={d} className="py-2">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200">
            {monthMatrix(c.getFullYear(), c.getMonth()).map((date) => {
              const inMonth = parseISO(date).getMonth() === c.getMonth();
              const nonWorking = !workingDays.includes(weekday(date));
              const dayEvents = byDate(date);
              return (
                <button
                  key={date}
                  type="button"
                  onClick={() => onDayClick?.(date)}
                  className={cn(
                    'flex min-h-[92px] flex-col p-1.5 text-left transition-colors',
                    inMonth ? (nonWorking ? 'bg-slate-50' : 'bg-white') : 'bg-slate-50/70 text-slate-400',
                    onDayClick ? 'hover:bg-brand-50/40' : 'cursor-default',
                  )}
                >
                  <span
                    className={cn(
                      'mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums',
                      date === today ? 'bg-brand-600 font-semibold text-white' : inMonth ? 'text-slate-700' : 'text-slate-400',
                    )}
                  >
                    {parseISO(date).getDate()}
                  </span>
                  <div className="w-full space-y-0.5">
                    {dayEvents.slice(0, 3).map((e) => (
                      <div key={e.id} title={e.detail ?? e.label} className={cn('truncate rounded border px-1 py-px text-[10px] font-medium leading-tight', toneClass[e.tone], !inMonth && 'opacity-60')}>
                        {e.label}
                      </div>
                    ))}
                    {dayEvents.length > 3 && <div className="px-1 text-[10px] text-slate-500">+{dayEvents.length - 3} more</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="grid gap-px bg-slate-200 sm:grid-cols-7">
          {weekDates(startOfWeek(cursor)).map((date, i) => {
            const nonWorking = !workingDays.includes(weekday(date));
            const dayEvents = byDate(date);
            const isHoliday = dayEvents.some((e) => e.tone === 'holiday' || e.tone === 'company');
            return (
              <div key={date} className={cn('min-h-[220px] p-3', nonWorking ? 'bg-slate-50' : 'bg-white')}>
                <p className={cn('text-xs font-semibold uppercase tracking-wide', date === today ? 'text-brand-600' : 'text-slate-500')}>{DAY_LONG[i]}</p>
                <p className="text-lg font-semibold text-slate-900">{formatShort(date)}</p>
                <p className={cn('mt-0.5 text-[11px]', nonWorking || isHoliday ? 'text-slate-400' : 'text-emerald-700')}>
                  {nonWorking ? 'Non-working day' : isHoliday ? 'Holiday' : 'Working day'}
                </p>
                <div className="mt-3 space-y-1.5">
                  {dayEvents.map((e) => (
                    <div key={e.id} className={cn('rounded border px-2 py-1.5 text-xs', toneClass[e.tone])}>
                      <p className="font-medium">{e.label}</p>
                      {e.detail && <p className="mt-0.5 opacity-80">{e.detail}</p>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-4 border-t border-slate-200 px-4 py-3 text-xs text-slate-600">
        {legend.map((l) => (
          <span key={l.tone} className="flex items-center gap-1.5">
            <span className={cn('h-3 w-3 rounded border', toneClass[l.tone])} /> {l.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border border-slate-200 bg-slate-50" /> Non-working day
        </span>
      </div>
    </div>
  );
}
