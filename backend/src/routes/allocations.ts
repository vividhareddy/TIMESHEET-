/**
 * Resource allocations. Reads are scoped by role (associates: own; managers: their projects + team;
 * admins: all). Writes: administrators, or the project manager of the project.
 */
import { Router } from 'express';
import type { ClientSession } from 'mongoose';
import { withTransaction } from '../mongo.js';
import { currentUser, requireAuth, requireRole, type AuthUser } from '../auth.js';
import { HttpError, assertId, assertValid, isISODate, isUuid, str } from '../http.js';
import { lockDoc, toAllocation, type AllocationLean } from '../data.js';
import { EmployeeModel } from '../models/employee.js';
import { AllocationModel, Project } from '../models/project.js';
import { TimesheetModel } from '../models/timesheet.js';
import { managedProjectIds, teamEmployeeIds } from '../scope.js';
import { addDays } from '../lib/dates.js';

interface AllocationInput {
  employeeId: string;
  projectId: string;
  projectRole: string;
  weeklyHours: number;
  startDate: string;
  endDate: string;
}

interface ProjectRef {
  managerId: string;
  status: string;
  startDate: string;
  endDate: string;
}

function assertCanManageProject(user: AuthUser, project: ProjectRef | null): void {
  if (user.systemRole === 'admin') return;
  if (!project || project.managerId !== user.id) throw new HttpError(403, 'You can only allocate resources to projects you manage.');
}

/** First and last week (Monday) in which the employee recorded hours on the project within [from, to]. */
async function loggedWeeks(session: ClientSession, employeeId: string, projectId: string, from: string, to: string) {
  const weeks = await TimesheetModel.distinct('weekStart', {
    employeeId,
    weekStart: { $gte: addDays(from, -6), $lte: to },
    // An entry for this project with at least one day above zero.
    entries: { $elemMatch: { projectId, hours: { $gt: 0 } } },
  }).session(session);
  const sorted = (weeks as string[]).sort();
  return { first: sorted[0] ?? null, last: sorted[sorted.length - 1] ?? null };
}

/**
 * Validates an allocation. Runs inside a transaction holding locks on the employee and the project,
 * so two concurrent requests cannot both create overlapping allocations, and a project cannot be
 * deleted while an allocation to it is being created.
 */
async function validateAllocation(session: ClientSession, user: AuthUser, body: unknown, id: string | null): Promise<AllocationInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const input: AllocationInput = {
    employeeId: str(b.employeeId),
    projectId: str(b.projectId),
    projectRole: str(b.projectRole) || 'Team member',
    weeklyHours: Number(b.weeklyHours),
    startDate: str(b.startDate),
    endDate: str(b.endDate),
  };
  const errors: Record<string, string> = {};
  const org = user.organisationId;

  if (!isUuid(input.projectId)) throw new HttpError(400, 'Please correct the highlighted fields.', { projectId: 'Select a project.' });
  const project = await lockDoc<ProjectRef>(Project, { organisationId: org, _id: input.projectId }, session);
  assertCanManageProject(user, project);

  const emp = isUuid(input.employeeId) ? await lockDoc<{ status: string }>(EmployeeModel, { organisationId: org, _id: input.employeeId }, session) : null;
  if (!emp || emp.status !== 'active') errors.employeeId = 'Select an active employee.';

  if (!project) errors.projectId = 'Select a project.';
  else if (project.status !== 'active' && !id) errors.projectId = 'Allocations can only be added to active projects.';

  if (input.projectRole.length > 100) errors.projectRole = 'Use at most 100 characters.';
  if (!(input.weeklyHours > 0 && input.weeklyHours <= 60)) errors.weeklyHours = 'Enter between 0.5 and 60 hours.';
  else if ((input.weeklyHours * 2) % 1 !== 0) errors.weeklyHours = 'Use 0.5-hour increments.';
  if (!isISODate(input.startDate)) errors.startDate = 'Enter a valid start date.';
  if (!isISODate(input.endDate)) errors.endDate = 'Enter a valid end date.';
  else if (isISODate(input.startDate) && input.endDate < input.startDate) errors.endDate = 'End date must be after the start date.';
  else if (project && isISODate(input.startDate) && (input.startDate < project.startDate || input.endDate > project.endDate)) {
    errors.endDate = `Must fall within the project dates (${project.startDate} to ${project.endDate}).`;
  }
  assertValid(errors);

  const overlap = await AllocationModel.exists({
    employeeId: input.employeeId,
    projectId: input.projectId,
    ...(id ? { _id: { $ne: id } } : {}),
    startDate: { $lte: input.endDate },
    endDate: { $gte: input.startDate },
  }).session(session);
  if (overlap) throw new HttpError(409, 'Overlapping allocation.', { projectId: 'This employee already has an overlapping allocation to this project.' });
  return input;
}

