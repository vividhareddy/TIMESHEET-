import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Hourglass, MessageCircleQuestion, Send, Timer, Info } from 'lucide-react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { overtimeService } from '@/services';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useLookups } from '@/hooks/useLookups';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { addDays, startOfWeek, todayISO, isWeekend } from '@/utils/date';
import { formatHours, sum } from '@/utils/format';
import { allocationsForWeek, findHoliday } from '@/utils/timesheet';
import { PageHeader, Alert } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { StatCard } from '@/components/common/StatCard';
import { Field, Input, Select, Textarea } from '@/components/forms/FormControls';
import { OvertimeTable } from '@/components/tables/OvertimeTable';

export function MyOvertimePage() {
  const user = useCurrentUser();
  const { overtime, allocations, policy, requestOvertime } = useAppData();
  const { project, calendarOf } = useLookups();
  const { busy, run } = useAsyncAction();
  const mine = overtime.filter((o) => o.employeeId === user.id);
  const [date, setDate] = useState(addDays(todayISO(), 1));
  const allocs = allocationsForWeek(allocations, user.id, startOfWeek(date));
  const [projectId, setProjectId] = useState(allocs[0]?.projectId ?? '');
  const [hours, setHours] = useState(2);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const cal = calendarOf(user);
  const holiday = findHoliday(cal, date);
  // Re-check when the policy changes (eligibility is decided by the server).
  const eligibility = useApiQuery(() => overtimeService.eligibility(), [policy]);
  const ineligible = eligibility.data?.eligible === false;

  const errors = {
    project: !allocs.some((a) => a.projectId === projectId) ? 'Select a project you are allocated to in that week.' : undefined,
    hours: !(hours >= 0.5 && hours <= policy.maxWeeklyOvertime) ? `Enter between 0.5 and ${policy.maxWeeklyOvertime} hours.` : (hours * 2) % 1 !== 0 ? 'Use 0.5-hour increments.' : undefined,
    reason: !reason.trim() ? 'A business reason is required.' : undefined,
  };

  const submit = async () => {
    setTouched(true);
    if (Object.values(errors).some(Boolean)) return;
    const ok = await run(() => requestOvertime({ projectId, date, hours, reason: reason.trim() }), {
      title: 'Overtime request submitted',
      message: `Sent to ${project(projectId)?.name}'s project manager.`,
    });
    if (ok) {
      setReason('');
      setTouched(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Overtime"
        description="Additional hours flagged from your timesheets, and pre-approval requests for planned extra work."
        actions={<Link to="/associate/ot-assistant"><Button variant="secondary" icon={MessageCircleQuestion}>Ask the OT assistant</Button></Link>}
      />

      {eligibility.data && (
        <Alert tone={eligibility.data.eligible ? 'success' : 'warning'} className="mb-5" title={eligibility.data.eligible ? 'You are eligible for overtime' : 'You are not eligible for overtime'}>
          {eligibility.data.reason}
          {!eligibility.data.eligible && ' Extra hours you record are treated as ordinary hours. Contact your administrator if this seems wrong.'}
        </Alert>
      )}

      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Total records" value={mine.length} icon={Timer} />
        <StatCard label="Approved hours" value={formatHours(sum(mine.filter((o) => o.status === 'approved').map((o) => o.hours)))} icon={CheckCircle2} tone="green" />
        <StatCard label="Pending hours" value={formatHours(sum(mine.filter((o) => o.status === 'pending').map((o) => o.hours)))} icon={Hourglass} tone="amber" />
        <StatCard label="Daily threshold" value={formatHours(policy.dailyThreshold)} icon={Info} tone="slate" hint={`Weekly ${formatHours(policy.weeklyThreshold)}`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[380px_1fr]">
        <Card className="h-fit">
          <CardHeader title="Request pre-approval" description="For planned additional work, e.g. a weekend release." />
          <CardBody className="space-y-4">
            <Field label="Date" required hint={holiday ? `${holiday.name} — holiday` : isWeekend(date) ? 'Weekend day' : undefined}>
              <Input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  const next = allocationsForWeek(allocations, user.id, startOfWeek(e.target.value));
                  if (!next.some((a) => a.projectId === projectId)) setProjectId(next[0]?.projectId ?? '');
                }}
              />
            </Field>
            <Field label="Project" required error={touched ? errors.project : undefined}>
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {allocs.length === 0 && <option value="">No allocations this week</option>}
                {allocs.map((a) => <option key={a.projectId} value={a.projectId}>{project(a.projectId)?.name}</option>)}
              </Select>
            </Field>
            <Field label="Additional hours" required error={touched ? errors.hours : undefined}>
              <Input type="number" min={0.5} step={0.5} max={policy.maxWeeklyOvertime} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
            </Field>
            <Field label="Business reason" required error={touched ? errors.reason : undefined}>
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Production deployment window agreed with the client" />
            </Field>
            {policy.requirePreApproval ? (
              <Alert tone="warning">Your organisation requires pre-approval before working additional hours.</Alert>
            ) : (
              <Alert tone="info">Hours above {formatHours(policy.dailyThreshold)}/day{policy.weekendApplicable ? ' and weekend hours' : ''} are also flagged automatically when you submit your timesheet.</Alert>
            )}
            <Button icon={Send} className="w-full" loading={busy} onClick={submit} disabled={ineligible || !policy.enabled}>Submit request</Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="My overtime" />
          <OvertimeTable records={mine} showEmployee={false} emptyTitle="No overtime recorded" />
        </Card>
      </div>
    </div>
  );
}
