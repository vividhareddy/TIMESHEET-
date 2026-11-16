import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import type { CountryCode, Employee, Holiday, HolidayType, ISODate, WorkCalendar } from '@/types';
import type { CalendarInput, HolidayInput } from '@/types/api';
import { useAppData } from '@/context/AppDataContext';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { useLookups, useReferenceData } from '@/hooks/useLookups';
import { useTableState } from '@/hooks/useTableState';
import { ApiError } from '@/services';
import { formatDate, isWeekend, todayISO } from '@/utils/date';
import { cn } from '@/utils/format';
import { PageHeader, PersonCell, Tabs, EmptyState, Alert } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button, IconButton } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Field, FilterSelect, Input, Select, SearchInput } from '@/components/forms/FormControls';
import { CalendarView, type CalendarEvent } from '@/components/calendar/CalendarView';
import { DataTable, TableToolbar, type Column } from '@/components/tables/DataTable';

const WEEKDAYS = [
  { d: 1, l: 'Mon' }, { d: 2, l: 'Tue' }, { d: 3, l: 'Wed' }, { d: 4, l: 'Thu' }, { d: 5, l: 'Fri' }, { d: 6, l: 'Sat' }, { d: 0, l: 'Sun' },
];

/** IANA time zones supported by the browser (not business data). */
function timeZones(current: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const list = intl.supportedValuesOf?.('timeZone') ?? [Intl.DateTimeFormat().resolvedOptions().timeZone];
  return list.includes(current) || !current ? list : [current, ...list];
}

