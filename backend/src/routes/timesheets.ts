/**
 * Weekly timesheets and project-level approvals (rules mirror frontend/src/mocks/handlers/workflow.ts).
 *
 *  - One timesheet per employee per week (unique index); one entry per project, hours Mon..Sun.
 *  - Employees record time only on projects they are allocated to that week, inside the allocation dates.
 *  - Submitted (pending) and approved entries are locked until returned / rejected or reopened by an admin.
 *  - Each entry is approved by the manager of its project (admins may review any project).
 *  - Overtime is flagged into overtime_requests, separate from the ordinary hours.
 *
 * Inside a transaction every query carries the session and runs one after another (a session cannot
 * run operations in parallel).
 */
import { Router } from 'express';
import type { ClientSession } from 'mongoose';
import { uniqueViolation, withTransaction } from '../mongo.js';
import { currentUser, requireAuth, requireRole, type AuthUser } from '../auth.js';
import { HttpError, assertId, isISODate, isUuid, str } from '../http.js';
import {
  fetchTimesheets, isEntryLocked, loadAllocations, loadApprovedLeaves, loadCalendars, loadEmployees, lockDoc,
  type EntryLean, type Timesheet, type TimesheetEntry, type TimesheetLean, type Tx,
} from '../data.js';
import { Project } from '../models/project.js';
import { OvertimeRequestModel } from '../models/requests.js';
import { TimesheetEvent, TimesheetModel, type EVENT_ACTIONS } from '../models/timesheet.js';
import { canSee, managedProjectIds, visibleEmployeeIds } from '../scope.js';
import { readPolicy, readSettings, type OvertimePolicy } from './organisation.js';
import { addDays, currentWeekStart, startOfWeek, sum, weekDates } from '../lib/dates.js';
import { allocationsForWeek, computeOvertime, dailyTotals, entryTotal, expectedWeekHours, leaveHours } from '../lib/workCalc.js';

const MAX_DESCRIPTION = 2000;

function validateHours(hours: unknown, increment: number): number[] {
  if (!Array.isArray(hours) || hours.length !== 7) throw new HttpError(400, 'Each entry needs 7 daily values (Monday–Sunday).');
  return hours.map((h) => {
    const v = Number(h);
    if (!Number.isFinite(v) || v < 0 || v > 24) throw new HttpError(400, 'Daily hours must be between 0 and 24.');
    if (Math.abs(v / increment - Math.round(v / increment)) > 1e-9) throw new HttpError(400, `Hours must be in ${increment}-hour increments.`);
    return v;
  });
}

async function projectNames(org: string, tx?: Tx): Promise<Map<string, string>> {
  const docs = await Project.find({ organisationId: org }).select('name').session(tx ?? null).lean<Array<{ _id: string; name: string }>>();
  return new Map(docs.map((p) => [p._id, p.name]));
}

interface NewEvent {
  timesheetId: string;
  actorId: string;
  action: (typeof EVENT_ACTIONS)[number];
  projectId: string | null;
  comment: string | null;
}

async function addEvents(session: ClientSession, events: NewEvent[]): Promise<void> {
  if (events.length) await TimesheetEvent.insertMany(events, { session });
}

async function loadOne(org: string, id: string, tx?: Tx): Promise<Timesheet> {
  const ts = (await fetchTimesheets(org, { ids: [id] }, tx))[0];
  if (!ts) throw new HttpError(404, 'Timesheet not found.');
  return ts;
}

/** Keeps auto-flagged overtime records in step with the submitted hours (pending records only). */
async function syncOvertime(session: ClientSession, org: string, ts: Timesheet, policy: OvertimePolicy): Promise<void> {
  if (!policy.enabled || !policy.autoFlag) return;
  const employees = await loadEmployees(org, session);
  const emp = employees.get(ts.employeeId);
  const calendars = await loadCalendars(org, session);
  const breakdown = computeOvertime(ts.entries.filter((e) => e.status !== 'draft'), ts.weekStart, calendars.get(emp?.calendarId ?? ''), policy);
  for (const [projectId, hours] of Object.entries(breakdown.byProject)) {
    const existing = await OvertimeRequestModel.findOne({ timesheetId: ts.id, projectId, source: 'timesheet' }).select('status').session(session).lean<{ _id: string; status: string }>();
    if (!existing) {
      await OvertimeRequestModel.create(
        [{
          organisationId: org, employeeId: ts.employeeId, projectId, weekStart: ts.weekStart, hours,
          reason: 'Additional hours flagged automatically from the submitted timesheet.', source: 'timesheet', timesheetId: ts.id,
        }],
        { session },
      );
    } else if (existing.status === 'pending') {
      await OvertimeRequestModel.updateOne({ _id: existing._id }, { $set: { hours } }).session(session);
    }
  }
  await OvertimeRequestModel.deleteMany({ timesheetId: ts.id, source: 'timesheet', status: 'pending', projectId: { $nin: Object.keys(breakdown.byProject) } }).session(session);
}

