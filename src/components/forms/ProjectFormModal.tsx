import { useEffect, useState } from 'react';
import type { Project, ProjectStatus } from '@/types';
import type { ProjectInput } from '@/types/api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Alert } from '@/components/common/Misc';
import { Field, Input, Select, Textarea } from './FormControls';
import { useAppData } from '@/context/AppDataContext';
import { useToast } from '@/context/ToastContext';
import { useReferenceData } from '@/hooks/useLookups';
import { ApiError } from '@/services';
import { PROJECT_COLOR_PALETTE } from '@/constants/ui';
import { addDays, todayISO } from '@/utils/date';
import { cn } from '@/utils/format';

type Errors = Partial<Record<keyof ProjectInput, string>>;

export function ProjectFormModal({ open, project, onClose }: { open: boolean; project?: Project | null; onClose: () => void }) {
  const { projects, employees, saveProject } = useAppData();
  const ref = useReferenceData();
  const toast = useToast();
  const blank = (): ProjectInput => ({
    code: '',
    name: '',
    client: '',
    description: '',
    managerId: '',
    startDate: todayISO(),
    endDate: addDays(todayISO(), 365),
    status: 'active',
    billable: true,
    color: PROJECT_COLOR_PALETTE[projects.length % PROJECT_COLOR_PALETTE.length],
  });
  const [form, setForm] = useState<ProjectInput>(blank);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (project) {
      const { id: _id, createdAt: _created, ...input } = project;
      setForm(input);
    } else setForm(blank());
    setErrors({});
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project]);

  const set = <K extends keyof ProjectInput>(key: K, value: ProjectInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  /** Client-side checks; the API re-validates and also reports duplicates. */
  const validate = (): Errors => {
    const e: Errors = {};
    if (!form.name.trim()) e.name = 'Project name is required.';
    if (!form.code.trim()) e.code = 'Project code is required.';
    else if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(form.code.trim())) e.code = 'Use up to 20 letters, digits, "-" or "_".';
    if (!form.client.trim()) e.client = 'Client is required.';
    if (!form.managerId) e.managerId = 'Project manager is required.';
    if (!form.startDate) e.startDate = 'Start date is required.';
    if (!form.endDate) e.endDate = 'End date is required.';
    else if (form.startDate && form.endDate < form.startDate) e.endDate = 'End date must be on or after the start date.';
    return e;
  };

  const submit = async () => {
    setFormError(null);
    const clientErrors = validate();
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) {
      setFormError('Please correct the highlighted fields.');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveProject(form, project?.id);
      toast.success(project ? 'Project updated' : 'Project created', saved.name);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setErrors(err.fieldErrors as Errors);
      setFormError(err instanceof Error ? err.message : 'Could not save the project.');
    } finally {
      setBusy(false);
    }
  };

  // Active project managers and administrators from the employee records (same rule the API enforces).
  const managers = employees
    .filter((e) => (e.systemRole === 'manager' || e.systemRole === 'admin') && e.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name));
  // Keep the current manager visible when editing, even if they are no longer eligible.
  const currentManager = project && !managers.some((m) => m.id === project.managerId) ? employees.find((e) => e.id === project.managerId) : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={project ? 'Edit project' : 'Add project'}
      description={project ? `${project.code} · ${project.name}` : 'Create a client project that employees can be allocated to.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy}>{project ? 'Save changes' : 'Create project'}</Button>
        </>
      }
    >
      {managers.length === 0 && (
        <Alert tone="warning" className="mb-4" title="No project managers yet">
          Create an active employee with the Project Manager role (under Employees) to assign as project manager.
        </Alert>
      )}
      {formError && <Alert tone="danger" className="mb-4">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Project name" required error={errors.name}>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} invalid={!!errors.name} />
        </Field>
        <Field label="Project code" required error={errors.code}>
          <Input value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} invalid={!!errors.code} />
        </Field>
        <Field label="Client" required error={errors.client}>
          <Input value={form.client} onChange={(e) => set('client', e.target.value)} invalid={!!errors.client} />
        </Field>
        <Field label="Project manager" required error={errors.managerId}>
          <Select value={form.managerId} onChange={(e) => set('managerId', e.target.value)} invalid={!!errors.managerId}>
            <option value="">Select manager…</option>
            {currentManager && <option value={currentManager.id}>{currentManager.name} (not eligible)</option>}
            {managers.map((m) => <option key={m.id} value={m.id}>{m.name}{m.designation ? ` — ${m.designation}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Start date" required error={errors.startDate}>
          <Input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} invalid={!!errors.startDate} />
        </Field>
        <Field label="End date" required error={errors.endDate}>
          <Input type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} invalid={!!errors.endDate} />
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={(e) => set('status', e.target.value as ProjectStatus)}>
            {ref.projectStatuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        <Field label="Billing">
          <Select value={form.billable ? 'yes' : 'no'} onChange={(e) => set('billable', e.target.value === 'yes')}>
            <option value="yes">Billable</option>
            <option value="no">Non-billable</option>
          </Select>
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <span className="mb-1.5 block text-xs font-medium text-slate-700">Colour</span>
          <div className="flex flex-wrap gap-2">
            {PROJECT_COLOR_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                onClick={() => set('color', c)}
                className={cn('h-7 w-7 rounded-md ring-offset-2', form.color === c && 'ring-2 ring-slate-500')}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
