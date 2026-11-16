import { NavLink } from 'react-router-dom';
import { Clock3, X } from 'lucide-react';
import type { Role } from '@/types';
import { NAVIGATION } from '@/routes/navigation';
import { useReferenceData } from '@/hooks/useLookups';
import { IS_MOCK_MODE } from '@/services';
import { useNotifications } from '@/hooks/useNotifications';
import { useAppData } from '@/context/AppDataContext';
import { cn } from '@/utils/format';

interface SidebarProps {
  role: Role;
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ role, open, onClose }: SidebarProps) {
  const { counts } = useNotifications();
  const { settings } = useAppData();
  const ref = useReferenceData();

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-sidebar text-slate-300 transition-transform lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between gap-2 border-b border-sidebar-border px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-600 text-white">
              <Clock3 className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-white">TimeTrack Pro</p>
              <p className="truncate text-[11px] text-sidebar-muted">{settings.organisationName}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-sidebar-muted hover:bg-sidebar-hover hover:text-white lg:hidden" aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 pb-2 pt-5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted">{ref.label(ref.roles, role)} workspace</div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
          {NAVIGATION[role].map((item) => {
            const count = item.badgeKey ? counts[item.badgeKey] : 0;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={onClose}
                className={({ isActive }) =>
                  cn(
                    'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive ? 'bg-sidebar-active text-white' : 'text-slate-300 hover:bg-sidebar-hover hover:text-white',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute left-0 top-1.5 h-[calc(100%-12px)] w-[3px] rounded-r bg-brand-200" />}
                    <item.icon className={cn('h-[18px] w-[18px] shrink-0', isActive ? 'text-brand-200' : 'text-sidebar-muted group-hover:text-slate-200')} />
                    <span className="flex-1 truncate">{item.label}</span>
                    {count > 0 && (
                      <span className="rounded-full bg-brand-500/90 px-1.5 py-px text-[10px] font-semibold tabular-nums text-white">{count}</span>
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>
        {IS_MOCK_MODE && <div className="border-t border-sidebar-border px-5 py-3 text-[11px] text-amber-300">Development mock API — data is not real</div>}
      </aside>
    </>
  );
}
