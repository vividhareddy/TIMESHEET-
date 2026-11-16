import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ISODate } from '@/types';
import { addDays, currentWeekStart, formatWeekRange, startOfWeek } from '@/utils/date';
import { Button } from '@/components/common/Button';

export function WeekNavigator({ weekStart, onChange }: { weekStart: ISODate; onChange: (week: ISODate) => void }) {
  const isCurrent = weekStart === currentWeekStart();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center rounded-md border border-slate-300 bg-white">
        <button onClick={() => onChange(addDays(weekStart, -7))} className="flex h-9 w-9 items-center justify-center rounded-l-md text-slate-500 hover:bg-slate-50 hover:text-slate-800" aria-label="Previous week">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <label className="relative flex h-9 cursor-pointer items-center gap-2 border-x border-slate-200 px-3 text-sm font-medium text-slate-800">
          <CalendarDays className="h-4 w-4 text-slate-400" />
          <span className="whitespace-nowrap">{formatWeekRange(weekStart)}</span>
          <input
            type="date"
            aria-label="Pick a week"
            className="absolute inset-0 cursor-pointer opacity-0"
            value={weekStart}
            onChange={(e) => e.target.value && onChange(startOfWeek(e.target.value))}
          />
        </label>
        <button onClick={() => onChange(addDays(weekStart, 7))} className="flex h-9 w-9 items-center justify-center rounded-r-md text-slate-500 hover:bg-slate-50 hover:text-slate-800" aria-label="Next week">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      {!isCurrent && (
        <Button variant="ghost" size="sm" onClick={() => onChange(currentWeekStart())}>
          This week
        </Button>
      )}
    </div>
  );
}
