import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Employee, EmployeeStatus, Role } from '@/types';
import type { EmployeeInput } from '@/types/api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Alert } from '@/components/common/Misc';
import { Field, Input, Select } from './FormControls';
import { useAppData } from '@/context/AppDataContext';
import { useToast } from '@/context/ToastContext';
import { useSession } from '@/context/SessionContext';
import { useReferenceData } from '@/hooks/useLookups';
import { ApiError } from '@/services';
import { todayISO } from '@/utils/date';

interface Props {
  open: boolean;
  employee?: Employee | null;
  onClose: () => void;
}

type Errors = Partial<Record<keyof EmployeeInput, string>>;

function blankInput(defaultWeeklyTarget: number): EmployeeInput {
  return {
    employeeCode: '',
    name: '',
    email: '',
    phone: '',
    department: '',
    designation: '',
    workLocation: '',
    country: 'US',
    calendarId: '',
    managerId: null,
    systemRole: 'associate',
    status: 'active',
    weeklyCapacity: defaultWeeklyTarget,
    joinDate: todayISO(),
    password: '',
  };
}

/** Create / edit an employee. Duplicate IDs and emails are validated by the API (409 + field errors). */
export function EmployeeFormModal({ open, employee, onClose }: Props) {
  const { employees, calendars, settings, saveEmployee } = useAppData();
  const ref = useReferenceData();
  const toast = useToast();
  const { user } = useSession();
  const isSelf = !!employee && employee.id === user?.id;
  const [form, setForm] = useState<EmployeeInput>(() => blankInput(settings.defaultWeeklyTarget));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (employee) {
      const { id: _id, ...input } = employee;
      void _id;
      setForm({ ...input, password: '' });
    } else setForm(blankInput(settings.defaultWeeklyTarget));
    setErrors({});
    setFormError(null);
  }, [open, employee, settings.defaultWeeklyTarget]);

  const set = <K extends keyof EmployeeInput>(key: K, value: EmployeeInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const onLocation = (name: string) => {
    const loc = ref.workLocations.find((l) => l.name === name);
    setForm((f) => ({ ...f, workLocation: name, country: loc?.country ?? f.country, calendarId: loc?.defaultCalendarId ?? f.calendarId }));
  };

  const submit = async () => {
    setErrors({});
    setFormError(null);
    const password = form.password ?? '';
    if (!employee && !password) return setErrors({ password: 'Set a temporary password for the new account.' });
    if (password && password.length < 8) return setErrors({ password: 'Use at least 8 characters.' });
    setBusy(true);
    try {
      const { password: _pw, ...details } = form;
      const saved = await saveEmployee(password ? { ...details, password } : details, employee?.id);
      toast.success(
        employee ? 'Employee updated' : 'Employee added',
        password ? `${saved.name} — share the ${employee ? 'new' : 'temporary'} password with them securely.` : saved.name,
      );
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setErrors(err.fieldErrors as Errors);
      setFormError(err instanceof Error ? err.message : 'Could not save the employee.');
    } finally {
      setBusy(false);
    }
  };

  const managers = employees.filter((e) => (e.systemRole === 'manager' || e.systemRole === 'admin') && e.id !== employee?.id && e.status === 'active');
  const missingReference = ref.departments.length === 0 || ref.workLocations.length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={employee ? 'Edit employee' : 'Add employee'}
      description={employee ? `${employee.employeeCode} · ${employee.name}` : 'Create a new employee record.'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={missingReference}>{employee ? 'Save changes' : 'Add employee'}</Button>
        </>
      }
    >
      {missingReference && (
        <Alert tone="warning" className="mb-4" title="Reference data required">
          Add at least one department and one work location in <Link to="/admin/settings" className="font-medium underline" onClick={onClose}>Settings → Reference data</Link> before creating employees.
        </Alert>
      )}
      {formError && <Alert tone="danger" className="mb-4">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Employee ID" required error={errors.employeeCode}>
          <Input value={form.employeeCode} onChange={(e) => set('employeeCode', e.target.value.toUpperCase())} invalid={!!errors.employeeCode} placeholder="Unique employee number" />
        </Field>
        <Field label="Full name" required error={errors.name}>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} invalid={!!errors.name} />
        </Field>
        <Field label="Work email" required error={errors.email}>
          <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} invalid={!!errors.email} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Department" required error={errors.department}>
          <Select value={form.department} onChange={(e) => set('department', e.target.value)} invalid={!!errors.department}>
            <option value="">Select department…</option>
            {ref.departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Designation" required error={errors.designation}>
          <Input value={form.designation} onChange={(e) => set('designation', e.target.value)} invalid={!!errors.designation} />
        </Field>
        <Field label="Work location" required error={errors.workLocation}>
          <Select value={form.workLocation} onChange={(e) => onLocation(e.target.value)} invalid={!!errors.workLocation}>
            <option value="">Select location…</option>
            {ref.workLocations.map((l) => <option key={l.id} value={l.name}>{l.name} ({ref.label(ref.countries, l.country)})</option>)}
          </Select>
        </Field>
        <Field label="Holiday calendar" error={errors.calendarId} hint={calendars.length ? 'Defaults from the work location.' : 'No calendars yet — create one under Calendars.'}>
          <Select value={form.calendarId} onChange={(e) => set('calendarId', e.target.value)}>
            <option value="">— Not assigned —</option>
            {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Reporting manager" error={errors.managerId}>
          <Select value={form.managerId ?? ''} onChange={(e) => set('managerId', e.target.value || null)}>
            <option value="">— None —</option>
            {managers.map((m) => <option key={m.id} value={m.id}>{m.name}{m.designation ? ` (${m.designation})` : ''}</option>)}
          </Select>
        </Field>
        <Field label="System role" error={errors.systemRole} hint={isSelf ? 'You cannot change your own role.' : 'Controls which workspace and features this person can use.'}>
          <Select value={form.systemRole} onChange={(e) => set('systemRole', e.target.value as Role)} disabled={isSelf} title={isSelf ? 'You cannot change your own role.' : undefined}>
            {ref.roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="Weekly target (hours)" required error={errors.weeklyCapacity} hint={`Organisation default is ${settings.defaultWeeklyTarget}h.`}>
          <Input type="number" min={1} max={60} value={form.weeklyCapacity} onChange={(e) => set('weeklyCapacity', Number(e.target.value))} invalid={!!errors.weeklyCapacity} />
        </Field>
        <Field label="Join date">
          <Input type="date" value={form.joinDate} onChange={(e) => set('joinDate', e.target.value)} />
        </Field>
        <Field label="Status" error={errors.status}>
          <Select value={form.status} onChange={(e) => set('status', e.target.value as EmployeeStatus)} disabled={isSelf}>
            {ref.employeeStatuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        <Field
          label={employee ? 'Reset password' : 'Temporary password'}
          required={!employee}
          error={errors.password}
          hint={employee ? 'Leave blank to keep the current password.' : 'At least 8 characters. Share it with the employee securely.'}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={form.password ?? ''}
            onChange={(e) => set('password', e.target.value)}
            invalid={!!errors.password}
          />
        </Field>
      </div>
    </Modal>
  );
}
