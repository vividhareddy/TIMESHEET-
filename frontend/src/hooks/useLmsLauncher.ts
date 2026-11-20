import { useCallback, useState } from 'react';
import { lmsService } from '@/services';
import { useToast } from '@/context/ToastContext';

/** LMS pages that can be opened directly (they are the LMS's own #page routes). */
export type LmsPage = 'courses' | 'catalog' | 'certificates' | 'calendar' | 'assessments';

/**
 * Opens the LMS in a new tab, already signed in with the timesheet account, optionally on a given page.
 * The tab is opened immediately (so pop-up blockers allow it) and pointed at the single sign-on address once the
 * API has issued the one-minute ticket. The #page survives the LMS's sign-in redirect, so the LMS opens on it.
 */
export function useLmsLauncher() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const open = useCallback(
    async (page?: LmsPage): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      const tab = window.open('', '_blank');
      if (tab) {
        tab.opener = null;
        tab.document.title = 'Opening My LMS…';
        tab.document.body.innerHTML = '<p style="font:14px system-ui,sans-serif;color:#475569;margin:2rem">Opening My LMS…</p>';
      }
      try {
        const { url } = await lmsService.launch();
        const target = page ? `${url}#${page}` : url;
        if (tab) tab.location.replace(target);
        else window.location.assign(target);
        return true;
      } catch (err) {
        tab?.close();
        toast.error('Could not open My LMS', err instanceof Error ? err.message : undefined);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, toast],
  );

  return { open, busy };
}
