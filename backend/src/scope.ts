/**
 * Row-level visibility rules (same rules as frontend/src/mocks/handlers/scope.ts):
 *  - associates see only their own operational records;
 *  - managers see their projects' records plus their team;
 *  - administrators see everything in their organisation.
 */
import type { AuthUser } from './auth.js';
import type { Db } from './db.js';

export async function managedProjectIds(db: Db, user: AuthUser): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM projects WHERE organisation_id = $1 AND manager_id = $2', [user.organisationId, user.id]);
  return new Set(rows.map((r) => r.id));
}

/** Team = people allocated (now or in future) to the manager's projects, plus direct reports. */
export async function teamEmployeeIds(db: Db, user: AuthUser): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.employee_id AS id FROM allocations a JOIN projects p ON p.id = a.project_id
      WHERE a.organisation_id = $1 AND p.manager_id = $2 AND a.end_date >= CURRENT_DATE
     UNION
     SELECT id FROM employees WHERE organisation_id = $1 AND manager_id = $2`,
    [user.organisationId, user.id],
  );
  const ids = new Set(rows.map((r) => r.id));
  ids.delete(user.id);
  return ids;
}

/** Employees whose operational records (timesheets, allocations, leave) the user may read. */
export async function visibleEmployeeIds(db: Db, user: AuthUser): Promise<Set<string> | 'all'> {
  if (user.systemRole === 'admin') return 'all';
  if (user.systemRole === 'manager') return new Set([user.id, ...(await teamEmployeeIds(db, user))]);
  return new Set([user.id]);
}

export const canSee = (scope: Set<string> | 'all', employeeId: string): boolean => scope === 'all' || scope.has(employeeId);

/** Direct reports of the user. */
export async function directReportIds(db: Db, user: AuthUser): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM employees WHERE organisation_id = $1 AND manager_id = $2', [user.organisationId, user.id]);
  return new Set(rows.map((r) => r.id));
}
