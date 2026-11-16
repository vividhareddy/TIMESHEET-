import { useMemo, useState } from 'react';
import { useAppData } from '@/context/AppDataContext';
import { useLookups } from '@/hooks/useLookups';
import { useTeam } from '@/hooks/useTeam';
import { formatHours } from '@/utils/format';
import { PageHeader } from '@/components/common/Misc';
import { Card, CardHeader } from '@/components/common/Card';
import { FilterSelect } from '@/components/forms/FormControls';
import { CalendarView, type CalendarEvent } from '@/components/calendar/CalendarView';
import { LeaveRequestTable } from '@/components/tables/LeaveRequestTable';

export function TeamCalendarPage() {
  const { team, directReportIds } = useTeam();
  const { calendars, leaves } = useAppData();
  const { employeeName } = useLookups();
  const [calFilter, setCalFilter] = useState('all');

  const teamIds = useMemo(() => new Set(team.map((t) => t.id)), [team]);
  const teamCalendars = calendars.filter((c) => team.some((t) => t.calendarId === c.id));
  const shownCals = calFilter === 'all' ? teamCalendars : teamCalendars.filter((c) => c.id === calFilter);

  const events = useMemo<CalendarEvent[]>(
    () => [
      ...shownCals.flatMap((c) =>
        c.holidays.map<CalendarEvent>((h) => ({ id: `${c.id}-${h.id}`, date: h.date, label: `${c.country} · ${h.name}`, tone: h.type === 'public' ? 'holiday' : 'company', detail: `${c.name} — ${h.type} holiday` })),
      ),
      ...leaves
        .filter((l) => teamIds.has(l.employeeId) && l.status !== 'rejected')
        .filter((l) => calFilter === 'all' || team.find((t) => t.id === l.employeeId)?.calendarId === calFilter)
        .map<CalendarEvent>((l) => ({
          id: l.id,
          date: l.date,
          label: `${employeeName(l.employeeId)} · ${l.duration === 'full' ? 'Leave' : '½ day'}`,
          tone: l.status === 'approved' ? 'leave' : 'leave-pending',
          detail: `${formatHours(l.hours)} — ${l.reason}`,
        })),
    ],
    [shownCals, leaves, teamIds, calFilter, team, employeeName],
  );

  const reportLeaves = leaves.filter((l) => directReportIds.has(l.employeeId));

  return (
    <div>
      <PageHeader
        title="Team Calendar"
        description="Holidays and leave across your team's holiday calendars."
        actions={<FilterSelect label="Calendar" value={calFilter} onChange={setCalFilter} options={[{ value: 'all', label: 'All team calendars' }, ...teamCalendars.map((c) => ({ value: c.id, label: c.name }))]} />}
      />
      <Card className="mb-5">
        <CalendarView events={events} />
      </Card>
      <Card>
        <CardHeader title="Leave requests from your direct reports" description="Approve or reject leave. Approved leave reduces the employee's expected hours for that week." />
        <LeaveRequestTable leaves={reportLeaves} emptyTitle="No leave requests from your direct reports" />
      </Card>
    </div>
  );
}
