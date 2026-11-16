import type { WorkCalendar } from '@/types';
import type { CalendarInput, HolidayInput } from '@/types/api';
import { apiClient, unwrap } from './api';

export const calendarService = {
  /** GET /calendars — calendars with their holidays. */
  list: () => unwrap(apiClient.get<WorkCalendar[]>('/calendars')),
  /** POST /calendars */
  create: (body: CalendarInput) => unwrap(apiClient.post<WorkCalendar>('/calendars', body)),
  /** PUT /calendars/:id — name, working days, hours per day, time zone. */
  update: (id: string, body: CalendarInput) => unwrap(apiClient.put<WorkCalendar>(`/calendars/${id}`, body)),
  /** POST /calendars/:id/holidays */
  addHoliday: (calendarId: string, body: HolidayInput) => unwrap(apiClient.post<WorkCalendar>(`/calendars/${calendarId}/holidays`, body)),
  /** PUT /calendars/:id/holidays/:holidayId */
  updateHoliday: (calendarId: string, holidayId: string, body: HolidayInput) =>
    unwrap(apiClient.put<WorkCalendar>(`/calendars/${calendarId}/holidays/${holidayId}`, body)),
  /** DELETE /calendars/:id/holidays/:holidayId */
  deleteHoliday: (calendarId: string, holidayId: string) =>
    unwrap(apiClient.delete<WorkCalendar>(`/calendars/${calendarId}/holidays/${holidayId}`)),
};