export const allocationsRouter = Router();
allocationsRouter.use(requireAuth);

/** GET /api/allocations?employeeId=&projectId= */
allocationsRouter.get('/', async (req, res) => {
  const user = currentUser(res);
  const docs = await AllocationModel.find({ organisationId: user.organisationId }).sort({ startDate: 1, _id: 1 }).lean<AllocationLean[]>();
  let list = docs.map(toAllocation);
  if (user.systemRole === 'manager') {
    // Own projects + every allocation of team members (needed to show their full capacity).
    const [projects, team] = await Promise.all([managedProjectIds(user), teamEmployeeIds(user)]);
    list = list.filter((a) => projects.has(a.projectId) || team.has(a.employeeId) || a.employeeId === user.id);
  } else if (user.systemRole === 'associate') {
    list = list.filter((a) => a.employeeId === user.id);
  }
  const employeeId = str(req.query.employeeId);
  const projectId = str(req.query.projectId);
  if (employeeId) list = list.filter((a) => a.employeeId === employeeId);
  if (projectId) list = list.filter((a) => a.projectId === projectId);
  res.json(list);
});

/** POST /api/allocations */
allocationsRouter.post('/', requireRole('admin', 'manager'), async (req, res) => {
  const user = currentUser(res);
  const row = await withTransaction(async (session) => {
    const a = await validateAllocation(session, user, req.body, null);
    const [doc] = await AllocationModel.create([{ ...a, organisationId: user.organisationId, createdBy: user.id }], { session });
    return doc!.toObject() as unknown as AllocationLean;
  });
  res.status(201).json(toAllocation(row));
});

/** PUT /api/allocations/:id — employee and project are fixed; role, hours and dates can change. */
allocationsRouter.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Allocation');
  const row = await withTransaction(async (session) => {
    const existing = await lockDoc<AllocationLean>(AllocationModel, { organisationId: user.organisationId, _id: id }, session);
    if (!existing) throw new HttpError(404, 'Allocation not found.');
    const a = await validateAllocation(session, user, { ...(req.body ?? {}), employeeId: existing.employeeId, projectId: existing.projectId }, id);

    // Recorded time must stay inside the allocation.
    const logged = await loggedWeeks(session, existing.employeeId, existing.projectId, existing.startDate, existing.endDate);
    if (logged.last && a.endDate < logged.last) {
      throw new HttpError(409, `Time is already recorded on this allocation in the week of ${logged.last}.`, { endDate: `Must be on or after ${logged.last}.` });
    }
    if (logged.first && a.startDate > addDays(logged.first, 6)) {
      throw new HttpError(409, `Time is already recorded on this allocation in the week of ${logged.first}.`, { startDate: `Must be on or before ${addDays(logged.first, 6)}.` });
    }

    const doc = await AllocationModel.findOneAndUpdate(
      { organisationId: user.organisationId, _id: id },
      { $set: { projectRole: a.projectRole, weeklyHours: a.weeklyHours, startDate: a.startDate, endDate: a.endDate } },
      { session, returnDocument: 'after', runValidators: true },
    ).lean<AllocationLean>();
    return doc!;
  });
  res.json(toAllocation(row));
});

/** DELETE /api/allocations/:id — only while no time has been recorded against it (shorten it instead). */
allocationsRouter.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Allocation');
  await withTransaction(async (session) => {
    const a = await lockDoc<AllocationLean>(AllocationModel, { organisationId: user.organisationId, _id: id }, session);
    if (!a) throw new HttpError(404, 'Allocation not found.');
    const project = await Project.findOne({ organisationId: user.organisationId, _id: a.projectId }).session(session).lean<ProjectRef>();
    assertCanManageProject(user, project);
    const logged = await loggedWeeks(session, a.employeeId, a.projectId, a.startDate, a.endDate);
    if (logged.first) throw new HttpError(409, 'Time has already been recorded on this allocation, so it is kept for history. Change its end date instead.');
    await AllocationModel.deleteOne({ _id: id }).session(session);
  });
  res.status(204).end();
});
