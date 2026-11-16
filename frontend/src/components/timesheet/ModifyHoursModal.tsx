import { useEffect, useState } from 'react';
import type { TimesheetEntry, ISODate } from '@/types';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Field, Textarea } from '@/components/forms/FormControls';
import { Alert } from '@/components/common/Misc';
import { DAY_SHORT, formatShort, weekDates } from '@/utils/date';
import { cn, formatHours, roundToIncrement, sum } from '@/utils/format';

interface Props {
  open: boolean;
  entry: TimesheetEntry | null;
  weekStart: ISODate;
  projectName: string;
  employeeName: string;
  busy?: boolean;
  onCancel: () => void;
  onSave: (hours: number[], reason: string) => void;
}

/** Lets a manager adjust submitted hours. A reason is mandatory and recorded in history. */
export function ModifyHoursModal({ open, entry, weekStart, projectName, employeeName, busy, onCancel, onSave }: Props) {
  const [hours, setHours] = useState<number[]>(Array(7).fill(0));
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open && entry) {
      setHours([...entry.hours]);
      setReason('');
      setTouched(false);
    }
  }, [open, entry]);

  if (!entry) return null;
  const dates = weekDates(weekStart);
  const unchanged = hours.every((h, i) => h === entry.hours[i]);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Modify hours"
      description={`${employeeName} · ${projectName}`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button
            loading={busy}
            disabled={unchanged}
            onClick={() => {
              setTouched(true);
              if (reason.trim()) onSave(hours, reason.trim());
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Alert tone="info">The employee's original hours are kept in the record and the change is shown in the approval history.</Alert>
        <div className="grid grid-cols-7 gap-2">
          {dates.map((d, i) => (
            <label key={d} className="text-center">
              <span className="block text-xs font-medium text-slate-600">{DAY_SHORT[i]}</span>
              <span className="block text-[11px] text-slate-400">{formatShort(d)}</span>
              <input
                type="number"
                min={0}
                max={24}
                step={0.5}
                value={hours[i] === 0 ? '' : hours[i]}
                placeholder="0"
                onChange={(e) => setHours((h) => h.map((v, j) => (j === i ? Math.min(24, Math.max(0, Number(e.target.value) || 0)) : v)))}
                onBlur={() => setHours((h) => h.map((v) => roundToIncrement(v)))}
                className={cn(
                  'no-spin mt-1 h-9 w-full rounded-md border text-center text-sm tabular-nums focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20',
                  hours[i] !== entry.hours[i] ? 'border-violet-400 bg-violet-50' : 'border-slate-300',
                )}
              />
              <span className="mt-0.5 block text-[10px] text-slate-400">was {formatHours(entry.hours[i], false)}</span>
            </label>
          ))}
        </div>
        <p className="text-sm text-slate-600">
          New total <span className="font-semibold text-slate-900">{formatHours(sum(hours))}</span> (submitted {formatHours(sum(entry.hours))})
        </p>
        <Field label="Reason for change" required error={touched && !reason.trim() ? 'A reason is required to modify hours.' : undefined}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain which hours changed and why." />
        </Field>
      </div>
    </Modal>
  );
}
