import type { Timesheet } from '@/types';
import type { SaveTimesheetRequest, TimesheetQuery } from '@/types/api';
import { apiClient, unwrap } from './api';

export const timesheetService = {
  /** GET /timesheets — own timesheets for associates; scoped by role for managers/admins. */
  list: (params?: TimesheetQuery) => unwrap(apiClient.get<Timesheet[]>('/timesheets', { params })),
  /** GET /timesheets/:id */
  get: (id: string) => unwrap(apiClient.get<Timesheet>(`/timesheets/${id}`)),
  /** PUT /timesheets/me/draft — save the signed-in employee's week as a draft. */
  saveDraft: (body: SaveTimesheetRequest) => unwrap(apiClient.put<Timesheet>('/timesheets/me/draft', body)),
  /** POST /timesheets/me/submit — submit (or resubmit) the week; editable entries become pending. */
  submit: (body: SaveTimesheetRequest) => unwrap(apiClient.post<Timesheet>('/timesheets/me/submit', body)),
};
