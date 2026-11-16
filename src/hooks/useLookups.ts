import { useMemo } from 'react';
import type { Employee, Project, ReferenceData, SelectOption, WorkCalendar } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useSession } from '@/context/SessionContext';

/** Fast id → entity lookups over records fetched from the API. */
export function useLookups() {
  const { employees, projects, calendars } = useAppData();
  return useMemo(() => {
    const empMap = new Map(employees.map((e) => [e.id, e]));
    const projMap = new Map(projects.map((p) => [p.id, p]));
    const calMap = new Map(calendars.map((c) => [c.id, c]));
    return {
      employee: (id?: string | null): Employee | undefined => (id ? empMap.get(id) : undefined),
      employeeName: (id?: string | null): string => (id ? empMap.get(id)?.name ?? 'Unknown' : '—'),
      project: (id?: string): Project | undefined => (id ? projMap.get(id) : undefined),
      projectName: (id?: string): string => (id ? projMap.get(id)?.name ?? 'Unknown' : '—'),
      calendar: (id?: string): WorkCalendar | undefined => (id ? calMap.get(id) : undefined),
      calendarOf: (emp?: Employee): WorkCalendar | undefined => (emp ? calMap.get(emp.calendarId) : undefined),
    };
  }, [employees, projects, calendars]);
}

/**
 * The signed-in user as returned by the API. Prefers the freshest copy from the employee list
 * (e.g. after an admin edits their own record). Only used inside authenticated routes.
 */
export function useCurrentUser(): Employee {
  const { user } = useSession();
  const { employees } = useAppData();
  if (!user) throw new Error('useCurrentUser requires an authenticated session');
  return useMemo(() => employees.find((e) => e.id === user.id) ?? user, [employees, user]);
}

/** Projects managed by the signed-in user (manager role). */
export function useManagedProjects(): Project[] {
  const user = useCurrentUser();
  const { projects } = useAppData();
  return useMemo(() => projects.filter((p) => p.managerId === user.id), [projects, user.id]);
}

/** Option lists from GET /lookups, plus label helpers. */
export function useReferenceData(): ReferenceData & { label: <T extends string>(options: SelectOption<T>[], value: T) => string } {
  const { lookups } = useAppData();
  return useMemo(
    () => ({
      ...lookups,
      label: <T extends string>(options: SelectOption<T>[], value: T) => options.find((o) => o.value === value)?.label ?? value,
    }),
    [lookups],
  );
}
