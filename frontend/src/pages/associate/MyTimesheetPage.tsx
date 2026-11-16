import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Copy, Info, Lock, RotateCcw, Save, Send, Undo2, XCircle } from 'lucide-react';
import type { ISODate, TimesheetEntry } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useToast } from '@/context/ToastContext';
import { useCurrentUser, useLookups } from '@/hooks/useLookups';
import { addDays, currentWeekStart, formatDateTime, formatWeekRange, startOfWeek } from '@/utils/date';
import { formatHours, sum } from '@/utils/format';
import {
  allocationsForWeek,
  computeOvertime,
  dailyTotals,
  deriveTimesheetStatus,
  isEntryLocked,
  weekExpectations,
} from '@/utils/timesheet';
import { PageHeader, Alert } from '@/components/common/Misc';
import { Card, CardHeader, CardBody } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { StatusBadge } from '@/components/common/Badge';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Toggle } from '@/components/forms/FormControls';
import { TimesheetGrid } from '@/components/timesheet/TimesheetGrid';
import { WeekNavigator } from '@/components/timesheet/WeekNavigator';
import { ApprovalHistory } from '@/components/timesheet/ApprovalHistory';

function sameEntries(a: TimesheetEntry[], b: TimesheetEntry[]) {
  return JSON.stringify(a.map((e) => [e.projectId, e.hours, e.description])) === JSON.stringify(b.map((e) => [e.projectId, e.hours, e.description]));
}

