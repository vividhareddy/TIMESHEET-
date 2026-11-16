import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Textarea, Field } from '@/components/forms/FormControls';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'primary' | 'danger' | 'success' | 'warning';
  /** When set, a comment box is shown; `required` makes it mandatory. */
  comment?: { label: string; placeholder?: string; required?: boolean };
  busy?: boolean;
  onConfirm: (comment: string) => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', tone = 'primary', comment, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setText('');
      setTouched(false);
    }
  }, [open]);

  const invalid = !!comment?.required && !text.trim();

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button
            variant={tone}
            loading={busy}
            onClick={() => {
              setTouched(true);
              if (!invalid) onConfirm(text.trim());
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-600">
        <div>{message}</div>
        {comment && (
          <Field label={comment.label} required={comment.required} error={touched && invalid ? 'This field is required.' : undefined}>
            <Textarea rows={3} value={text} placeholder={comment.placeholder} onChange={(e) => setText(e.target.value)} autoFocus />
          </Field>
        )}
      </div>
    </Modal>
  );
}