/** Drops undefined keys so optional fields are simply absent in the stored document. */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

// ------------------------------------------------------------ save / submit

async function saveOwnTimesheet(user: AuthUser, body: unknown, submit: boolean): Promise<Timesheet> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isISODate(b.weekStart)) throw new HttpError(400, 'Week is required.', { weekStart: 'Week is required.' });
  if (b.entries !== undefined && !Array.isArray(b.entries)) throw new HttpError(400, 'Entries must be a list.');
  const weekStart = startOfWeek(b.weekStart);
  const minWeek = addDays(currentWeekStart(), -14);
  if (weekStart < minWeek || weekStart > currentWeekStart()) {
    throw new HttpError(400, 'Timesheets can only be saved for the current week or the two weeks before it.');
  }
  const weekEnd = addDays(weekStart, 6);
  const dates = weekDates(weekStart);
  const org = user.organisationId;
  const [settings, policy] = await Promise.all([readSettings(org), readPolicy(org)]);
  const inputs = (b.entries ?? []) as Array<Record<string, unknown>>;

  const run = () =>
    withTransaction(async (session) => {
      // Locking (or creating) the week's document serialises concurrent saves; the unique index on
      // (employeeId, weekStart) makes duplicate weekly timesheets impossible.
      let stored = await lockDoc<TimesheetLean>(TimesheetModel, { employeeId: user.id, weekStart }, session);
      if (!stored) {
        const [created] = await TimesheetModel.create([{ organisationId: org, employeeId: user.id, weekStart, entries: [] }], { session });
        stored = created!.toObject() as unknown as TimesheetLean;
      }
      const tsId = stored._id;
      const storedByProject = new Map<string, EntryLean>(stored.entries.map((e) => [e.projectId, e]));
      const existing = await loadOne(org, tsId, session);

      const allocations = allocationsForWeek(await loadAllocations(org, { from: weekStart, to: weekEnd, employeeIds: [user.id] }, session), user.id, weekStart);
      const allowed = new Set([...allocations.map((a) => a.projectId), ...existing.entries.map((e) => e.projectId)]);
      const names = await projectNames(org, session);
      const calendars = await loadCalendars(org, session);
      const calendar = calendars.get(user.calendarId);
      const leaves = (await loadApprovedLeaves(org, weekStart, weekEnd, session)).filter((l) => l.employeeId === user.id);

      const seen = new Set<string>();
      const entries: TimesheetEntry[] = inputs.map((input) => {
        const projectId = str(input.projectId);
        if (seen.has(projectId)) throw new HttpError(400, 'Each project can appear only once on a timesheet.');
        seen.add(projectId);
        if (!allowed.has(projectId)) throw new HttpError(403, 'You can only record time on projects you are allocated to for this week.');
        const prev = existing.entries.find((e) => e.projectId === projectId);
        if (prev && isEntryLocked(prev.status)) return prev; // locked entries are never changed by the employee
        const hours = validateHours(input.hours, settings.hourIncrement);
        const description = str(input.description);
        if (description.length > MAX_DESCRIPTION) throw new HttpError(400, `Work descriptions can be at most ${MAX_DESCRIPTION} characters.`);
        if (!settings.allowWeekendEntry && (hours[5]! > 0 || hours[6]! > 0)) throw new HttpError(400, 'Weekend entries are not allowed by your organisation.');

        // Hours only on days covered by an allocation to this project.
        const ranges = allocations.filter((a) => a.projectId === projectId);
        if (ranges.length) {
          const outside = dates.findIndex((d, i) => hours[i]! > 0 && !ranges.some((a) => a.startDate <= d && a.endDate >= d));
          if (outside >= 0) throw new HttpError(400, `${names.get(projectId) ?? 'This project'}: you are not allocated to it on ${dates[outside]}.`);
        }
        const { managerComment, originalHours, reviewedBy, reviewedAt } = prev ?? {};
        return { projectId, hours, description, status: prev?.status ?? 'draft', managerComment, originalHours, reviewedBy, reviewedAt } as TimesheetEntry;
      });
      // Locked entries omitted from the payload are preserved.
      for (const prev of existing.entries) if (isEntryLocked(prev.status) && !seen.has(prev.projectId)) entries.push(prev);

      const daily = dailyTotals(entries);
      if (daily.some((d) => d > 24)) throw new HttpError(400, 'A day cannot exceed 24 hours in total.');
      const fullLeaveDay = dates.findIndex((d, i) => daily[i]! > 0 && leaves.some((l) => l.date === d && l.duration === 'full'));
      if (fullLeaveDay >= 0) throw new HttpError(400, `You are on approved full-day leave on ${dates[fullLeaveDay]}, so no hours can be recorded that day.`);
      const halfDayCap = leaveHours(user, calendar, 'half');
      const halfLeaveDay = dates.findIndex((d, i) => daily[i]! > halfDayCap && leaves.some((l) => l.date === d && l.duration === 'half'));
      if (halfLeaveDay >= 0) throw new HttpError(400, `You are on approved half-day leave on ${dates[halfLeaveDay]}, so at most ${halfDayCap}h can be recorded that day.`);

      const wasSubmitted = existing.entries.some((e) => e.status !== 'draft');
      if (submit) {
        const editable = entries.filter((e) => !isEntryLocked(e.status));
        if (!editable.length) throw new HttpError(409, 'All entries for this week are already submitted.');
        if (sum(editable.map(entryTotal)) <= 0) throw new HttpError(400, 'Enter your project hours before submitting.');
        if (settings.requireDescription) {
          const missing = editable.find((e) => entryTotal(e) > 0 && !e.description);
          if (missing) {
            throw new HttpError(400, `Add a work description for ${names.get(missing.projectId) ?? 'a project'} before submitting.`, { [missing.projectId]: 'Description required.' });
          }
        }
        for (const e of editable) e.status = 'pending';

        // Overtime policy: weekly maximum and (optionally) mandatory pre-approval.
        if (policy.enabled) {
          const ot = computeOvertime(entries.filter((e) => e.status !== 'draft'), weekStart, calendar, policy);
          if (ot.total > policy.maxWeeklyOvertime) {
            throw new HttpError(400, `This week has ${ot.total} h of overtime, above your organisation's weekly maximum of ${policy.maxWeeklyOvertime} h.`);
          }
          if (policy.requirePreApproval) {
            const rows = await OvertimeRequestModel.find({ employeeId: user.id, weekStart, source: 'pre_approval', status: 'approved' })
              .select('projectId hours')
              .session(session)
              .lean<Array<{ projectId: string; hours: number }>>();
            const approved = new Map<string, number>();
            for (const r of rows) approved.set(r.projectId, sum([approved.get(r.projectId) ?? 0, r.hours]));
            for (const [projectId, hours] of Object.entries(ot.byProject)) {
              if (hours > (approved.get(projectId) ?? 0)) {
                throw new HttpError(400, `${names.get(projectId) ?? 'A project'} has ${hours} h of overtime this week. Your organisation requires an approved overtime request before submitting it.`);
              }
            }
          }
        }
      }

      // Persist the entries in display order. Hours, description and status come from this save;
      // review details (comment, original hours, reviewer) are carried over from the stored entry.
      const now = new Date();
      const toStore = entries.map((e) => {
        const prev = storedByProject.get(e.projectId);
        return defined({
          projectId: e.projectId,
          hours: e.hours,
          originalHours: prev?.originalHours?.length ? prev.originalHours : undefined,
          description: e.description,
          status: e.status,
          managerComment: prev?.managerComment ?? null,
          reviewedBy: prev?.reviewedBy ?? null,
          reviewedAt: prev?.reviewedAt ?? null,
          updatedAt: now,
        });
      });
      await TimesheetModel.updateOne({ _id: tsId }, { $set: { entries: toStore, ...(submit ? { submittedAt: now } : {}) } }, { session, runValidators: true });

      if (submit) {
        await addEvents(session, [{
          timesheetId: tsId, actorId: user.id, action: wasSubmitted ? 'resubmitted' : 'submitted', projectId: null,
          comment: wasSubmitted ? 'Corrections made and timesheet resubmitted.' : 'Weekly timesheet submitted.',
        }]);
      } else {
        // Only the latest draft save is kept in the history.
        await TimesheetEvent.deleteMany({ timesheetId: tsId, action: 'saved' }).session(session);
        await addEvents(session, [{ timesheetId: tsId, actorId: user.id, action: 'saved', projectId: null, comment: 'Draft saved.' }]);
      }

      const saved = await loadOne(org, tsId, session);
      if (submit) await syncOvertime(session, org, saved, policy);
      return saved;
    });

  try {
    return await run();
  } catch (err) {
    // Two first saves for the same week raced and the other one created the document: run again, now locking it.
    if (uniqueViolation(err) === 'timesheets_employee_week_key') return run();
    throw err;
  }
}

