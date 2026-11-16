import { useMemo } from 'react';
import type { Employee } from '@/types';
import { useAppData } from '@/context/AppDataContext';
import { useCurrentUser, useManagedProjects } from './useLookups';
import { todayISO } from '@/utils/date';

/** Team for the current manager: people allocated to their projects plus direct reports. */
export function useTeam(): { team: Employee[]; projectIds: string[]; directReportIds: Set<string> } {
  const user = useCurrentUser();
  const projects = useManagedProjects();
  const { allocations, employees } = useAppData();
  return useMemo(() => {
    const projectIds = projects.map((p) => p.id);
    const today = todayISO();
    const allocated = new Set(allocations.filter((a) => projectIds.includes(a.projectId) && a.endDate >= today).map((a) => a.employeeId));
    const directReportIds = new Set(employees.filter((e) => e.managerId === user.id).map((e) => e.id));
    const team = employees.filter((e) => e.status === 'active' && (allocated.has(e.id) || directReportIds.has(e.id)) && e.id !== user.id);
    return { team, projectIds, directReportIds };
  }, [projects, allocations, employees, user.id]);
}
