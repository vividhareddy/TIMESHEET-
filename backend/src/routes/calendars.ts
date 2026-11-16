/** Work calendars and their holidays. Reads: any signed-in user. Writes: administrators. */
import { Router } from 'express';
import { pool } from '../db.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, assertId, assertValid, isISODate, str, uniqueViolation } from '../http.js';

interface CalendarRow {
  id: string;
  name: string;
  country: string;
  timezone: string;
  working_days: number[];
  hours_per_day: string;
  holidays: Array<{ id: string; date: string; name: string; type: string }>;
}

const CALENDAR_SELECT = `
  SELECT c.id, c.name, c.country, c.timezone, c.working_days, c.hours_per_day,
         COALESCE(json_agg(json_build_object('id', h.id, 'date', to_char(h.date, 'YYYY-MM-DD'), 'name', h.name, 'type', h.type)
                  ORDER BY h.date) FILTER (WHERE h.id IS NOT NULL), '[]') AS holidays
    FROM calendars c LEFT JOIN holidays h ON h.calendar_id = c.id
   WHERE c.organisation_id = $1`;

const toCalendar = (r: CalendarRow) => ({
  id: r.id,
  name: r.name,
  country: r.country,
  timezone: r.timezone,
  workingDays: r.working_days,
  hoursPerDay: Number(r.hours_per_day),
  holidays: r.holidays,
});

async function loadCalendar(org: string, id: string) {
  const { rows } = await pool.query<CalendarRow>(`${CALENDAR_SELECT} AND c.id = $2 GROUP BY c.id`, [org, id]);
  if (!rows[0]) throw new HttpError(404, 'Calendar not found.');
  return toCalendar(rows[0]);
}

function validateCalendar(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const name = str(b.name);
  const country = str(b.country);
  const timezone = str(b.timezone);
  const hoursPerDay = Number(b.hoursPerDay);
  const days = Array.isArray(b.workingDays) ? b.workingDays : [];
  const workingDays = [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!name) errors.name = 'Calendar name is required.';
  else if (name.length > 100) errors.name = 'Use at most 100 characters.';
  if (!['US', 'IN'].includes(country)) errors.country = 'Country is required.';
  if (!timezone) errors.timezone = 'Time zone is required.';
  if (!workingDays.length || workingDays.length !== days.length) errors.workingDays = 'Select at least one working day.';
  if (!(hoursPerDay > 0 && hoursPerDay <= 12)) errors.hoursPerDay = 'Enter between 1 and 12 hours.';
  assertValid(errors);
  return { name, country, timezone, workingDays, hoursPerDay };
}

function validateHoliday(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const date = str(b.date);
  const name = str(b.name);
  const type = str(b.type);
  if (!isISODate(date)) errors.date = 'Date is required.';
  if (!name) errors.name = 'Holiday name is required.';
  else if (name.length > 100) errors.name = 'Use at most 100 characters.';
  if (type !== 'public' && type !== 'company') errors.type = 'Type is required.';
  assertValid(errors);
  return { date, name, type };
}

const duplicateCalendar = (err: unknown) =>
  uniqueViolation(err) ? new HttpError(409, 'Duplicate calendar.', { name: 'A calendar with this name already exists.' }) : err;
const duplicateHoliday = (err: unknown) =>
  uniqueViolation(err) ? new HttpError(409, 'Duplicate holiday.', { date: 'A holiday already exists on this date.' }) : err;

export const calendarsRouter = Router();
calendarsRouter.use(requireAuth);

calendarsRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query<CalendarRow>(`${CALENDAR_SELECT} GROUP BY c.id ORDER BY lower(c.name)`, [currentUser(res).organisationId]);
  res.json(rows.map(toCalendar));
});

calendarsRouter.post('/', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const c = validateCalendar(req.body);
  const { rows } = await pool
    .query<{ id: string }>(
      'INSERT INTO calendars (organisation_id, name, country, timezone, working_days, hours_per_day) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [org, c.name, c.country, c.timezone, c.workingDays, c.hoursPerDay],
    )
    .catch((err) => Promise.reject(duplicateCalendar(err)));
  res.status(201).json(await loadCalendar(org, rows[0]!.id));
});

calendarsRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Calendar');
  const c = validateCalendar(req.body);
  const result = await pool
    .query('UPDATE calendars SET name = $3, country = $4, timezone = $5, working_days = $6, hours_per_day = $7 WHERE organisation_id = $1 AND id = $2', [
      org, id, c.name, c.country, c.timezone, c.workingDays, c.hoursPerDay,
    ])
    .catch((err) => Promise.reject(duplicateCalendar(err)));
  if (!result.rowCount) throw new HttpError(404, 'Calendar not found.');
  res.json(await loadCalendar(org, id));
});

calendarsRouter.post('/:id/holidays', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Calendar');
  await loadCalendar(org, id);
  const h = validateHoliday(req.body);
  await pool
    .query('INSERT INTO holidays (calendar_id, date, name, type) VALUES ($1, $2, $3, $4)', [id, h.date, h.name, h.type])
    .catch((err) => Promise.reject(duplicateHoliday(err)));
  res.status(201).json(await loadCalendar(org, id));
});

calendarsRouter.put('/:id/holidays/:holidayId', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Calendar');
  const holidayId = assertId(req.params.holidayId, 'Holiday');
  await loadCalendar(org, id);
  const h = validateHoliday(req.body);
  const result = await pool
    .query('UPDATE holidays SET date = $3, name = $4, type = $5 WHERE calendar_id = $1 AND id = $2', [id, holidayId, h.date, h.name, h.type])
    .catch((err) => Promise.reject(duplicateHoliday(err)));
  if (!result.rowCount) throw new HttpError(404, 'Holiday not found.');
  res.json(await loadCalendar(org, id));
});

calendarsRouter.delete('/:id/holidays/:holidayId', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Calendar');
  const holidayId = assertId(req.params.holidayId, 'Holiday');
  await loadCalendar(org, id);
  await pool.query('DELETE FROM holidays WHERE calendar_id = $1 AND id = $2', [id, holidayId]);
  res.json(await loadCalendar(org, id));
});