// ---------------------------------------------------------------- approvals

interface ReviewTarget {
  timesheet: TimesheetLean;
  entry: EntryLean;
}

/**
 * Locks the timesheets holding the given entries and checks the reviewer may act on each of them.
 * Returns one target per requested item, in order.
 */
async function lockEntriesForReview(session: ClientSession, user: AuthUser, items: Array<{ timesheetId?: unknown; projectId?: unknown }>): Promise<ReviewTarget[]> {
  const pairs = items.map((item) => {
    if (!isUuid(item.timesheetId) || !isUuid(item.projectId)) throw new HttpError(404, 'Timesheet entry not found.');
    return { timesheetId: item.timesheetId, projectId: item.projectId };
  });
  const timesheetIds = [...new Set(pairs.map((p) => p.timesheetId))];
  const filter = { organisationId: user.organisationId, _id: { $in: timesheetIds } };
  await TimesheetModel.updateMany(filter, { $inc: { __v: 1 } }, { session, timestamps: false });
  const sheets = new Map((await TimesheetModel.find(filter).session(session).lean<TimesheetLean[]>()).map((t) => [t._id, t]));
  const managers = new Map(
    (await Project.find({ _id: { $in: [...new Set(pairs.map((p) => p.projectId))] } }).select('managerId').session(session).lean<Array<{ _id: string; managerId: string }>>()).map((p) => [p._id, p.managerId]),
  );

  return pairs.map(({ timesheetId, projectId }) => {
    const timesheet = sheets.get(timesheetId);
    const entry = timesheet?.entries.find((e) => e.projectId === projectId);
    if (!timesheet || !entry || !managers.has(projectId)) throw new HttpError(404, 'Timesheet entry not found.');
    if (user.systemRole !== 'admin') {
      if (managers.get(projectId) !== user.id) throw new HttpError(403, 'Only the project manager of this project can review these hours.');
      if (timesheet.employeeId === user.id) throw new HttpError(403, 'You cannot review your own timesheet entries. An administrator must review them.');
    }
    return { timesheet, entry };
  });
}

