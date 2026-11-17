/**
 * Row-level visibility rules (same rules as frontend/src/mocks/handlers/scope.ts):
 *  - associates see only their own operational records;
 *  - managers see their projects' records plus their team;
 *  - administrators see everything in their organisation.
 */
import type { AuthUser } from './auth.js';
import type { Tx } from './data.js';
import { EmployeeModel } from './models/employee.js';
import { AllocationModel, Project } from './models/project.js';
import { todayISO } from './lib/dates.js';

export async function managedProjectIds(user: AuthUser, tx?: Tx): Promise<Set<string>> {
  const ids = await Project.distinct('_id', { organisationId: user.organisationId, managerId: user.id }).session(tx ?? null);
  return new Set(ids as string[]);
}

/** Direct reports of the user. */
export async function directReportIds(user: AuthUser, tx?: Tx): Promise<Set<string>> {
  const ids = await EmployeeModel.distinct('_id', { organisationId: user.organisationId, managerId: user.id }).session(tx ?? null);
  return new Set(ids as string[]);
}

/** Team = people allocated (now or in future) to the manager's projects, plus direct reports. */
export async function teamEmployeeIds(user: AuthUser, tx?: Tx): Promise<Set<string>> {
  const [projects, reports] = await Promise.all([managedProjectIds(user, tx), directReportIds(user, tx)]);
  const allocated = projects.size
    ? await AllocationModel.distinct('employeeId', { organisationId: user.organisationId, projectId: { $in: [...projects] }, endDate: { $gte: todayISO() } }).session(tx ?? null)
    : [];
  const ids = new Set<string>([...(allocated as string[]), ...reports]);
  ids.delete(user.id);
  return ids;
}

/** Employees whose operational records (timesheets, allocations, leave) the user may read. */
export async function visibleEmployeeIds(user: AuthUser, tx?: Tx): Promise<Set<string> | 'all'> {
  if (user.systemRole === 'admin') return 'all';
  if (user.systemRole === 'manager') return new Set([user.id, ...(await teamEmployeeIds(user, tx))]);
  return new Set([user.id]);
}

export const canSee = (scope: Set<string> | 'all', employeeId: string): boolean => scope === 'all' || scope.has(employeeId);
