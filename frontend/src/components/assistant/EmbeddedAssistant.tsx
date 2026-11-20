import { Bot, LogIn, X } from 'lucide-react';
import { useSession } from '@/context/SessionContext';
import { AppDataProvider } from '@/context/AppDataContext';
import { Spinner } from '@/components/common/StatusScreen';
import { AssistantWidget, EMBED_CLOSE_MESSAGE } from './AssistantWidget';

/**
 * /assistant/embed — only the assistant, for the LMS to show in a frame (lms/frontend/public/scripts/assistant.js).
 * Uses the timesheet session from this browser; without one it asks the person to sign in to TimeTrack.
 */
export function EmbeddedAssistant() {
  const session = useSession();
  const close = () => window.parent.postMessage({ type: EMBED_CLOSE_MESSAGE }, window.location.origin);

  if (session.status === 'authenticated' && session.user) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-white">
        <AppDataProvider>
          <AssistantWidget role={session.user.systemRole} embedded />
        </AppDataProvider>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-white">
      <header className="palette-light flex items-center gap-3 bg-gradient-to-r from-sidebar via-sidebar to-brand-700 px-4 py-3 text-white">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/20">
          <Bot className="h-5 w-5" />
        </span>
        <p className="flex-1 text-sm font-semibold">TimeTrack Assistant</p>
        <button type="button" onClick={close} className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white" aria-label="Close assistant">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="chat-dots flex flex-1 flex-col items-center justify-center gap-4 bg-slate-50 px-8 text-center">
        {session.status === 'checking' ? (
          <Spinner label="Connecting…" />
        ) : (
          <>
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-pop">
              <Bot className="h-7 w-7" />
            </span>
            <div>
              <p className="text-base font-semibold text-slate-900">Sign in to TimeTrack to chat</p>
              <p className="mt-1 text-sm text-slate-500">The assistant uses your TimeTrack account to find courses, plan leave and take you to your timesheet.</p>
            </div>
            <a
              href="/"
              target="_top"
              className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              <LogIn className="h-4 w-4" /> Sign in to TimeTrack
            </a>
          </>
        )}
      </div>
    </div>
  );
}