export const timesheetsRouter = Router();
timesheetsRouter.use(requireAuth);

/** GET /api/timesheets?employeeId=&weekStart= — scoped to what the user may see. */
timesheetsRouter.get('/', async (req, res) => {
  const user = currentUser(res);
  const scope = await visibleEmployeeIds(user);
  const employeeId = str(req.query.employeeId);
  const weekStart = str(req.query.weekStart);
  if (employeeId && !canSee(scope, employeeId)) throw new HttpError(403, 'You do not have permission to view these timesheets.');
  if (weekStart && !isISODate(weekStart)) throw new HttpError(400, 'weekStart must be a date (YYYY-MM-DD).');
  const list = await fetchTimesheets(user.organisationId, {
    ...(employeeId ? { employeeIds: [employeeId] } : scope === 'all' ? {} : { employeeIds: [...scope] }),
    ...(weekStart ? { weekStart } : {}),
  });
  res.json(list);
});

timesheetsRouter.put('/me/draft', async (req, res) => {
  res.json(await saveOwnTimesheet(currentUser(res), req.body, false));
});

timesheetsRouter.post('/me/submit', async (req, res) => {
  res.json(await saveOwnTimesheet(currentUser(res), req.body, true));
});

/** GET /api/timesheets/:id */
timesheetsRouter.get('/:id', async (req, res) => {
  const user = currentUser(res);
  const ts = await loadOne(user.organisationId, assertId(req.params.id, 'Timesheet'));
  if (!canSee(await visibleEmployeeIds(user), ts.employeeId)) throw new HttpError(403, 'You do not have permission to view this timesheet.');
  res.json(ts);
});

