/** Client projects. Reads: any signed-in user. Writes: administrators. */
import { Router } from 'express';
import { withTransaction } from '../mongo.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, assertId, assertValid, isISODate, isUuid, str, uniqueViolation } from '../http.js';
import { lockDoc } from '../data.js';
import { CASE_INSENSITIVE } from '../models/common.js';
import { EmployeeModel } from '../models/employee.js';
import { AllocationModel, PROJECT_STATUSES, Project, type ProjectStatus } from '../models/project.js';
import { OvertimeRequestModel } from '../models/requests.js';
import { TimesheetEvent, TimesheetModel } from '../models/timesheet.js';

const STATUSES: readonly string[] = PROJECT_STATUSES;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

interface ProjectLean {
  _id: string;
  code: string;
  name: string;
  client: string;
  description?: string;
  managerId: string;
  startDate: string;
  endDate: string;
  status: ProjectStatus;
  billable: boolean;
  color: string;
  createdAt: Date;
}

/** Stored document → the Project shape the frontend expects (src/types/index.ts). */
const toProject = (d: ProjectLean) => ({
  id: d._id,
  code: d.code,
  name: d.name,
  client: d.client,
  description: d.description ?? '',
  managerId: d.managerId,
  startDate: d.startDate,
  endDate: d.endDate,
  status: d.status,
  billable: d.billable,
  color: d.color,
  createdAt: d.createdAt.toISOString(),
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
    status: STATUSES.includes(str(b.status)) ? (str(b.status) as ProjectStatus) : 'active',
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
  if (b.status !== undefined && !STATUSES.includes(str(b.status))) errors.status = 'Select a valid status.';
  if (!COLOR_RE.test(input.color)) errors.color = 'Select a colour.';
  if (!isISODate(input.startDate)) errors.startDate = 'Enter a valid start date.';
  if (!isISODate(input.endDate)) errors.endDate = 'Enter a valid end date.';
  else if (isISODate(input.startDate) && input.endDate < input.startDate) errors.endDate = 'End date must be on or after the start date.';

  if (!input.managerId) errors.managerId = 'Project manager is required.';
  else {
    const mgr = isUuid(input.managerId)
      ? await EmployeeModel.exists({ organisationId: orgId, _id: input.managerId, status: 'active', systemRole: { $in: ['manager', 'admin'] } })
      : null;
    if (!mgr) errors.managerId = 'Select an active project manager.';
  }

  assertValid(errors);
  return input;
}

function duplicateError(err: unknown): unknown {
  const index = uniqueViolation(err);
  if (index === 'projects_code_key') return new HttpError(409, 'Duplicate project.', { code: 'This project code is already used.' });
  if (index === 'projects_name_key') return new HttpError(409, 'Duplicate project.', { name: 'A project with this name already exists.' });
  return err;
}

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

/** GET /api/projects */
projectsRouter.get('/', async (_req, res) => {
  const docs = await Project.find({ organisationId: currentUser(res).organisationId }).collation(CASE_INSENSITIVE).sort({ name: 1 }).lean<ProjectLean[]>();
  res.json(docs.map(toProject));
});

/** GET /api/projects/:id */
projectsRouter.get('/:id', async (req, res) => {
  const id = assertId(req.params.id, 'Project');
  const doc = await Project.findOne({ organisationId: currentUser(res).organisationId, _id: id }).lean<ProjectLean>();
  if (!doc) throw new HttpError(404, 'Project not found.');
  res.json(toProject(doc));
});

/** POST /api/projects */
projectsRouter.post('/', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const p = await validateProject(org, req.body);
  try {
    const doc = await Project.create({ organisationId: org, ...p });
    res.status(201).json(toProject(doc.toObject() as unknown as ProjectLean));
  } catch (err) {
    throw duplicateError(err);
  }
});

/** PUT /api/projects/:id */
projectsRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Project');
  const p = await validateProject(org, req.body);
  let doc: ProjectLean | null;
  try {
    doc = await Project.findOneAndUpdate({ organisationId: org, _id: id }, { $set: p }, { returnDocument: 'after', runValidators: true }).lean<ProjectLean>();
  } catch (err) {
    throw duplicateError(err);
  }
  if (!doc) throw new HttpError(404, 'Project not found.');
  res.json(toProject(doc));
});

/** PATCH /api/projects/:id/status — activate / deactivate without editing other details. */
projectsRouter.patch('/:id/status', requireRole('admin'), async (req, res) => {
  const id = assertId(req.params.id, 'Project');
  const status = str(req.body?.status);
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Select a valid status.', { status: 'Select a valid status.' });
  const doc = await Project.findOneAndUpdate({ organisationId: currentUser(res).organisationId, _id: id }, { $set: { status } }, { returnDocument: 'after' }).lean<ProjectLean>();
  if (!doc) throw new HttpError(404, 'Project not found.');
  res.json(toProject(doc));
});

/** DELETE /api/projects/:id */
projectsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Project');
  await withTransaction(async (session) => {
    // Locking the project first means a concurrent request cannot start referencing it while it is being removed.
    if (!(await lockDoc(Project, { organisationId: org, _id: id }, session))) throw new HttpError(404, 'Project not found.');
    // MongoDB has no foreign keys, so the references a relational database would have enforced are checked here:
    // a project that is used anywhere is kept (deactivate it instead).
    // (Checked one after another: a session cannot run operations in parallel inside a transaction.)
    const used =
      (await AllocationModel.exists({ projectId: id }).session(session)) ||
      (await TimesheetModel.exists({ 'entries.projectId': id }).session(session)) ||
      (await TimesheetEvent.exists({ projectId: id }).session(session)) ||
      (await OvertimeRequestModel.exists({ projectId: id }).session(session));
    if (used) {
      throw new HttpError(409, 'This project has allocations or timesheet records and cannot be deleted. Deactivate it instead.');
    }
    await Project.deleteOne({ _id: id }).session(session);
  });
  res.status(204).end();
});
