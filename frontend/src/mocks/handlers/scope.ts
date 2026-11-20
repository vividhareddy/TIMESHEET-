/** Row-level visibility rules — the backend must enforce the same rules. */
import type { Employee } from '@/types';
import { todayISO } from '@/utils/date';
import { mockDb } from '../db';

export const db = () => mockDb.get();

export function managedProjectIds(user: Employee): Set<string> {
  return new Set(db().projects.filter((p) => p.managerId === user.id).map((p) => p.id));
}

/** Team = people allocated (now or in future) to the manager's projects, plus direct reports. */
export function teamEmployeeIds(user: Employee): Set<string> {
  const projects = managedProjectIds(user);
  const today = todayISO();
  const ids = new Set(db().allocations.filter((a) => projects.has(a.projectId) && a.endDate >= today).map((a) => a.employeeId));
  db().employees.filter((e) => e.managerId === user.id).forEach((e) => ids.add(e.id));
  ids.delete(user.id);
  return ids;
}

/** Employees whose operational records (timesheets, allocations, leave) the user may read. */
export function visibleEmployeeIds(user: Employee): Set<string> | 'all' {
  if (user.systemRole === 'admin') return 'all';
  if (user.systemRole === 'manager') return new Set([user.id, ...teamEmployeeIds(user)]);
  return new Set([user.id]);
}

export const canSee = (scope: Set<string> | 'all', employeeId: string) => scope === 'all' || scope.has(employeeId);

export function calendarOf(employee: Employee) {
  return db().calendars.find((c) => c.id === employee.calendarId);
}

/**
 * Colleagues whose leave can clash with the user's in [from, to]: people on the same projects in that period, people
 * with the same reporting manager, the user's manager and direct reports. Active employees only; never the user.
 */
export function leaveTeammateIds(user: Employee, from: string, to: string): Set<string> {
  const overlaps = (a: { startDate: string; endDate: string }) => a.startDate <= to && a.endDate >= from;
  const myProjects = new Set(db().allocations.filter((a) => a.employeeId === user.id && overlaps(a)).map((a) => a.projectId));
  const ids = new Set(db().allocations.filter((a) => myProjects.has(a.projectId) && overlaps(a)).map((a) => a.employeeId));
  for (const e of db().employees) {
    if (e.managerId === user.id || (user.managerId && (e.managerId === user.managerId || e.id === user.managerId))) ids.add(e.id);
  }
  ids.delete(user.id);
  return new Set([...ids].filter((id) => db().employees.find((e) => e.id === id)?.status === 'active'));
}