/** POST /api/timesheets/:id/reopen — administrators return every entry for correction. */
timesheetsRouter.post('/:id/reopen', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Timesheet');
  const reason = str(req.body?.reason);
  if (!reason) throw new HttpError(400, 'Reason is required.', { reason: 'Reason is required.' });
  const ts = await withTransaction(async (session) => {
    const before = await lockDoc<TimesheetLean>(TimesheetModel, { organisationId: user.organisationId, _id: id }, session);
    if (!before) throw new HttpError(404, 'Timesheet not found.');
    if (before.entries.every((e) => e.status === 'draft')) throw new HttpError(409, 'This timesheet has not been submitted.');
    await TimesheetModel.updateOne(
      { _id: id },
      { $set: { 'entries.$[].status': 'returned', 'entries.$[].managerComment': reason, 'entries.$[].updatedAt': new Date() } },
      { session },
    );
    await addEvents(session, [{ timesheetId: id, actorId: user.id, action: 'reopened', projectId: null, comment: reason }]);
    return loadOne(user.organisationId, id, session);
  });
  res.json(ts);
});

export const approvalsRouter = Router();
approvalsRouter.use(requireAuth, requireRole('admin', 'manager'));

/** GET /api/approvals?status=&projectId=&weekStart= — entries on projects the user approves. */
approvalsRouter.get('/', async (req, res) => {
  const user = currentUser(res);
  const org = user.organisationId;
  const status = str(req.query.status) || 'pending';
  const projectId = str(req.query.projectId);
  const weekStart = str(req.query.weekStart);
  if (!['all', 'pending', 'approved', 'rejected', 'returned'].includes(status)) throw new HttpError(400, 'Unknown status filter.');
  if (weekStart && !isISODate(weekStart)) throw new HttpError(400, 'weekStart must be a date (YYYY-MM-DD).');
  if (projectId && !isUuid(projectId)) return void res.json([]);
  const scope = user.systemRole === 'admin' ? null : [...(await managedProjectIds(user))];

  // Timesheets holding at least one matching entry; the entries themselves are filtered below.
  const entryMatch: Record<string, unknown> = { status: status === 'all' ? { $ne: 'draft' } : status };
  if (scope || projectId) entryMatch.projectId = { ...(scope ? { $in: scope } : {}), ...(projectId ? { $eq: projectId } : {}) };
  const ids = (await TimesheetModel.distinct('_id', { organisationId: org, ...(weekStart ? { weekStart } : {}), entries: { $elemMatch: entryMatch } })) as string[];
  const timesheets = ids.length ? await fetchTimesheets(org, { ids }) : [];
  if (!timesheets.length) return void res.json([]);

  const weeks = timesheets.map((t) => t.weekStart).sort();
  const from = weeks[0]!;
  const to = addDays(weeks[weeks.length - 1]!, 6);
  const [employees, calendars, allocations, leaves, projects] = await Promise.all([
    loadEmployees(org),
    loadCalendars(org),
    loadAllocations(org, { from, to }),
    loadApprovedLeaves(org, from, to),
    Project.find({ organisationId: org }).select('name color').lean<Array<{ _id: string; name: string; color: string }>>(),
  ]);
  const projectById = new Map(projects.map((p) => [p._id, { id: p._id, name: p.name, color: p.color }]));
  const allowed = scope ? new Set(scope) : null;

  const items = [];
  for (const ts of timesheets) {
    const emp = employees.get(ts.employeeId);
    if (!emp) continue;
    const allocs = allocationsForWeek(allocations, emp.id, ts.weekStart);
    for (const entry of ts.entries) {
      if (entry.status === 'draft') continue;
      if (allowed && !allowed.has(entry.projectId)) continue;
      if (projectId && entry.projectId !== projectId) continue;
      if (status !== 'all' && entry.status !== status) continue;
      const project = projectById.get(entry.projectId);
      if (!project) continue;
      items.push({
        id: `${ts.id}|${entry.projectId}`,
        timesheetId: ts.id,
        weekStart: ts.weekStart,
        employee: { id: emp.id, name: emp.name, designation: emp.designation, weeklyCapacity: emp.weeklyCapacity, calendarId: emp.calendarId },
        project,
        entry,
        total: entryTotal(entry),
        allocation: allocs.find((a) => a.projectId === entry.projectId) ?? null,
        timesheetTotal: sum(ts.entries.map(entryTotal)),
        expectedHours: expectedWeekHours(emp, calendars.get(emp.calendarId), leaves, ts.weekStart),
        weekAllocatedHours: sum(allocs.map((a) => a.weeklyHours)),
        weekAllocationCount: allocs.length,
        history: ts.history.filter((h) => !h.projectId || h.projectId === entry.projectId),
      });
    }
  }
  items.sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.employee.name.localeCompare(b.employee.name));
  res.json(items);
});

