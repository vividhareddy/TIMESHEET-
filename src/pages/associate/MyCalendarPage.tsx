import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plane } from 'lucide-react';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups } from '@/hooks/useLookups';
import { formatDate, todayISO } from '@/utils/date';
import { formatHours } from '@/utils/format';
import { dailyTarget } from '@/utils/timesheet';
import { PageHeader, InfoRow } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { Badge, StatusBadge } from '@/components/common/Badge';
import { CalendarView, type CalendarEvent } from '@/components/calendar/CalendarView';

export function MyCalendarPage() {
  const user = useCurrentUser();
  const { leaves } = useAppData();
  const { calendarOf } = useLookups();
  const navigate = useNavigate();
  const cal = calendarOf(user);
  const myLeaves = leaves.filter((l) => l.employeeId === user.id);

  const events = useMemo<CalendarEvent[]>(
    () => [
      ...(cal?.holidays ?? []).map<CalendarEvent>((h) => ({ id: h.id, date: h.date, label: h.name, tone: h.type === 'public' ? 'holiday' : 'company', detail: h.type === 'public' ? 'Public holiday' : 'Company holiday' })),
      ...myLeaves
        .filter((l) => l.status !== 'rejected')
        .map<CalendarEvent>((l) => ({
          id: l.id,
          date: l.date,
          label: `${l.duration === 'full' ? 'Leave' : 'Half-day leave'} (${formatHours(l.hours)})`,
          tone: l.status === 'approved' ? 'leave' : 'leave-pending',
          detail: `${l.status === 'approved' ? 'Approved' : 'Pending'} — ${l.reason}`,
        })),
    ],
    [cal, myLeaves],
  );

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const upcoming = (cal?.holidays ?? []).filter((h) => h.date >= todayISO()).slice(0, 6);

  return (
    <div>
      <PageHeader
        title="My Calendar"
        description={cal ? `Showing ${cal.name}, assigned for your work location${user.workLocation ? ` (${user.workLocation})` : ''}.` : 'No holiday calendar has been assigned to you yet.'}
        actions={<Button icon={Plane} onClick={() => navigate('/associate/leave')}>Request leave</Button>}
      />
      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <Card>
          <CalendarView events={events} workingDays={cal?.workingDays} />
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="My schedule" />
            <CardBody className="divide-y divide-slate-100 py-1">
              <InfoRow label="Calendar">{cal ? <Badge tone="blue">{cal.name}</Badge> : '—'}</InfoRow>
              <InfoRow label="Working days">{cal?.workingDays.map((d) => days[d]).join(', ')}</InfoRow>
              <InfoRow label="Daily hours">{formatHours(dailyTarget(user, cal))}</InfoRow>
              <InfoRow label="Weekly target">{formatHours(user.weeklyCapacity)}</InfoRow>
              <InfoRow label="Time zone">{cal?.timezone}</InfoRow>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Upcoming holidays" />
            <ul className="divide-y divide-slate-100">
              {upcoming.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-800">{h.name}</span>
                    <span className="text-xs text-slate-500">{formatDate(h.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  </span>
                  <Badge tone={h.type === 'public' ? 'amber' : 'slate'}>{h.type === 'public' ? 'Public' : 'Company'}</Badge>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="My leave" />
            <ul className="divide-y divide-slate-100">
              {myLeaves.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5).map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                  <span>
                    <span className="block font-medium text-slate-800">{formatDate(l.date)}</span>
                    <span className="text-xs text-slate-500">{l.duration === 'full' ? 'Full day' : 'Half day'} · {formatHours(l.hours)}</span>
                  </span>
                  <StatusBadge status={l.status} />
                </li>
              ))}
              {myLeaves.length === 0 && <li className="px-5 py-4 text-sm text-slate-500">No leave requests.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
