import { useEffect, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import type { OvertimeApprover, OvertimePolicy } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { useReferenceData } from '@/hooks/useLookups';
import { formatHours, sum } from '@/utils/format';
import { PageHeader, Alert, Segmented } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { Field, Input, Select, Toggle } from '@/components/forms/FormControls';
import { OvertimeTable } from '@/components/tables/OvertimeTable';
import { StatCard } from '@/components/common/StatCard';
import { CheckCircle2, Hourglass, Timer, XCircle } from 'lucide-react';

/** Fills eligibility fields missing from policies saved before they existed. */
const normalise = (p: OvertimePolicy): OvertimePolicy => ({ ...p, eligibilityScope: p.eligibilityScope ?? 'all', eligibleDepartments: p.eligibleDepartments ?? [] });

export function OvertimePoliciesPage() {
  const { policy: savedPolicy, overtime, employees, savePolicy } = useAppData();
  const policy = normalise(savedPolicy);
  const { busy, run } = useAsyncAction();
  const ref = useReferenceData();
  const [form, setForm] = useState<OvertimePolicy>(policy);
  useEffect(() => setForm(normalise(savedPolicy)), [savedPolicy]);
  const dirty = JSON.stringify(form) !== JSON.stringify(policy);
  const set = <K extends keyof OvertimePolicy>(k: K, v: OvertimePolicy[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleDepartment = (name: string, on: boolean) =>
    set('eligibleDepartments', on ? [...form.eligibleDepartments, name] : form.eligibleDepartments.filter((d) => d !== name));
  const noDepartmentChosen = form.eligibilityScope === 'departments' && form.eligibleDepartments.length === 0;
  const active = employees.filter((e) => e.status === 'active');
  const overrides = active.filter((e) => e.overtimeEligibility && e.overtimeEligibility !== 'inherit');
  const eligibleCount = active.filter((e) =>
    e.overtimeEligibility === 'eligible' ||
    (e.overtimeEligibility !== 'not_eligible' && (form.eligibilityScope === 'all' || form.eligibleDepartments.includes(e.department))),
  ).length;

  const by = (s: string) => sum(overtime.filter((o) => o.status === s).map((o) => o.hours));

  return (
    <div>
      <PageHeader
        title="Overtime & Policies"
        description="Configure how additional hours are identified, approved and compensated."
        actions={
          <>
            <Button variant="ghost" icon={RotateCcw} disabled={!dirty} onClick={() => setForm(policy)}>Discard</Button>
            <Button icon={Save} loading={busy} disabled={!dirty || noDepartmentChosen} onClick={() => run(() => savePolicy(form), { title: 'Overtime policy saved' })}>Save policy</Button>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Overtime records" value={overtime.length} icon={Timer} />
        <StatCard label="Approved hours" value={formatHours(by('approved'))} icon={CheckCircle2} tone="green" />
        <StatCard label="Pending hours" value={formatHours(by('pending'))} icon={Hourglass} tone="amber" />
        <StatCard label="Rejected hours" value={formatHours(by('rejected'))} icon={XCircle} tone="red" />
      </div>

      <Card className="mb-5">
        <CardHeader
          title="Overtime eligibility"
          description={`Who can earn overtime. With these settings ${eligibleCount} of ${active.length} active employees are eligible.`}
        />
        <CardBody className="space-y-4">
          <Segmented
            value={form.eligibilityScope}
            onChange={(v) => set('eligibilityScope', v)}
            options={[
              { value: 'all', label: 'All departments' },
              { value: 'departments', label: 'Selected departments only' },
            ]}
          />
          {form.eligibilityScope === 'departments' && (
            ref.departments.length === 0 ? (
              <Alert tone="warning">No departments exist yet. Add them in Settings → Reference data.</Alert>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {ref.departments.map((d) => (
                  <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300"
                      checked={form.eligibleDepartments.includes(d.name)}
                      onChange={(e) => toggleDepartment(d.name, e.target.checked)}
                      disabled={!form.enabled}
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            )
          )}
          {noDepartmentChosen && ref.departments.length > 0 && <p className="text-sm text-red-600">Select at least one department, or make all departments eligible.</p>}
          <p className="text-sm text-slate-500">
            Individual exceptions are set on each employee (Employees → Edit → Overtime eligibility).
            {overrides.length > 0
              ? ` Current exceptions: ${overrides.map((e) => `${e.name} (${e.overtimeEligibility === 'eligible' ? 'always eligible' : 'not eligible'})`).join(', ')}.`
              : ' No employee has an exception.'}
          </p>
        </CardBody>
      </Card>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card>
          <CardHeader title="Overtime identification" description="When are hours treated as additional?" />
          <CardBody className="divide-y divide-slate-100 py-1">
            <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="Overtime tracking enabled" description="Flag additional hours on submitted timesheets." />
            <Toggle checked={form.autoFlag} onChange={(v) => set('autoFlag', v)} label="Auto-create overtime requests" description="Create a pending request for the project manager on submission." disabled={!form.enabled} />
            <div className="grid grid-cols-2 gap-3 py-3">
              <Field label="Daily threshold (h)">
                <Input type="number" min={1} max={24} step={0.5} value={form.dailyThreshold} onChange={(e) => set('dailyThreshold', Number(e.target.value))} disabled={!form.enabled} />
              </Field>
              <Field label="Weekly threshold (h)">
                <Input type="number" min={1} max={80} step={0.5} value={form.weeklyThreshold} onChange={(e) => set('weeklyThreshold', Number(e.target.value))} disabled={!form.enabled} />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Weekend & holiday applicability" description="Hours worked on non-working days." />
          <CardBody className="divide-y divide-slate-100 py-1">
            <Toggle checked={form.weekendApplicable} onChange={(v) => set('weekendApplicable', v)} label="Weekend hours count as overtime" description="All Saturday / Sunday hours are flagged." disabled={!form.enabled} />
            <Toggle checked={form.holidayApplicable} onChange={(v) => set('holidayApplicable', v)} label="Holiday hours count as overtime" description="Hours on the employee's calendar holidays are flagged." disabled={!form.enabled} />
            <div className="grid grid-cols-2 gap-3 py-3">
              <Field label="Weekday multiplier">
                <Input type="number" min={1} max={3} step={0.25} value={form.weekdayMultiplier} onChange={(e) => set('weekdayMultiplier', Number(e.target.value))} />
              </Field>
              <Field label="Weekend / holiday multiplier">
                <Input type="number" min={1} max={3} step={0.25} value={form.weekendMultiplier} onChange={(e) => set('weekendMultiplier', Number(e.target.value))} />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Approval rules" description="Who approves additional hours, and limits." />
          <CardBody className="divide-y divide-slate-100 py-1">
            <div className="py-3">
              <Field label="Overtime approver">
                <Select value={form.approver} onChange={(e) => set('approver', e.target.value as OvertimeApprover)}>
                  {ref.overtimeApprovers.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
            </div>
            <Toggle checked={form.requirePreApproval} onChange={(v) => set('requirePreApproval', v)} label="Require pre-approval" description="Employees must request approval before working additional hours." />
            <div className="py-3">
              <Field label="Maximum overtime per week (h)" hint="Hours above this are highlighted for review.">
                <Input type="number" min={0} max={40} step={0.5} value={form.maxWeeklyOvertime} onChange={(e) => set('maxWeeklyOvertime', Number(e.target.value))} />
              </Field>
            </div>
          </CardBody>
        </Card>
      </div>

      <Alert tone="info" className="mt-5">
        Example: with these settings, an employee working {form.dailyThreshold + 2}h on a weekday has 2h flagged
        {form.weekendApplicable ? ` and all weekend hours are flagged at ${form.weekendMultiplier}×` : ''}. Weekly totals above {form.weeklyThreshold}h are always flagged.
      </Alert>

      <Card className="mt-5">
        <CardHeader title="All overtime records" description="Auto-flagged from timesheets and pre-approval requests." />
        <OvertimeTable records={overtime} />
      </Card>
    </div>
  );
}