/** POST /api/approvals/review — approve / reject / return entries (all-or-nothing). */
approvalsRouter.post('/review', async (req, res) => {
  const user = currentUser(res);
  const action = str(req.body?.action);
  const items = req.body?.items as Array<{ timesheetId?: unknown; projectId?: unknown }> | undefined;
  const comment = str(req.body?.comment) || null;
  if (!['approved', 'rejected', 'returned'].includes(action)) throw new HttpError(400, 'Unknown review action.');
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Select at least one entry.');
  if (items.length > 500) throw new HttpError(400, 'Review at most 500 entries at a time.');
  if (action !== 'approved' && !comment) throw new HttpError(400, 'A comment is required.', { comment: 'A comment is required.' });
  if (comment && comment.length > MAX_DESCRIPTION) throw new HttpError(400, 'The comment is too long.', { comment: `Use at most ${MAX_DESCRIPTION} characters.` });

  const updated = await withTransaction(async (session) => {
    // Validate everything first so the batch is all-or-nothing.
    const targets = await lockEntriesForReview(session, user, items);
    if (targets.some((t) => t.entry.status !== 'pending')) throw new HttpError(409, 'One or more entries are no longer pending. Refresh and try again.');

    const now = new Date();
    await TimesheetModel.bulkWrite(
      targets.map(({ timesheet, entry }) => ({
        updateOne: {
          filter: { _id: timesheet._id, 'entries.projectId': entry.projectId },
          update: {
            $set: {
              'entries.$.status': action,
              'entries.$.reviewedBy': user.id,
              'entries.$.reviewedAt': now,
              'entries.$.updatedAt': now,
              ...(comment ? { 'entries.$.managerComment': comment } : {}),
            },
          },
        },
      })),
      { session, ordered: true },
    );
    await addEvents(session, targets.map(({ timesheet, entry }) => ({ timesheetId: timesheet._id, actorId: user.id, action: action as 'approved' | 'rejected' | 'returned', projectId: entry.projectId, comment })));
    // Rejecting hours also rejects their auto-flagged overtime.
    if (action === 'rejected') {
      await OvertimeRequestModel.updateMany(
        { status: 'pending', $or: targets.map(({ timesheet, entry }) => ({ timesheetId: timesheet._id, projectId: entry.projectId })) },
        { $set: { status: 'rejected', reviewerId: user.id, reviewerComment: 'Underlying timesheet hours were rejected.', reviewedAt: now } },
        { session },
      );
    }
    return items.length;
  });
  res.json({ updated });
});

/** POST /api/approvals/modify — the approver corrects pending hours, with a mandatory reason. */
approvalsRouter.post('/modify', async (req, res) => {
  const user = currentUser(res);
  const org = user.organisationId;
  const reason = str(req.body?.reason);
  if (!reason) throw new HttpError(400, 'A reason is required to modify hours.', { reason: 'A reason is required to modify hours.' });
  const [settings, policy] = await Promise.all([readSettings(org), readPolicy(org)]);
  const hours = validateHours(req.body?.hours, settings.hourIncrement);
  const ts = await withTransaction(async (session) => {
    const [target] = await lockEntriesForReview(session, user, [{ timesheetId: req.body?.timesheetId, projectId: req.body?.projectId }]);
    const { timesheet, entry } = target!;
    if (entry.status !== 'pending') throw new HttpError(409, 'Only pending entries can be modified.');
    const others = timesheet.entries.filter((e) => e.projectId !== entry.projectId);
    const daily = dailyTotals([...others.map((o) => ({ projectId: '', hours: o.hours })), { projectId: entry.projectId, hours }]);
    if (daily.some((d) => d > 24)) throw new HttpError(400, 'A day cannot exceed 24 hours in total.');
    await TimesheetModel.updateOne(
      { _id: timesheet._id, 'entries.projectId': entry.projectId },
      {
        $set: {
          // The employee's own hours are kept the first time an approver changes them.
          'entries.$.originalHours': entry.originalHours?.length ? entry.originalHours : entry.hours,
          'entries.$.hours': hours,
          'entries.$.managerComment': reason,
          'entries.$.updatedAt': new Date(),
        },
      },
      { session },
    );
    await addEvents(session, [{ timesheetId: timesheet._id, actorId: user.id, action: 'modified', projectId: entry.projectId, comment: reason }]);
    const saved = await loadOne(org, timesheet._id, session);
    await syncOvertime(session, org, saved, policy);
    return saved;
  });
  res.json(ts);
});