export function MyTimesheetPage() {
  const user = useCurrentUser();
  const { timesheets, allocations, leaves, settings, policy, saveTimesheet } = useAppData();
  const { calendarOf, projectName } = useLookups();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const weekStart: ISODate = params.get('week') ? startOfWeek(params.get('week')!) : currentWeekStart();
  const setWeek = (w: ISODate) => setParams(w === currentWeekStart() ? {} : { week: w });

  const calendar = calendarOf(user);
  const timesheet = timesheets.find((t) => t.employeeId === user.id && t.weekStart === weekStart);
  const weekAllocs = useMemo(() => allocationsForWeek(allocations, user.id, weekStart), [allocations, user.id, weekStart]);
  const days = useMemo(() => weekExpectations(user, calendar, leaves, weekStart), [user, calendar, leaves, weekStart]);
  const expected = sum(days.map((d) => d.expected));

  /** Rows = saved entries + any allocated project not yet on the sheet. */
  const baseline = useMemo<TimesheetEntry[]>(() => {
    const saved = timesheet?.entries ?? [];
    const missing = weekAllocs
      .filter((a) => !saved.some((e) => e.projectId === a.projectId))
      .map<TimesheetEntry>((a) => ({ projectId: a.projectId, hours: Array(7).fill(0), description: '', status: 'draft' }));
    return [...saved, ...missing];
  }, [timesheet, weekAllocs]);

  const [entries, setEntries] = useState<TimesheetEntry[]>(baseline);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [showWeekendToggle, setShowWeekend] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);

  useEffect(() => {
    setEntries(baseline);
    setInvalid(new Set());
  }, [baseline]);

  const status = deriveTimesheetStatus(timesheet);
  const dirty = !sameEntries(entries, baseline);
  const totals = dailyTotals(entries);
  const total = sum(totals);
  const editable = entries.filter((e) => !isEntryLocked(e.status));
  const allLocked = entries.length > 0 && editable.length === 0;
  const isFuture = weekStart > currentWeekStart();
  const overtime = computeOvertime(entries, weekStart, calendar, policy);
  const hasWeekendHours = entries.some((e) => (e.hours[5] ?? 0) + (e.hours[6] ?? 0) > 0);
  const showWeekend = showWeekendToggle || hasWeekendHours;
  const allocated = sum(weekAllocs.map((a) => a.weeklyHours));
  const flagged = entries.filter((e) => e.managerComment && (e.status === 'returned' || e.status === 'rejected'));
  const previous = timesheets.find((t) => t.employeeId === user.id && t.weekStart === addDays(weekStart, -7));

  const validate = (): boolean => {
    if (total <= 0) {
      toast.warning('No hours entered', 'Enter your project hours before submitting.');
      return false;
    }
    if (totals.some((t) => t > 24)) {
      toast.error('Invalid daily total', 'A day cannot exceed 24 hours.');
      return false;
    }
    if (settings.requireDescription) {
      const missing = editable.filter((e) => sum(e.hours) > 0 && !e.description.trim()).map((e) => e.projectId);
      if (missing.length) {
        setInvalid(new Set(missing));
        toast.warning('Work description required', `Add a description for ${missing.map((m) => projectName(m)).join(', ')}.`);
        return false;
      }
    }
    return true;
  };

  const persist = async (submit: boolean) => {
    setBusy(submit ? 'submit' : 'save');
    try {
      await saveTimesheet(weekStart, entries, submit);
      setConfirm(false);
      toast.success(
        submit ? 'Timesheet submitted' : 'Draft saved',
        submit ? 'Each project manager has been notified to review their entries.' : `Week of ${formatWeekRange(weekStart)}.`,
      );
    } catch (err) {
      toast.error('Could not save timesheet', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const copyPrevious = () => {
    if (!previous) return;
    setEntries((rows) =>
      rows.map((r) => {
        if (isEntryLocked(r.status)) return r;
        const prev = previous.entries.find((p) => p.projectId === r.projectId);
        if (!prev) return r;
        // Do not copy hours into holidays / non-working days.
        const hours = prev.hours.map((h, i) => (days[i].working ? h : 0));
        return { ...r, hours, description: r.description || prev.description };
      }),
    );
    toast.info('Copied previous week', 'Review the hours and descriptions before saving.');
  };

  return (
    <div>
      <PageHeader
        title="My Timesheet"
        description="Record actual hours worked on each allocated project. Use 0.5-hour increments."
        actions={<WeekNavigator weekStart={weekStart} onChange={setWeek} />}
      />

      {/* Status banner */}
      <div className="mb-5 space-y-3">
        {(status === 'returned' || status === 'rejected') && (
          <Alert tone={status === 'returned' ? 'violet' : 'danger'} icon={status === 'returned' ? Undo2 : XCircle} title={status === 'returned' ? 'Returned for correction' : 'Entries rejected'}>
            <ul className="mt-1 space-y-1">
              {flagged.map((e) => (
                <li key={e.projectId}>
                  <span className="font-medium">{projectName(e.projectId)}:</span> {e.managerComment}
                </li>
              ))}
            </ul>
            <p className="mt-1">Unlocked entries can be corrected and resubmitted. Approved entries stay locked.</p>
          </Alert>
        )}
        {(status === 'submitted' || status === 'partially_approved') && (
          <Alert tone="info" icon={Lock} title={status === 'submitted' ? 'Submitted — awaiting approval' : 'Partially approved'}>
            Submitted on {timesheet?.submittedAt ? formatDateTime(timesheet.submittedAt) : '—'}. Entries are locked until they are approved, returned or reopened.
          </Alert>
        )}
        {status === 'approved' && (
          <Alert tone="success" icon={CheckCircle2} title="Timesheet approved">
            All project entries for this week have been approved.
          </Alert>
        )}
        {!calendar && (
          <Alert tone="warning" icon={Info} title="No holiday calendar assigned">
            Expected hours use a Monday–Friday schedule without holidays until an administrator assigns your calendar.
          </Alert>
        )}
        {weekAllocs.length === 0 && (
          <Alert tone="warning" icon={Info} title="No project allocations for this week">
            You have no active allocations between {formatWeekRange(weekStart)}. Contact your resource manager if this is incorrect.
          </Alert>
        )}
      </div>

      {/* Summary */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          { label: 'Status', value: <StatusBadge status={status} /> },
          { label: 'Weekly target', value: formatHours(user.weeklyCapacity) },
          { label: 'Expected (after holidays / leave)', value: formatHours(expected) },
          { label: 'Allocated', value: formatHours(allocated) },
          { label: 'Entered', value: formatHours(total), tone: total > expected ? 'text-amber-700' : 'text-slate-900' },
          {
            label: total > expected ? 'Additional hours' : 'Remaining',
            value: total > expected ? `+${formatHours(total - expected)}` : formatHours(Math.max(0, expected - total)),
            tone: total > expected ? 'text-amber-700' : 'text-slate-900',
          },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-card">
            <p className="truncate text-xs text-slate-500" title={s.label}>{s.label}</p>
            <div className={`mt-1 text-lg font-semibold tabular-nums ${s.tone ?? 'text-slate-900'}`}>{s.value}</div>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader
          title={`Week of ${formatWeekRange(weekStart)}`}
          description={`${calendar?.name ?? 'Calendar'} · ${settings.defaultHoursPerDay}h working day · Submission deadline ${settings.submissionDeadline}`}
          actions={
            <div className="flex flex-wrap items-center gap-3">
              <div className="w-48">
                <Toggle checked={showWeekend} onChange={setShowWeekend} label="Show weekend" disabled={hasWeekendHours} />
              </div>
              <Button variant="secondary" size="sm" icon={Copy} onClick={copyPrevious} disabled={!previous || allLocked}>
                Copy previous week
              </Button>
            </div>
          }
        />
        {entries.length > 0 ? (
          <TimesheetGrid
            entries={entries}
            onChange={setEntries}
            days={days}
            allocations={weekAllocs}
            capacity={user.weeklyCapacity}
            showWeekend={showWeekend}
            allowWeekendEntry={settings.allowWeekendEntry}
            dailyThreshold={policy.dailyThreshold}
            increment={settings.hourIncrement}
            invalidDescriptions={invalid}
          />
        ) : (
          <CardBody>
            <p className="text-sm text-slate-500">There are no projects to record time against for this week.</p>
          </CardBody>
        )}

        {overtime.total > 0 && (
          <div className="border-t border-slate-200 px-5 py-3">
            <Alert tone="warning" title={`${formatHours(overtime.total)} additional hours will be flagged for overtime processing`}>
              Hours above {policy.dailyThreshold}h per day{policy.weekendApplicable ? ', weekend' : ''}
              {policy.holidayApplicable ? ' and holiday' : ''} hours are sent to the project manager for overtime approval when you submit.
            </Alert>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/60 px-5 py-3">
          <p className="text-xs text-slate-500">
            {dirty ? (
              <span className="font-medium text-amber-700">You have unsaved changes.</span>
            ) : timesheet ? (
              `Last updated ${formatDateTime(timesheet.updatedAt)}`
            ) : (
              'Not saved yet.'
            )}
            {isFuture && ' · Future weeks can be saved as draft only.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" icon={RotateCcw} onClick={() => setEntries(baseline)} disabled={!dirty || !!busy}>
              Discard changes
            </Button>
            <Button variant="secondary" icon={Save} onClick={() => persist(false)} loading={busy === 'save'} disabled={allLocked || !!busy || entries.length === 0}>
              Save Draft
            </Button>
            <Button icon={Send} onClick={() => validate() && setConfirm(true)} disabled={allLocked || isFuture || !!busy || entries.length === 0}>
              {status === 'returned' || status === 'rejected' ? 'Resubmit' : 'Submit Timesheet'}
            </Button>
          </div>
        </div>
      </Card>

      {timesheet && timesheet.history.length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Approval history & comments" description="Every submission, review and change made to this week's timesheet." />
          <CardBody>
            <ApprovalHistory events={timesheet.history} />
          </CardBody>
        </Card>
      )}

      <ConfirmDialog
        open={confirm}
        title="Submit timesheet?"
        confirmLabel="Submit"
        busy={busy === 'submit'}
        onCancel={() => setConfirm(false)}
        onConfirm={() => persist(true)}
        message={
          <div className="space-y-3">
            <p>
              You are submitting <span className="font-semibold text-slate-800">{formatHours(total)}</span> for the week of {formatWeekRange(weekStart)} across{' '}
              {editable.filter((e) => sum(e.hours) > 0).length} project(s). Each project's hours go to its project manager for approval.
            </p>
            {total < expected && (
              <Alert tone="warning">
                Entered hours are {formatHours(expected - total)} below your expected {formatHours(expected)} for this week.
              </Alert>
            )}
            {overtime.total > 0 && <Alert tone="warning">{formatHours(overtime.total)} will be flagged as additional (overtime) hours.</Alert>}
            <p className="text-xs text-slate-500">Submitted entries are locked until they are approved, returned or reopened.</p>
          </div>
        }
      />
    </div>
  );
}
