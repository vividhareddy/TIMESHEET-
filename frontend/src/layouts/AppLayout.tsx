import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Info } from 'lucide-react';
import type { Role } from '@/types';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { Topbar } from '@/components/sidebar/Topbar';
import { Alert } from '@/components/common/Misc';
import { useOptionalAppData } from '@/context/AppDataContext';
import { AssistantWidget } from '@/components/assistant/AssistantWidget';

export function AppLayout({ role }: { role: Role }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const unavailable = useOptionalAppData()?.unavailableModules ?? [];
  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar role={role} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="lg:pl-60">
        <Topbar onMenu={() => setMenuOpen(true)} />
        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
          {unavailable.length > 0 && (
            <Alert tone="info" icon={Info} className="mb-5" title="Some modules are not connected yet">
              {unavailable.join(', ')} {unavailable.length === 1 ? 'is' : 'are'} not yet available on the server, so {unavailable.length === 1 ? 'it shows' : 'they show'} no records. Everything else is live.
            </Alert>
          )}
          <Outlet />
        </main>
      </div>
      <AssistantWidget role={role} />
    </div>
  );
}
