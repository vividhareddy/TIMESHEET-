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

/**
 * Colleagues whose leave can clash with the user's in [from, to], for planning leave:
 * people allocated to the same projects in that period, people with the same reporting manager,
 * the user's manager and the user's direct reports. Active employees only; never the user.
 */
export async function leaveTeammateIds(user: AuthUser, from: string, to: string, tx?: Tx): Promise<Set<string>> {
  const org = user.organisationId;
  const overlapping = { startDate: { $lte: to }, endDate: { $gte: from } };
  const myProjects = (await AllocationModel.distinct('projectId', { organisationId: org, employeeId: user.id, ...overlapping }).session(tx ?? null)) as string[];
  const [projectPeers, related] = await Promise.all([
    myProjects.length
      ? (AllocationModel.distinct('employeeId', { organisationId: org, projectId: { $in: myProjects }, ...overlapping }).session(tx ?? null) as Promise<string[]>)
      : Promise.resolve([] as string[]),
    EmployeeModel.distinct('_id', {
      organisationId: org,
      $or: [{ managerId: user.id }, ...(user.managerId ? [{ managerId: user.managerId }, { _id: user.managerId }] : [])],
    }).session(tx ?? null) as Promise<string[]>,
  ]);
  const candidates = [...new Set([...projectPeers, ...related])].filter((id) => id !== user.id);
  if (!candidates.length) return new Set();
  const active = (await EmployeeModel.distinct('_id', { organisationId: org, _id: { $in: candidates }, status: 'active' }).session(tx ?? null)) as string[];
  return new Set(active);
}
