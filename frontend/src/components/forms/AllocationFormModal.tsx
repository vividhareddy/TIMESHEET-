import { useEffect, useMemo, useState } from 'react';
import type { Allocation } from '@/types';
import type { AllocationInput } from '@/types/api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Alert } from '@/components/common/Misc';
import { StackedBar } from '@/components/common/Charts';
import { Field, Input, Select } from './FormControls';
import { useAppData } from '@/context/AppDataContext';
import { useToast } from '@/context/ToastContext';
import { useLookups } from '@/hooks/useLookups';
import { ApiError } from '@/services';
import { FALLBACK_PROJECT_COLOR } from '@/constants/ui';
import { addDays, rangesOverlap, todayISO } from '@/utils/date';
import { formatHours, percent } from '@/utils/format';

interface Props {
  open: boolean;
  allocation?: Allocation | null;
  defaults?: Partial<Pick<Allocation, 'employeeId' | 'projectId'>>;
  /** Limit selectable projects (manager view). */
  projectIds?: string[];
  onClose: () => void;
}

type Errors = Partial<Record<keyof AllocationInput, string>>;

/** Allocation create / edit. Overlap, date-range and permission rules are enforced by the API. */
export function AllocationFormModal({ open, allocation, defaults, projectIds, onClose }: Props) {
  const { employees, projects, allocations, saveAllocation } = useAppData();
  const { project, employee } = useLookups();
  const toast = useToast();
  const [form, setForm] = useState<AllocationInput>(() => blank());
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function blank(): AllocationInput {
    return {
      employeeId: defaults?.employeeId ?? '',
      projectId: defaults?.projectId ?? projectIds?.[0] ?? '',
      projectRole: '',
      weeklyHours: 8,
      startDate: todayISO(),
      endDate: addDays(todayISO(), 180),
    };
  }

  useEffect(() => {
    if (open) {
      if (allocation) {
        const { id: _id, ...input } = allocation;
        void _id;
        setForm(input);
      } else setForm(blank());
      setErrors({});
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, allocation]);

  const set = <K extends keyof AllocationInput>(key: K, value: AllocationInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const emp = employee(form.employeeId);
  const others = useMemo(
    () => allocations.filter((a) => a.employeeId === form.employeeId && a.id !== allocation?.id && rangesOverlap(a.startDate, a.endDate, form.startDate, form.endDate)),
    [allocations, form.employeeId, allocation?.id, form.startDate, form.endDate],
  );
  const capacity = emp?.weeklyCapacity ?? 0;
  const totalWith = others.reduce((s, a) => s + a.weeklyHours, 0) + (Number(form.weeklyHours) || 0);

  const selectableProjects = projects.filter((p) => (projectIds ? projectIds.includes(p.id) : true) && (p.status === 'active' || p.id === form.projectId));
  const selectableEmployees = employees.filter((e) => e.status === 'active' && e.systemRole !== 'admin');
  const projectAllowed = !projectIds || projectIds.includes(form.projectId);

  const submit = async () => {
    if (!projectAllowed) return;
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      await saveAllocation(form, allocation?.id);
      toast.success(allocation ? 'Allocation updated' : 'Allocation created', `${emp?.name} → ${project(form.projectId)?.name} · ${formatHours(form.weeklyHours)}/week`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setErrors(err.fieldErrors as Errors);
      setFormError(err instanceof Error ? err.message : 'Could not save the allocation.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={allocation ? 'Edit allocation' : 'Allocate resource'}
      description="Assign weekly hours for an employee on a project. One employee can be allocated to multiple projects."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!projectAllowed}>{allocation ? 'Save changes' : 'Allocate'}</Button>
        </>
      }
    >
      {formError && <Alert tone="danger" className="mb-4">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Employee" required error={errors.employeeId}>
          <Select value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)} disabled={!!allocation} invalid={!!errors.employeeId}>
            <option value="">Select employee…</option>
            {selectableEmployees.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.designation}</option>)}
          </Select>
        </Field>
        <Field label="Project" required error={errors.projectId}>
          <Select value={form.projectId} onChange={(e) => set('projectId', e.target.value)} disabled={!!allocation} invalid={!!errors.projectId}>
            <option value="">Select project…</option>
            {selectableProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Project role">
          <Input value={form.projectRole} onChange={(e) => set('projectRole', e.target.value)} placeholder="e.g. Developer, QA, Analyst" />
        </Field>
        <Field label="Allocated weekly hours" required error={errors.weeklyHours} hint={emp ? `${percent(form.weeklyHours, capacity)}% of ${formatHours(capacity)} weekly capacity` : undefined}>
          <Input type="number" min={0.5} max={60} step={0.5} value={form.weeklyHours} onChange={(e) => set('weeklyHours', Number(e.target.value))} invalid={!!errors.weeklyHours} />
        </Field>
        <Field label="Start date" required>
          <Input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
        </Field>
        <Field label="End date" required error={errors.endDate}>
          <Input type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} invalid={!!errors.endDate} />
        </Field>
      </div>

      {emp && (
        <div className="mt-5 rounded-md border border-slate-200 p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-slate-800">Capacity for {emp.name} during this period</span>
            <span className="tabular-nums text-slate-600">
              {formatHours(totalWith)} / {formatHours(capacity)} ({percent(totalWith, capacity)}%)
            </span>
          </div>
          <StackedBar
            total={capacity}
            segments={[
              ...others.map((a) => ({ value: a.weeklyHours, color: project(a.projectId)?.color ?? FALLBACK_PROJECT_COLOR, label: project(a.projectId)?.name ?? '' })),
              { value: Number(form.weeklyHours) || 0, color: project(form.projectId)?.color ?? '#3b6db3', label: 'This allocation' },
            ]}
          />
          <ul className="mt-3 space-y-1 text-xs text-slate-500">
            {others.map((a) => (
              <li key={a.id}>
                {project(a.projectId)?.name}: {formatHours(a.weeklyHours)} ({a.startDate} → {a.endDate})
              </li>
            ))}
            {others.length === 0 && <li>No other overlapping allocations.</li>}
          </ul>
          {totalWith > capacity && (
            <Alert tone="danger" className="mt-3">
              Over-allocated by {formatHours(totalWith - capacity)}. You can still save, but the employee will be flagged.
            </Alert>
          )}
          {totalWith < capacity && (
            <Alert tone="warning" className="mt-3">
              Under-allocated — {formatHours(capacity - totalWith)} of weekly capacity remains unassigned.
            </Alert>
          )}
        </div>
      )}
    </Modal>
  );
}
