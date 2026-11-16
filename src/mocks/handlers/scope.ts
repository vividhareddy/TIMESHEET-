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
