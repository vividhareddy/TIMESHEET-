/**
 * Weekly timesheets and project-level approvals (rules mirror frontend/src/mocks/handlers/workflow.ts).
 *
 *  - One timesheet per employee per week (unique constraint); one entry per project, hours Mon..Sun.
 *  - Employees record time only on projects they are allocated to that week, inside the allocation dates.
 *  - Submitted (pending) and approved entries are locked until returned / rejected or reopened by an admin.
 *  - Each entry is approved by the manager of its project (admins may review any project).
 *  - Overtime is flagged into overtime_requests, separate from the ordinary hours.
 */
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { pool, withTransaction, type Db } from '../db.js';
import { currentUser, requireAuth, requireRole, type AuthUser } from '../auth.js';
import { HttpError, assertId, isISODate, isUuid, str } from '../http.js';
import {
  fetchTimesheets, isEntryLocked, loadAllocations, loadApprovedLeaves, loadCalendars, loadEmployees,
  type ApprovalEvent, type EntryStatus, type Timesheet, type TimesheetEntry,
} from '../data.js';
import { canSee, managedProjectIds, visibleEmployeeIds } from '../scope.js';
import { readPolicy, readSettings, type OvertimePolicy } from './organisation.js';
import { addDays, currentWeekStart, startOfWeek, sum, weekDates } from '../lib/dates.js';
import { allocationsForWeek, computeOvertime, dailyTotals, entryTotal, expectedWeekHours } from '../lib/workCalc.js';
import { overtimeEligibility } from '../lib/overtimeEligibility.js';

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

