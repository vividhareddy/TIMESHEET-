import { useEffect, useState } from 'react';
import { Database, FlaskConical, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { AppSettings, CountryCode } from '@/types';
import type { WorkLocationInput } from '@/types/api';
import { useAppData } from '@/context/AppDataContext';
import { useSession } from '@/context/SessionContext';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { useReferenceData } from '@/hooks/useLookups';
import { API_MODE, IS_MOCK_MODE, mockControlService } from '@/services';
import { API_BASE_URL } from '@/services/config';
import { DAY_LONG } from '@/utils/date';
import { PageHeader, Alert, InfoRow } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button, IconButton } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { Field, Input, Select, Toggle } from '@/components/forms/FormControls';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

function splitDeadline(value: string): { day: string; time: string } {
  const [day, time] = value.split(' ');
  return { day: DAY_LONG.includes(day) ? day : DAY_LONG[0], time: /^\d{2}:\d{2}$/.test(time ?? '') ? time : '10:00' };
}

export function SettingsPage() {
  const { settings, saveSettings } = useAppData();
  const { busy, run } = useAsyncAction();
  const [form, setForm] = useState<AppSettings>(settings);
  useEffect(() => setForm(settings), [settings]);
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const deadline = splitDeadline(form.submissionDeadline);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Organisation defaults, timesheet rules and the reference data used across the application."
        actions={
          <>
            <Button variant="ghost" icon={RotateCcw} disabled={!dirty} onClick={() => setForm(settings)}>Discard</Button>
            <Button icon={Save} loading={busy} disabled={!dirty} onClick={() => run(() => saveSettings(form), { title: 'Settings saved' })}>Save settings</Button>
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Organisation" />
          <CardBody className="space-y-4">
            <Field label="Organisation name" required>
              <Input value={form.organisationName} onChange={(e) => set('organisationName', e.target.value)} />
            </Field>
            <div className="grid grid-cols-[1fr_140px] gap-3">
              <Field label="Timesheet submission deadline">
                <Select value={deadline.day} onChange={(e) => set('submissionDeadline', `${e.target.value} ${deadline.time}`)}>
                  {DAY_LONG.map((d) => <option key={d}>{d}</option>)}
                </Select>
              </Field>
              <Field label="Time">
                <Input type="time" value={deadline.time} onChange={(e) => set('submissionDeadline', `${deadline.day} ${e.target.value}`)} />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Working hours" description="Defaults applied to new employees and calendars." />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Default weekly target (h)" required>
                <Input type="number" min={1} max={60} value={form.defaultWeeklyTarget} onChange={(e) => set('defaultWeeklyTarget', Number(e.target.value))} />
              </Field>
              <Field label="Default hours per day" required>
                <Input type="number" min={1} max={12} step={0.5} value={form.defaultHoursPerDay} onChange={(e) => set('defaultHoursPerDay', Number(e.target.value))} />
              </Field>
            </div>
            <Field label="Time entry increment">
              <Select value={form.hourIncrement} onChange={(e) => set('hourIncrement', Number(e.target.value))}>
                <option value={0.5}>0.5 hour</option>
                <option value={0.25}>0.25 hour</option>
                <option value={1}>1 hour</option>
              </Select>
            </Field>
            <p className="text-xs text-slate-500">Individual weekly targets can be overridden per employee.</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Timesheet rules" />
          <CardBody className="divide-y divide-slate-100 py-1">
            <Toggle checked={form.requireDescription} onChange={(v) => set('requireDescription', v)} label="Require work description" description="Each project row with hours needs a description before submission." />
            <Toggle checked={form.allowWeekendEntry} onChange={(v) => set('allowWeekendEntry', v)} label="Allow weekend entries" description="Saturday and Sunday columns can be edited (flagged as overtime)." />
            <Toggle checked={form.reminderEnabled} onChange={(v) => set('reminderEnabled', v)} label="Submission reminders" description="Notify employees who have not submitted by the deadline." />
          </CardBody>
        </Card>

        <DataSourceCard />

        <DepartmentsCard />
        <WorkLocationsCard />
      </div>
    </div>
  );
}