export function CalendarsPage() {
  const { calendars, leaves, employees, settings, updateCalendar, saveHoliday, deleteHoliday, saveEmployee } = useAppData();
  const { employeeName } = useLookups();
  const ref = useReferenceData();
  const { busy, run } = useAsyncAction();
  const [calId, setCalId] = useState<string>('');
  const cal = calendars.find((c) => c.id === calId) ?? calendars[0];
  const [creating, setCreating] = useState(false);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [editingHoliday, setEditingHoliday] = useState<Holiday | null | undefined>(undefined);
  const [presetDate, setPresetDate] = useState<ISODate | undefined>();
  const [deleting, setDeleting] = useState<Holiday | null>(null);
  const [schedule, setSchedule] = useState<CalendarInput | null>(null);

  useEffect(() => {
    if (cal) setSchedule({ name: cal.name, country: cal.country, workingDays: cal.workingDays, hoursPerDay: cal.hoursPerDay, timezone: cal.timezone });
  }, [cal]);

  const members = useMemo(() => (cal ? employees.filter((e) => e.calendarId === cal.id && e.status === 'active') : []), [employees, cal]);

  const events = useMemo<CalendarEvent[]>(
    () =>
      cal
        ? [
            ...cal.holidays.map<CalendarEvent>((h) => ({ id: h.id, date: h.date, label: h.name, tone: h.type === 'public' ? 'holiday' : 'company', detail: ref.label(ref.holidayTypes, h.type) })),
            ...leaves
              .filter((l) => l.status !== 'rejected' && members.some((m) => m.id === l.employeeId))
              .map<CalendarEvent>((l) => ({
                id: l.id,
                date: l.date,
                label: `${employeeName(l.employeeId).split(' ')[0]} · ${l.duration === 'full' ? 'Leave' : 'Half day'}`,
                tone: l.status === 'approved' ? 'leave' : 'leave-pending',
                detail: `${employeeName(l.employeeId)} — ${l.reason}`,
              })),
          ]
        : [],
    [cal, leaves, members, employeeName, ref],
  );

  const assignTable = useTableState(employees.filter((e) => e.status === 'active'), {
    searchText: (e) => `${e.name} ${e.workLocation}`,
    accessors: { name: (e) => e.name, location: (e) => e.workLocation },
    initialSort: { key: 'name', direction: 'asc' },
  });

  const assign = (e: Employee, calendarId: string) => {
    const { id, ...input } = e;
    return run(() => saveEmployee({ ...input, calendarId }, id), {
      title: 'Calendar assigned',
      message: `${e.name} → ${calendars.find((c) => c.id === calendarId)?.name ?? 'Not assigned'}`,
    });
  };

  const assignCols: Column<Employee>[] = [
    { key: 'name', header: 'Employee', sortable: true, render: (e) => <PersonCell name={e.name} sub={e.designation} /> },
    {
      key: 'location',
      header: 'Work location',
      sortable: true,
      render: (e) => (e.workLocation ? <span>{e.workLocation} <Badge className="ml-1">{ref.label(ref.countries, e.country)}</Badge></span> : <span className="text-slate-400">—</span>),
    },
    {
      key: 'calendar',
      header: 'Assigned calendar',
      render: (e) => {
        const assigned = calendars.find((c) => c.id === e.calendarId);
        return (
          <div className="flex items-center gap-2">
            <select
              aria-label={`Calendar for ${e.name}`}
              value={e.calendarId}
              onChange={(ev) => assign(e, ev.target.value)}
              className="h-8 rounded-md border border-slate-300 bg-white px-2 pr-7 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            >
              <option value="">— Not assigned —</option>
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {!assigned && <Badge tone="amber">No calendar</Badge>}
            {assigned && e.country && assigned.country !== e.country && <Badge tone="amber">Differs from location</Badge>}
          </div>
        );
      },
    },
  ];

  const header = (
    <PageHeader
      title="Calendars"
      description="Holiday calendars, working schedules and employee calendar assignment."
      actions={<Button icon={CalendarPlus} onClick={() => setCreating(true)}>New calendar</Button>}
    />
  );

  const createModal = <CalendarFormModal open={creating} onClose={() => setCreating(false)} onCreated={(c) => setCalId(c.id)} defaultHoursPerDay={settings.defaultHoursPerDay} />;

  if (!cal || !schedule) {
    return (
      <div>
        {header}
        <Card>
          <EmptyState
            icon={CalendarPlus}
            title="No holiday calendars yet"
            description="Create a calendar for each country or office (for example a US calendar and an India calendar), then add its public and company holidays."
            action={<Button icon={CalendarPlus} onClick={() => setCreating(true)}>Create calendar</Button>}
          />
        </Card>
        {createModal}
      </div>
    );
  }

  const years = [...new Set([String(new Date().getFullYear()), ...cal.holidays.map((h) => h.date.slice(0, 4))])].sort();
  const holidays = cal.holidays.filter((h) => year === 'all' || h.date.startsWith(year));
  const scheduleDirty = JSON.stringify(schedule) !== JSON.stringify({ name: cal.name, country: cal.country, workingDays: cal.workingDays, hoursPerDay: cal.hoursPerDay, timezone: cal.timezone });

  return (
    <div>
      {header}
      <Tabs
        value={cal.id}
        onChange={setCalId}
        options={calendars.map((c) => ({ value: c.id, label: c.name, count: employees.filter((e) => e.calendarId === c.id && e.status === 'active').length }))}
      />

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Card>
          <CalendarView
            events={events}
            workingDays={cal.workingDays}
            onDayClick={(d) => {
              setPresetDate(d);
              setEditingHoliday(cal.holidays.find((h) => h.date === d) ?? null);
            }}
          />
          <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">Tip: click a day to add or edit a holiday.</p>
        </Card>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="Calendar settings" description={`${members.length} active employee(s) assigned`} />
            <CardBody className="space-y-4">
              <div className="grid grid-cols-[1fr_130px] gap-3">
                <Field label="Name">
                  <Input value={schedule.name} onChange={(e) => setSchedule((s) => s && { ...s, name: e.target.value })} />
                </Field>
                <Field label="Country">
                  <Select value={schedule.country} onChange={(e) => setSchedule((s) => s && { ...s, country: e.target.value as CountryCode })}>
                    {ref.countries.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </Select>
                </Field>
              </div>
              <div>
                <span className="mb-1.5 block text-xs font-medium text-slate-700">Working days</span>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map(({ d, l }) => {
                    const on = schedule.workingDays.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setSchedule((s) => s && { ...s, workingDays: on ? s.workingDays.filter((x) => x !== d) : [...s.workingDays, d].sort() })}
                        className={cn('h-8 w-11 rounded-md border text-xs font-medium', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50')}
                      >
                        {l}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-[96px_1fr] gap-3">
                <Field label="Hours / day">
                  <Input type="number" min={1} max={12} step={0.5} value={schedule.hoursPerDay} onChange={(e) => setSchedule((s) => s && { ...s, hoursPerDay: Number(e.target.value) })} />
                </Field>
                <Field label="Time zone">
                  <Select value={schedule.timezone} onChange={(e) => setSchedule((s) => s && { ...s, timezone: e.target.value })}>
                    {timeZones(schedule.timezone).map((t) => <option key={t}>{t}</option>)}
                  </Select>
                </Field>
              </div>
              <p className="text-xs text-slate-500">Expected weekly hours: {schedule.workingDays.length * schedule.hoursPerDay}h. Leave hours are derived from this schedule.</p>
              <Button icon={Save} loading={busy} className="w-full" disabled={!scheduleDirty || !schedule.workingDays.length} onClick={() => run(() => updateCalendar(cal.id, schedule), { title: 'Calendar saved', message: schedule.name })}>
                Save calendar
              </Button>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Holidays"
              actions={
                <>
                  <FilterSelect label="Year" value={year} onChange={setYear} options={[...years.map((y) => ({ value: y, label: y })), { value: 'all', label: 'All years' }]} />
                  <Button size="sm" icon={Plus} onClick={() => { setPresetDate(undefined); setEditingHoliday(null); }}>Add</Button>
                </>
              }
            />
            <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
              {holidays.map((h) => (
                <li key={h.id} className={cn('flex items-center gap-3 px-5 py-2.5', h.date < todayISO() && 'opacity-60')}>
                  <div className="w-24 shrink-0 text-xs text-slate-500">{formatDate(h.date, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{h.name}</p>
                    <Badge tone={h.type === 'public' ? 'amber' : 'slate'} className="mt-0.5">{ref.label(ref.holidayTypes, h.type)}</Badge>
                  </div>
                  <IconButton icon={Pencil} label="Edit holiday" onClick={() => setEditingHoliday(h)} />
                  <IconButton icon={Trash2} label="Delete holiday" tone="danger" onClick={() => setDeleting(h)} />
                </li>
              ))}
              {holidays.length === 0 && <li className="px-5 py-6 text-sm text-slate-500">No holidays recorded for this period.</li>}
            </ul>
          </Card>
        </div>
      </div>

      <Card className="mt-5">
        <CardHeader title="Employee calendar assignment" description="Each employee's expected hours, leave and holidays follow their assigned calendar." />
        <TableToolbar>
          <SearchInput value={assignTable.query} onChange={assignTable.setQuery} placeholder="Search employees…" />
        </TableToolbar>
        <DataTable columns={assignCols} rows={assignTable.rows} rowKey={(e) => e.id} sort={assignTable.sort} onSort={assignTable.toggleSort} emptyTitle="No employees yet" />
      </Card>

      {createModal}
      <HolidayModal
        open={editingHoliday !== undefined}
        holiday={editingHoliday ?? null}
        presetDate={presetDate}
        calendarName={cal.name}
        holidayTypes={ref.holidayTypes}
        onClose={() => setEditingHoliday(undefined)}
        onSave={(input) => saveHoliday(cal.id, input, editingHoliday?.id)}
      />
      <ConfirmDialog
        open={!!deleting}
        title="Delete holiday?"
        tone="danger"
        confirmLabel="Delete"
        busy={busy}
        message={deleting && `${deleting.name} (${formatDate(deleting.date)}) will be removed from ${cal.name}. Expected hours for that week will increase.`}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const ok = await run(() => deleteHoliday(cal.id, deleting.id), { title: 'Holiday deleted' });
          if (ok) setDeleting(null);
        }}
      />
    </div>
  );
}

function CalendarFormModal({ open, onClose, onCreated, defaultHoursPerDay }: { open: boolean; onClose: () => void; onCreated: (c: WorkCalendar) => void; defaultHoursPerDay: number }) {
  const { createCalendar } = useAppData();
  const ref = useReferenceData();
  const [form, setForm] = useState<CalendarInput>({ name: '', country: 'US', workingDays: [1, 2, 3, 4, 5], hoursPerDay: defaultHoursPerDay, timezone: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ name: '', country: ref.countries[0]?.value ?? 'US', workingDays: [1, 2, 3, 4, 5], hoursPerDay: defaultHoursPerDay, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setErrors({});
      setError(null);
    }
  }, [open, defaultHoursPerDay, ref.countries]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const cal = await createCalendar(form);
      onCreated(cal);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setErrors(err.fieldErrors);
      setError(err instanceof Error ? err.message : 'Could not create the calendar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="New holiday calendar"
      description="Default schedule: Monday–Friday. You can change working days after creating it."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={submit}>Create calendar</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Calendar name" required error={errors.name}>
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. US Calendar" invalid={!!errors.name} />
        </Field>
        <Field label="Country" required>
          <Select value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value as CountryCode }))}>
            {ref.countries.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-[96px_1fr] gap-3">
          <Field label="Hours / day" error={errors.hoursPerDay}>
            <Input type="number" min={1} max={12} step={0.5} value={form.hoursPerDay} onChange={(e) => setForm((f) => ({ ...f, hoursPerDay: Number(e.target.value) }))} />
          </Field>
          <Field label="Time zone" required error={errors.timezone}>
            <Select value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}>
              {timeZones(form.timezone).map((t) => <option key={t}>{t}</option>)}
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function HolidayModal({
  open,
  holiday,
  presetDate,
  calendarName,
  holidayTypes,
  onClose,
  onSave,
}: {
  open: boolean;
  holiday: Holiday | null;
  presetDate?: ISODate;
  calendarName: string;
  holidayTypes: Array<{ value: HolidayType; label: string }>;
  onClose: () => void;
  onSave: (h: HolidayInput) => Promise<void>;
}) {
  const [form, setForm] = useState<HolidayInput>({ date: todayISO(), name: '', type: 'public' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const { run } = useAsyncAction();

  useEffect(() => {
    if (open) {
      setForm(holiday ? { date: holiday.date, name: holiday.name, type: holiday.type } : { date: presetDate ?? todayISO(), name: '', type: holidayTypes[0]?.value ?? 'public' });
      setErrors({});
    }
  }, [open, holiday, presetDate, holidayTypes]);

  const submit = async () => {
    setBusy(true);
    setErrors({});
    const ok = await run(
      () =>
        onSave(form).catch((err: unknown) => {
          if (err instanceof ApiError && err.fieldErrors) setErrors(err.fieldErrors);
          throw err;
        }),
      { title: holiday ? 'Holiday updated' : 'Holiday added', message: `${form.name} · ${formatDate(form.date)}` },
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={holiday ? 'Edit holiday' : 'Add holiday'}
      description={calendarName}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={submit}>{holiday ? 'Save' : 'Add holiday'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Date" required error={errors.date} hint={isWeekend(form.date) ? 'This date falls on a weekend.' : undefined}>
          <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        </Field>
        <Field label="Holiday name" required error={errors.name}>
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} invalid={!!errors.name} />
        </Field>
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as HolidayType }))}>
            {holidayTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