async function projectNames(db: Db, org: string): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; name: string }>('SELECT id, name FROM projects WHERE organisation_id = $1', [org]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function addEvent(db: Db, timesheetId: string, actorId: string, action: ApprovalEvent['action'], projectId: string | null, comment: string | null) {
  await db.query('INSERT INTO timesheet_events (timesheet_id, actor_id, action, project_id, comment) VALUES ($1, $2, $3, $4, $5)', [
    timesheetId, actorId, action, projectId, comment,
  ]);
}

async function loadOne(db: Db, org: string, id: string): Promise<Timesheet> {
  const ts = (await fetchTimesheets(db, org, { ids: [id] }))[0];
  if (!ts) throw new HttpError(404, 'Timesheet not found.');
  return ts;
}

/** Keeps auto-flagged overtime records in step with the submitted hours (pending records only). */
async function syncOvertime(db: Db, org: string, ts: Timesheet, policy: OvertimePolicy): Promise<void> {
  if (!policy.enabled || !policy.autoFlag) return;
  const employees = await loadEmployees(db, org);
  const emp = employees.get(ts.employeeId);
  // Hours of employees who are not eligible are ordinary hours, not overtime.
  if (!emp || !overtimeEligibility(emp, policy).eligible) return;
  const calendars = await loadCalendars(db, org);
  const breakdown = computeOvertime(ts.entries.filter((e) => e.status !== 'draft'), ts.weekStart, calendars.get(emp?.calendarId ?? ''), policy);
  for (const [projectId, hours] of Object.entries(breakdown.byProject)) {
    await db.query(
      `INSERT INTO overtime_requests (organisation_id, employee_id, project_id, week_start, hours, reason, source, timesheet_id)
       VALUES ($1, $2, $3, $4, $5, 'Additional hours flagged automatically from the submitted timesheet.', 'timesheet', $6)
       ON CONFLICT (timesheet_id, project_id) WHERE source = 'timesheet'
       DO UPDATE SET hours = EXCLUDED.hours WHERE overtime_requests.status = 'pending'`,
      [org, ts.employeeId, projectId, ts.weekStart, hours, ts.id],
    );
  }
  await db.query(
    `DELETE FROM overtime_requests WHERE timesheet_id = $1 AND source = 'timesheet' AND status = 'pending' AND NOT (project_id = ANY($2::uuid[]))`,
    [ts.id, Object.keys(breakdown.byProject)],
  );
}

// ------------------------------------------------------------ save / submit

async function saveOwnTimesheet(user: AuthUser, body: unknown, submit: boolean): Promise<Timesheet> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isISODate(b.weekStart)) throw new HttpError(400, 'Week is required.', { weekStart: 'Week is required.' });
  if (b.entries !== undefined && !Array.isArray(b.entries)) throw new HttpError(400, 'Entries must be a list.');
  const weekStart = startOfWeek(b.weekStart);
  const weekEnd = addDays(weekStart, 6);
  const dates = weekDates(weekStart);
  const org = user.organisationId;
  const [settings, policy] = await Promise.all([readSettings(org), readPolicy(org)]);
  const inputs = (b.entries ?? []) as Array<Record<string, unknown>>;

  return withTransaction(async (db) => {
    // Creating-or-locking the row serialises concurrent saves and makes duplicate weekly timesheets impossible.
    await db.query(
      'INSERT INTO timesheets (organisation_id, employee_id, week_start) VALUES ($1, $2, $3) ON CONFLICT (employee_id, week_start) DO NOTHING',
      [org, user.id, weekStart],
    );
    const tsId = (await db.query<{ id: string }>('SELECT id FROM timesheets WHERE employee_id = $1 AND week_start = $2 FOR UPDATE', [user.id, weekStart])).rows[0]!.id;
    const existing = await loadOne(db, org, tsId);

    const allocations = allocationsForWeek(await loadAllocations(db, org, { from: weekStart, to: weekEnd, employeeIds: [user.id] }), user.id, weekStart);
    const allowed = new Set([...allocations.map((a) => a.projectId), ...existing.entries.map((e) => e.projectId)]);
    const names = await projectNames(db, org);
    const calendars = await loadCalendars(db, org);
    const calendar = calendars.get(user.calendarId);
    const leaves = (await loadApprovedLeaves(db, org, weekStart, weekEnd)).filter((l) => l.employeeId === user.id);

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

    const wasSubmitted = existing.entries.some((e) => e.status !== 'draft');
    if (submit) {
      if (weekStart > currentWeekStart()) throw new HttpError(400, 'Future weeks can only be saved as a draft.');
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
      if (policy.enabled && overtimeEligibility(user, policy).eligible) {
        const ot = computeOvertime(entries.filter((e) => e.status !== 'draft'), weekStart, calendar, policy);
        if (ot.total > policy.maxWeeklyOvertime) {
          throw new HttpError(400, `This week has ${ot.total} h of overtime, above your organisation's weekly maximum of ${policy.maxWeeklyOvertime} h.`);
        }
        if (policy.requirePreApproval) {
          const { rows } = await db.query<{ project_id: string; hours: string }>(
            `SELECT project_id, sum(hours) AS hours FROM overtime_requests
              WHERE employee_id = $1 AND week_start = $2 AND source = 'pre_approval' AND status = 'approved' GROUP BY project_id`,
            [user.id, weekStart],
          );
          const approved = new Map(rows.map((r) => [r.project_id, Number(r.hours)]));
          for (const [projectId, hours] of Object.entries(ot.byProject)) {
            if (hours > (approved.get(projectId) ?? 0)) {
              throw new HttpError(400, `${names.get(projectId) ?? 'A project'} has ${hours} h of overtime this week. Your organisation requires an approved overtime request before submitting it.`);
            }
          }
        }
      }
    }

    // Persist: drop editable entries that were removed, upsert the rest in display order.
    await db.query('DELETE FROM timesheet_entries WHERE timesheet_id = $1 AND NOT (project_id = ANY($2::uuid[]))', [tsId, entries.map((e) => e.projectId)]);
    for (const [position, e] of entries.entries()) {
      await db.query(
        `INSERT INTO timesheet_entries (timesheet_id, project_id, position, hours, description, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (timesheet_id, project_id) DO UPDATE
           SET position = EXCLUDED.position, hours = EXCLUDED.hours, description = EXCLUDED.description, status = EXCLUDED.status, updated_at = now()`,
        [tsId, e.projectId, position, e.hours, e.description, e.status],
      );
    }

    if (submit) {
      await addEvent(db, tsId, user.id, wasSubmitted ? 'resubmitted' : 'submitted', null, wasSubmitted ? 'Corrections made and timesheet resubmitted.' : 'Weekly timesheet submitted.');
    } else {
      // Only the latest draft save is kept in the history.
      await db.query("DELETE FROM timesheet_events WHERE timesheet_id = $1 AND action = 'saved'", [tsId]);
      await addEvent(db, tsId, user.id, 'saved', null, 'Draft saved.');
    }
    await db.query(`UPDATE timesheets SET updated_at = now(), submitted_at = CASE WHEN $2 THEN now() ELSE submitted_at END WHERE id = $1`, [tsId, submit]);

    const saved = await loadOne(db, org, tsId);
    if (submit) await syncOvertime(db, org, saved, policy);
    return saved;
  });
}