function DepartmentsCard() {
  const { addDepartment, removeDepartment } = useAppData();
  const ref = useReferenceData();
  const { busy, run } = useAsyncAction();
  const [name, setName] = useState('');

  return (
    <Card>
      <CardHeader title="Departments" description="Options for the employee Department field." />
      <CardBody>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            if (await run(() => addDepartment(name.trim()), { title: 'Department added', message: name.trim() })) setName('');
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New department name" aria-label="New department name" />
          <Button type="submit" icon={Plus} loading={busy} disabled={!name.trim()}>Add</Button>
        </form>
        <ul className="mt-4 divide-y divide-slate-100 rounded-md border border-slate-200">
          {ref.departments.map((d) => (
            <li key={d.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-800">{d.name}</span>
              <IconButton icon={Trash2} label={`Remove ${d.name}`} tone="danger" onClick={() => run(() => removeDepartment(d.id), { title: 'Department removed', message: d.name })} />
            </li>
          ))}
          {ref.departments.length === 0 && <li className="px-3 py-4 text-sm text-slate-500">No departments yet.</li>}
        </ul>
      </CardBody>
    </Card>
  );
}

function WorkLocationsCard() {
  const { calendars, addWorkLocation, updateWorkLocation, removeWorkLocation } = useAppData();
  const ref = useReferenceData();
  const { busy, run } = useAsyncAction();
  const blank = (): WorkLocationInput => ({ name: '', country: ref.countries[0]?.value ?? 'US', defaultCalendarId: null });
  const [form, setForm] = useState<WorkLocationInput>(blank);

  return (
    <Card>
      <CardHeader title="Work locations" description="Each location maps to a country and a default holiday calendar." />
      <CardBody>
        <form
          className="grid gap-2 sm:grid-cols-[1fr_130px_1fr_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!form.name.trim()) return;
            if (await run(() => addWorkLocation({ ...form, name: form.name.trim() }), { title: 'Location added', message: form.name.trim() })) setForm(blank());
          }}
        >
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="City / office" aria-label="Location name" />
          <Select value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value as CountryCode }))} aria-label="Country">
            {ref.countries.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
          <Select value={form.defaultCalendarId ?? ''} onChange={(e) => setForm((f) => ({ ...f, defaultCalendarId: e.target.value || null }))} aria-label="Default calendar">
            <option value="">No default calendar</option>
            {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Button type="submit" icon={Plus} loading={busy} disabled={!form.name.trim()}>Add</Button>
        </form>
        <ul className="mt-4 divide-y divide-slate-100 rounded-md border border-slate-200">
          {ref.workLocations.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-[120px] flex-1 text-slate-800">{l.name}</span>
              <Badge>{ref.label(ref.countries, l.country)}</Badge>
              <select
                aria-label={`Default calendar for ${l.name}`}
                value={l.defaultCalendarId ?? ''}
                onChange={(e) => run(() => updateWorkLocation(l.id, { name: l.name, country: l.country, defaultCalendarId: e.target.value || null }), { title: 'Default calendar updated' })}
                className="h-8 rounded-md border border-slate-300 bg-white px-2 pr-7 text-xs"
              >
                <option value="">No default calendar</option>
                {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <IconButton icon={Trash2} label={`Remove ${l.name}`} tone="danger" onClick={() => run(() => removeWorkLocation(l.id), { title: 'Location removed', message: l.name })} />
            </li>
          ))}
          {ref.workLocations.length === 0 && <li className="px-3 py-4 text-sm text-slate-500">No work locations yet.</li>}
        </ul>
      </CardBody>
    </Card>
  );
}

function DataSourceCard() {
  const { logout } = useSession();
  const { refresh } = useAppData();
  const { busy, run } = useAsyncAction();
  const [confirm, setConfirm] = useState<'reset' | 'sample' | null>(null);

  return (
    <Card>
      <CardHeader title="Data source" description="Where this application reads and writes data." />
      <CardBody>
        <div className="divide-y divide-slate-100">
          <InfoRow label="Mode">{IS_MOCK_MODE ? <Badge tone="amber">Development mock API</Badge> : <Badge tone="green">REST API</Badge>}</InfoRow>
          <InfoRow label="API base URL">{IS_MOCK_MODE ? 'In-browser mock server' : API_BASE_URL}</InfoRow>
        </div>
        {IS_MOCK_MODE ? (
          <>
            <Alert tone="warning" icon={FlaskConical} className="mt-4" title="Mock data is not real">
              Records are stored in this browser only. Set <code className="rounded bg-white/70 px-1">VITE_API_MODE=api</code> to connect the Express + PostgreSQL backend.
            </Alert>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" icon={Database} onClick={() => setConfirm('sample')}>Replace with sample dataset</Button>
              <Button variant="danger" icon={RotateCcw} onClick={() => setConfirm('reset')}>Reset to empty database</Button>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-slate-500">Connected in <span className="font-medium">{API_MODE}</span> mode.</p>
        )}
      </CardBody>
      <ConfirmDialog
        open={!!confirm}
        title={confirm === 'reset' ? 'Reset mock database?' : 'Load sample dataset?'}
        tone="danger"
        confirmLabel={confirm === 'reset' ? 'Reset' : 'Replace data'}
        busy={busy}
        message={
          confirm === 'reset'
            ? 'All mock records will be deleted, including your account. You will be returned to first-run setup.'
            : 'All mock records will be replaced with the illustrative sample dataset. You will be signed out.'
        }
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const ok = await run(confirm === 'reset' ? mockControlService.reset : mockControlService.loadSampleData, {
            title: confirm === 'reset' ? 'Mock database cleared' : 'Sample dataset loaded',
          });
          setConfirm(null);
          if (ok) await logout().catch(() => refresh());
        }}
      />
    </Card>
  );
}
