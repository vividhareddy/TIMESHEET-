/** Client projects. Reads: any signed-in user. Writes: administrators. */
import { Router } from 'express';
import { pool } from '../db.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, assertId, assertValid, isISODate, isUuid, str, uniqueViolation } from '../http.js';

const STATUSES = ['active', 'on_hold', 'completed', 'inactive'] as const;
type ProjectStatus = (typeof STATUSES)[number];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  client: string;
  description: string;
  manager_id: string;
  start_date: string;
  end_date: string;
  status: ProjectStatus;
  billable: boolean;
  color: string;
  created_at: Date;
}

const PROJECT_COLUMNS = `id, code, name, client, description, manager_id,
  to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
  status, billable, color, created_at`;

/** Database row → the Project shape the frontend expects (src/types/index.ts). */
const toProject = (r: ProjectRow) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  client: r.client,
  description: r.description,
  managerId: r.manager_id,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
  billable: r.billable,
  color: r.color,
  createdAt: r.created_at.toISOString(),
});

interface ProjectInput {
  code: string;
  name: string;
  client: string;
  description: string;
  managerId: string;
  startDate: string;
  endDate: string;
  status: ProjectStatus;
  billable: boolean;
  color: string;
}

async function validateProject(orgId: string, body: unknown): Promise<ProjectInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const input: ProjectInput = {
    code: str(b.code).toUpperCase(),
    name: str(b.name),
    client: str(b.client),
    description: str(b.description),
    managerId: str(b.managerId),
    startDate: str(b.startDate),
    endDate: str(b.endDate),
    status: (STATUSES as readonly string[]).includes(str(b.status)) ? (str(b.status) as ProjectStatus) : 'active',
    billable: b.billable !== false,
    color: str(b.color),
  };

  if (!input.name) errors.name = 'Project name is required.';
  else if (input.name.length > 150) errors.name = 'Use at most 150 characters.';
  if (!input.code) errors.code = 'Project code is required.';
  else if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(input.code)) errors.code = 'Use up to 20 letters, digits, "-" or "_".';
  if (!input.client) errors.client = 'Client is required.';
  else if (input.client.length > 150) errors.client = 'Use at most 150 characters.';
  if (input.description.length > 2000) errors.description = 'Use at most 2000 characters.';
  if (b.status !== undefined && !(STATUSES as readonly string[]).includes(str(b.status))) errors.status = 'Select a valid status.';
  if (!COLOR_RE.test(input.color)) errors.color = 'Select a colour.';
  if (!isISODate(input.startDate)) errors.startDate = 'Enter a valid start date.';
  if (!isISODate(input.endDate)) errors.endDate = 'Enter a valid end date.';
  else if (isISODate(input.startDate) && input.endDate < input.startDate) errors.endDate = 'End date must be on or after the start date.';

  if (!input.managerId) errors.managerId = 'Project manager is required.';
  else {
    const mgr = isUuid(input.managerId)
      ? await pool.query(
          "SELECT 1 FROM employees WHERE organisation_id = $1 AND id = $2 AND status = 'active' AND system_role IN ('manager', 'admin')",
          [orgId, input.managerId],
        )
      : null;
    if (!mgr?.rowCount) errors.managerId = 'Select an active project manager.';
  }

  assertValid(errors);
  return input;
}

function duplicateError(err: unknown): unknown {
  const constraint = uniqueViolation(err);
  if (constraint === 'projects_code_key') return new HttpError(409, 'Duplicate project.', { code: 'This project code is already used.' });
  if (constraint === 'projects_name_key') return new HttpError(409, 'Duplicate project.', { name: 'A project with this name already exists.' });
  return err;
}

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

/** GET /api/projects */
projectsRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE organisation_id = $1 ORDER BY lower(name)`,
    [currentUser(res).organisationId],
  );
  res.json(rows.map(toProject));
});

/** GET /api/projects/:id */
projectsRouter.get('/:id', async (req, res) => {
  const id = assertId(req.params.id, 'Project');
  const { rows } = await pool.query<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE organisation_id = $1 AND id = $2`, [
    currentUser(res).organisationId,
    id,
  ]);
  if (!rows[0]) throw new HttpError(404, 'Project not found.');
  res.json(toProject(rows[0]));
});

/** POST /api/projects */
projectsRouter.post('/', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const p = await validateProject(org, req.body);
  const { rows } = await pool
    .query<ProjectRow>(
      `INSERT INTO projects (organisation_id, code, name, client, description, manager_id, start_date, end_date, status, billable, color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${PROJECT_COLUMNS}`,
      [org, p.code, p.name, p.client, p.description, p.managerId, p.startDate, p.endDate, p.status, p.billable, p.color],
    )
    .catch((err) => Promise.reject(duplicateError(err)));
  res.status(201).json(toProject(rows[0]!));
});

/** PUT /api/projects/:id */
projectsRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Project');
  const p = await validateProject(org, req.body);
  const { rows } = await pool
    .query<ProjectRow>(
      `UPDATE projects SET code = $3, name = $4, client = $5, description = $6, manager_id = $7, start_date = $8,
         end_date = $9, status = $10, billable = $11, color = $12, updated_at = now()
       WHERE organisation_id = $1 AND id = $2 RETURNING ${PROJECT_COLUMNS}`,
      [org, id, p.code, p.name, p.client, p.description, p.managerId, p.startDate, p.endDate, p.status, p.billable, p.color],
    )
    .catch((err) => Promise.reject(duplicateError(err)));
  if (!rows[0]) throw new HttpError(404, 'Project not found.');
  res.json(toProject(rows[0]));
});

/** PATCH /api/projects/:id/status — activate / deactivate without editing other details. */
projectsRouter.patch('/:id/status', requireRole('admin'), async (req, res) => {
  const id = assertId(req.params.id, 'Project');
  const status = str(req.body?.status);
  if (!(STATUSES as readonly string[]).includes(status)) throw new HttpError(400, 'Select a valid status.', { status: 'Select a valid status.' });
  const { rows } = await pool.query<ProjectRow>(
    `UPDATE projects SET status = $3, updated_at = now() WHERE organisation_id = $1 AND id = $2 RETURNING ${PROJECT_COLUMNS}`,
    [currentUser(res).organisationId, id, status],
  );
  if (!rows[0]) throw new HttpError(404, 'Project not found.');
  res.json(toProject(rows[0]));
});

/** DELETE /api/projects/:id */
projectsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = assertId(req.params.id, 'Project');
  try {
    const result = await pool.query('DELETE FROM projects WHERE organisation_id = $1 AND id = $2', [currentUser(res).organisationId, id]);
    if (!result.rowCount) throw new HttpError(404, 'Project not found.');
  } catch (err) {
    // Once allocations / timesheets reference projects, deleting a used project is refused (deactivate it instead).
    if ((err as { code?: string }).code === '23503') {
      throw new HttpError(409, 'This project has allocations or timesheet records and cannot be deleted. Deactivate it instead.');
    }
    throw err;
  }
  res.status(204).end();
});
