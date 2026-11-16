import { Link } from 'react-router-dom';
import { CheckCircle2, Circle } from 'lucide-react';
import { useAppData } from '@/context/AppDataContext';
import { Card, CardBody, CardHeader } from './Card';
import { cn } from '@/utils/format';

/** First-run guidance for administrators while the database is still being populated. */
export function SetupChecklist() {
  const { lookups, calendars, employees, projects, allocations } = useAppData();
  const steps = [
    { done: lookups.departments.length > 0 && lookups.workLocations.length > 0, title: 'Add departments and work locations', to: '/admin/settings', cta: 'Settings' },
    { done: calendars.length > 0, title: 'Create holiday calendars and add holidays', to: '/admin/calendars', cta: 'Calendars' },
    { done: employees.some((e) => e.systemRole === 'manager'), title: 'Add project managers', to: '/admin/employees', cta: 'Employees' },
    { done: employees.some((e) => e.systemRole === 'associate'), title: 'Add associates', to: '/admin/employees', cta: 'Employees' },
    { done: projects.length > 0, title: 'Create projects and assign project managers', to: '/admin/projects', cta: 'Projects' },
    { done: allocations.length > 0, title: 'Allocate employees to projects', to: '/admin/allocations', cta: 'Allocations' },
  ];
  const remaining = steps.filter((s) => !s.done).length;
  if (remaining === 0) return null;

  return (
    <Card className="mb-6 border-brand-200">
      <CardHeader title="Set up your workspace" description={`${steps.length - remaining} of ${steps.length} steps complete. Dashboards fill in as real records are created.`} />
      <CardBody className="py-2">
        <ol className="divide-y divide-slate-100">
          {steps.map((s, i) => (
            <li key={s.title} className="flex items-center gap-3 py-2.5">
              {s.done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" /> : <Circle className="h-5 w-5 shrink-0 text-slate-300" />}
              <span className={cn('flex-1 text-sm', s.done ? 'text-slate-400 line-through' : 'text-slate-800')}>
                {i + 1}. {s.title}
              </span>
              {!s.done && (
                <Link to={s.to} className="text-xs font-medium text-brand-600 hover:text-brand-700">
                  Go to {s.cta}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
