import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { useSession } from '@/context/SessionContext';
import { homePath } from '@/routes/navigation';

export function NotFoundPage() {
  const { user } = useSession();
  const role = user?.systemRole;
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <Compass className="h-6 w-6" />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-slate-900">Page not found</h1>
      <p className="mt-1 text-sm text-slate-500">The page you're looking for doesn't exist or has moved.</p>
      <Link to={role ? homePath(role) : '/'} className="mt-5 text-sm font-medium text-brand-600 hover:text-brand-700">
        Go to dashboard
      </Link>
    </div>
  );
}
