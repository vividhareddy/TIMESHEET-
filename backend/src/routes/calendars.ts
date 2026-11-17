/** Work calendars and their holidays. Reads: any signed-in user. Writes: administrators. */
import { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, assertId, assertValid, isISODate, str, uniqueViolation } from '../http.js';
import { CASE_INSENSITIVE, type Country } from '../models/common.js';
import { Calendar, Holiday, type HOLIDAY_TYPES } from '../models/calendar.js';

interface CalendarLean {
  _id: string;
  name: string;
  country: string;
  timezone: string;
  workingDays: number[];
  hoursPerDay: number;
}
interface HolidayLean {
  _id: string;
  calendarId: string;
  date: string;
  name: string;
  type: string;
}

const toCalendar = (c: CalendarLean, holidays: HolidayLean[]) => ({
  id: c._id,
  name: c.name,
  country: c.country,
  timezone: c.timezone,
  workingDays: c.workingDays,
  hoursPerDay: c.hoursPerDay,
  holidays: holidays.filter((h) => h.calendarId === c._id).map((h) => ({ id: h._id, date: h.date, name: h.name, type: h.type })),
});

async function loadCalendar(org: string, id: string) {
  const calendar = await Calendar.findOne({ organisationId: org, _id: id }).lean<CalendarLean>();
  if (!calendar) throw new HttpError(404, 'Calendar not found.');
  const holidays = await Holiday.find({ calendarId: id }).sort({ date: 1 }).lean<HolidayLean[]>();
  return toCalendar(calendar, holidays);
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
  else if (timezone.length > 64) errors.timezone = 'Use at most 64 characters.';
  if (!workingDays.length || workingDays.length !== days.length) errors.workingDays = 'Select at least one working day.';
  if (!(hoursPerDay > 0 && hoursPerDay <= 12)) errors.hoursPerDay = 'Enter between 1 and 12 hours.';
  assertValid(errors);
  return { name, country: country as Country, timezone, workingDays, hoursPerDay };
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
  if (!['public', 'state', 'company'].includes(type)) errors.type = 'Type is required.';
  assertValid(errors);
  return { date, name, type: type as (typeof HOLIDAY_TYPES)[number] };
}

const duplicateCalendar = (err: unknown) =>
  uniqueViolation(err) !== null ? new HttpError(409, 'Duplicate calendar.', { name: 'A calendar with this name already exists.' }) : err;
const duplicateHoliday = (err: unknown) =>
  uniqueViolation(err) !== null ? new HttpError(409, 'Duplicate holiday.', { date: 'A holiday already exists on this date.' }) : err;

export const calendarsRouter = Router();
calendarsRouter.use(requireAuth);

calendarsRouter.get('/', async (_req, res) => {
  const calendars = await Calendar.find({ organisationId: currentUser(res).organisationId }).collation(CASE_INSENSITIVE).sort({ name: 1 }).lean<CalendarLean[]>();
  const holidays = await Holiday.find({ calendarId: { $in: calendars.map((c) => c._id) } }).sort({ date: 1 }).lean<HolidayLean[]>();
  res.json(calendars.map((c) => toCalendar(c, holidays)));
});

calendarsRouter.post('/', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const c = validateCalendar(req.body);
  let id: string;
  try {
    id = (await Calendar.create({ organisationId: org, ...c }))._id;
  } catch (err) {
    throw duplicateCalendar(err);
  }
  res.status(201).json(await loadCalendar(org, id));
});

calendarsRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Calendar');
  const c = validateCalendar(req.body);
  const result = await Calendar.updateOne({ organisationId: org, _id: id }, { $set: c }, { runValidators: true }).catch((err) => Promise.reject(duplicateCalendar(err)));
  if (!result.matchedCount) throw new HttpError(404, 'Calendar not found.');
  res.json(await loadCalendar(org, id));
});

calendarsRouter.post('/:id/holidays', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Calendar');
  await loadCalendar(org, id);
  const h = validateHoliday(req.body);
  try {
    await Holiday.create({ calendarId: id, ...h });
  } catch (err) {
    throw duplicateHoliday(err);
  }
  res.status(201).json(await loadCalendar(org, id));
});

calendarsRouter.put('/:id/holidays/:holidayId', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Calendar');
  const holidayId = assertId(req.params.holidayId, 'Holiday');
  await loadCalendar(org, id);
  const h = validateHoliday(req.body);
  const result = await Holiday.updateOne({ calendarId: id, _id: holidayId }, { $set: h }, { runValidators: true }).catch((err) => Promise.reject(duplicateHoliday(err)));
  if (!result.matchedCount) throw new HttpError(404, 'Holiday not found.');
  res.json(await loadCalendar(org, id));
});

calendarsRouter.delete('/:id/holidays/:holidayId', requireRole('admin'), async (req, res) => {
  const org = currentUser(res).organisationId;
  const id = assertId(req.params.id, 'Calendar');
  const holidayId = assertId(req.params.holidayId, 'Holiday');
  await loadCalendar(org, id);
  await Holiday.deleteOne({ calendarId: id, _id: holidayId });
  res.json(await loadCalendar(org, id));
});
