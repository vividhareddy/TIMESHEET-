import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, FlaskConical, LogOut, Menu, UserRoundCog } from 'lucide-react';
import type { MockAccount } from '@/types/api';
import { useSession } from '@/context/SessionContext';
import { useToast } from '@/context/ToastContext';
import { useCurrentUser, useReferenceData } from '@/hooks/useLookups';
import { useNotifications } from '@/hooks/useNotifications';
import { IS_MOCK_MODE, authService } from '@/services';
import { homePath } from '@/routes/navigation';
import { Avatar } from '@/components/common/Misc';
import { cn } from '@/utils/format';

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onOutside]);
  return ref;
}

const toneDot = { info: 'bg-brand-500', warning: 'bg-amber-500', success: 'bg-emerald-500', danger: 'bg-rose-500' };

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { logout, mockLogin } = useSession();
  const user = useCurrentUser();
  const ref = useReferenceData();
  const { items } = useNotifications();
  const toast = useToast();
  const navigate = useNavigate();
  const [menu, setMenu] = useState<'none' | 'notif' | 'user'>('none');
  const [accounts, setAccounts] = useState<MockAccount[] | null>(null);
  const close = () => setMenu('none');
  const notifRef = useClickOutside(() => menu === 'notif' && close());
  const userRef = useClickOutside(() => menu === 'user' && close());

  // Mock mode only: accounts for quick switching, fetched from the mock API.
  useEffect(() => {
    if (!IS_MOCK_MODE || menu !== 'user') return;
    authService.mockAccounts().then(setAccounts).catch(() => setAccounts([]));
  }, [menu]);

  const switchTo = async (id: string) => {
    close();
    try {
      const next = await mockLogin(id);
      navigate(homePath(next.systemRole));
    } catch (err) {
      toast.error('Could not switch account', err instanceof Error ? err.message : undefined);
    }
  };

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6">
      <button onClick={onMenu} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Open menu">
        <Menu className="h-5 w-5" />
      </button>

      {IS_MOCK_MODE && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800" title="Data is served by the in-browser development mock API and is not real.">
          <FlaskConical className="h-3.5 w-3.5" /> Mock API — not real data
        </span>
      )}

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <div className="relative" ref={notifRef}>
          <button onClick={() => setMenu(menu === 'notif' ? 'none' : 'notif')} className="relative rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700" aria-label="Notifications">
            <Bell className="h-5 w-5" />
            {items.length > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white" />}
          </button>
          {menu === 'notif' && (
            <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-pop">
              <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800">Notifications</div>
              <div className="max-h-80 overflow-y-auto">
                {items.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">You're all caught up.</p>}
                {items.map((n) => (
                  <Link key={n.id} to={n.to} onClick={close} className="flex gap-3 border-b border-slate-100 px-4 py-3 last:border-0 hover:bg-slate-50">
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', toneDot[n.tone])} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">{n.title}</span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500">{n.description}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="relative" ref={userRef}>
          <button onClick={() => setMenu(menu === 'user' ? 'none' : 'user')} className="flex items-center gap-2 rounded-md py-1 pl-1 pr-2 hover:bg-slate-100" aria-label="Account menu">
            <Avatar name={user.name} size="sm" />
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-sm font-medium text-slate-800">{user.name}</span>
              <span className="block text-[11px] text-slate-500">{ref.label(ref.roles, user.systemRole)}</span>
            </span>
            <ChevronDown className="h-4 w-4 text-slate-400" />
          </button>
          {menu === 'user' && (
            <div className="absolute right-0 mt-2 w-72 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-pop">
              <div className="border-b border-slate-200 px-4 py-3">
                <p className="text-sm font-semibold text-slate-800">{user.name}</p>
                <p className="text-xs text-slate-500">{[user.designation, user.workLocation].filter(Boolean).join(' · ') || user.email}</p>
              </div>
              {IS_MOCK_MODE && (
                <div className="max-h-72 overflow-y-auto border-b border-slate-200 px-2 py-2">
                  <p className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                    <UserRoundCog className="h-3.5 w-3.5" /> Switch mock account
                  </p>
                  {accounts === null && <p className="px-2 py-1 text-xs text-slate-500">Loading…</p>}
                  {accounts?.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => switchTo(a.id)}
                      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-50', a.id === user.id && 'bg-brand-50')}
                    >
                      <Avatar name={a.name} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      <span className="text-[11px] text-slate-500">{ref.label(ref.roles, a.systemRole)}</span>
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={async () => {
                  close();
                  await logout();
                  navigate('/');
                }}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