// ---------------------------------------------------------------- approvals

/** Locks one entry and checks the reviewer may act on it. */
async function lockEntryForReview(db: PoolClient, user: AuthUser, timesheetId: unknown, projectId: unknown) {
  if (!isUuid(timesheetId) || !isUuid(projectId)) throw new HttpError(404, 'Timesheet entry not found.');
  const { rows } = await db.query<{ status: EntryStatus; employee_id: string; manager_id: string }>(
    `SELECT e.status, t.employee_id, p.manager_id
       FROM timesheet_entries e JOIN timesheets t ON t.id = e.timesheet_id JOIN projects p ON p.id = e.project_id
      WHERE t.organisation_id = $1 AND e.timesheet_id = $2 AND e.project_id = $3
      FOR UPDATE OF e`,
    [user.organisationId, timesheetId, projectId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Timesheet entry not found.');
  if (user.systemRole !== 'admin') {
    if (row.manager_id !== user.id) throw new HttpError(403, 'Only the project manager of this project can review these hours.');
    if (row.employee_id === user.id) throw new HttpError(403, 'You cannot review your own timesheet entries. An administrator must review them.');
  }
  return row;
}

export const timesheetsRouter = Router();
timesheetsRouter.use(requireAuth);

/** GET /api/timesheets?employeeId=&weekStart= — scoped to what the user may see. */
timesheetsRouter.get('/', async (req, res) => {
  const user = currentUser(res);
  const scope = await visibleEmployeeIds(pool, user);
  const employeeId = str(req.query.employeeId);
  const weekStart = str(req.query.weekStart);
  if (employeeId && !canSee(scope, employeeId)) throw new HttpError(403, 'You do not have permission to view these timesheets.');
  if (weekStart && !isISODate(weekStart)) throw new HttpError(400, 'weekStart must be a date (YYYY-MM-DD).');
  const list = await fetchTimesheets(pool, user.organisationId, {
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
  const ts = await loadOne(pool, user.organisationId, assertId(req.params.id, 'Timesheet'));
  if (!canSee(await visibleEmployeeIds(pool, user), ts.employeeId)) throw new HttpError(403, 'You do not have permission to view this timesheet.');
  res.json(ts);
});

/** POST /api/timesheets/:id/reopen — administrators return every entry for correction. */
timesheetsRouter.post('/:id/reopen', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Timesheet');
  const reason = str(req.body?.reason);
  if (!reason) throw new HttpError(400, 'Reason is required.', { reason: 'Reason is required.' });
  const ts = await withTransaction(async (db) => {
    const lock = await db.query('SELECT 1 FROM timesheets WHERE organisation_id = $1 AND id = $2 FOR UPDATE', [user.organisationId, id]);
    if (!lock.rowCount) throw new HttpError(404, 'Timesheet not found.');
    const before = await loadOne(db, user.organisationId, id);
    if (before.entries.every((e) => e.status === 'draft')) throw new HttpError(409, 'This timesheet has not been submitted.');
    await db.query("UPDATE timesheet_entries SET status = 'returned', manager_comment = $2, updated_at = now() WHERE timesheet_id = $1", [id, reason]);
    await addEvent(db, id, user.id, 'reopened', null, reason);
    await db.query('UPDATE timesheets SET updated_at = now() WHERE id = $1', [id]);
    return loadOne(db, user.organisationId, id);
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
  const scope = user.systemRole === 'admin' ? null : [...(await managedProjectIds(pool, user))];

  const { rows: ids } = await pool.query<{ timesheet_id: string }>(
    `SELECT DISTINCT e.timesheet_id FROM timesheet_entries e JOIN timesheets t ON t.id = e.timesheet_id
      WHERE t.organisation_id = $1 AND e.status <> 'draft'
        AND ($2::uuid[] IS NULL OR e.project_id = ANY($2::uuid[]))
        AND ($3::text = 'all' OR e.status = $3::text)
        AND ($4::uuid IS NULL OR e.project_id = $4::uuid)
        AND ($5::date IS NULL OR t.week_start = $5::date)`,
    [org, scope, status, projectId || null, weekStart || null],
  );
  const timesheets = await fetchTimesheets(pool, org, { ids: ids.map((r) => r.timesheet_id) });
  if (!timesheets.length) return void res.json([]);

  const weeks = timesheets.map((t) => t.weekStart).sort();
  const from = weeks[0]!;
  const to = addDays(weeks[weeks.length - 1]!, 6);
  const [employees, calendars, allocations, leaves, projects] = await Promise.all([
    loadEmployees(pool, org),
    loadCalendars(pool, org),
    loadAllocations(pool, org, { from, to }),
    loadApprovedLeaves(pool, org, from, to),
    pool.query<{ id: string; name: string; color: string }>('SELECT id, name, color FROM projects WHERE organisation_id = $1', [org]),
  ]);
  const projectById = new Map(projects.rows.map((p) => [p.id, p]));
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

  const updated = await withTransaction(async (db) => {
    // Validate everything first so the batch is all-or-nothing.
    for (const item of items) {
      const row = await lockEntryForReview(db, user, item.timesheetId, item.projectId);
      if (row.status !== 'pending') throw new HttpError(409, 'One or more entries are no longer pending. Refresh and try again.');
    }
    const touched = new Set<string>();
    for (const { timesheetId, projectId } of items) {
      await db.query(
        `UPDATE timesheet_entries SET status = $3, reviewed_by = $4, reviewed_at = now(), manager_comment = COALESCE($5, manager_comment), updated_at = now()
          WHERE timesheet_id = $1 AND project_id = $2`,
        [timesheetId, projectId, action, user.id, comment],
      );
      await addEvent(db, timesheetId as string, user.id, action, projectId as string, comment);
      touched.add(timesheetId as string);
      // Rejecting hours also rejects their auto-flagged overtime.
      if (action === 'rejected') {
        await db.query(
          `UPDATE overtime_requests SET status = 'rejected', reviewer_id = $3, reviewer_comment = 'Underlying timesheet hours were rejected.', reviewed_at = now()
            WHERE timesheet_id = $1 AND project_id = $2 AND status = 'pending'`,
          [timesheetId, projectId, user.id],
        );
      }
    }
    await db.query('UPDATE timesheets SET updated_at = now() WHERE id = ANY($1::uuid[])', [[...touched]]);
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
  const ts = await withTransaction(async (db) => {
    const row = await lockEntryForReview(db, user, req.body?.timesheetId, req.body?.projectId);
    if (row.status !== 'pending') throw new HttpError(409, 'Only pending entries can be modified.');
    const timesheetId = req.body.timesheetId as string;
    const projectId = req.body.projectId as string;
    const others = await db.query<{ hours: string[] }>('SELECT hours FROM timesheet_entries WHERE timesheet_id = $1 AND project_id <> $2', [timesheetId, projectId]);
    const daily = dailyTotals([...others.rows.map((o) => ({ projectId: '', hours: o.hours.map(Number) })), { projectId, hours }]);
    if (daily.some((d) => d > 24)) throw new HttpError(400, 'A day cannot exceed 24 hours in total.');
    await db.query(
      `UPDATE timesheet_entries SET original_hours = COALESCE(original_hours, hours), hours = $3, manager_comment = $4, updated_at = now()
        WHERE timesheet_id = $1 AND project_id = $2`,
      [timesheetId, projectId, hours, reason],
    );
    await addEvent(db, timesheetId, user.id, 'modified', projectId, reason);
    await db.query('UPDATE timesheets SET updated_at = now() WHERE id = $1', [timesheetId]);
    const saved = await loadOne(db, org, timesheetId);
    await syncOvertime(db, org, saved, policy);
    return saved;
  });
  res.json(ts);
});
