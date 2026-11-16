import { useCallback, useState } from 'react';
import { useToast } from '@/context/ToastContext';

/**
 * Wraps an async action with a busy flag and toast feedback.
 * Returns true on success so callers can close modals etc.
 */
export function useAsyncAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<unknown>, success?: { title: string; message?: string }): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        if (success) toast.success(success.title, success.message);
        return true;
      } catch (err) {
        toast.error('Action not completed', err instanceof Error ? err.message : 'Something went wrong.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  return { busy, run };
}
