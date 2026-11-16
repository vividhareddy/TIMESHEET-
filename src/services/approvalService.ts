import type { Timesheet } from '@/types';
import type { ApprovalItem, ApprovalQuery, ModifyHoursRequest, ReopenRequest, ReviewRequest, ReviewResponse } from '@/types/api';
import { apiClient, unwrap } from './api';

export const approvalService = {
  /** GET /approvals — entries on projects the signed-in manager owns (all projects for admins). */
  list: (params?: ApprovalQuery) => unwrap(apiClient.get<ApprovalItem[]>('/approvals', { params })),
  /** POST /approvals/review — approve / reject / return one or more entries. */
  review: (body: ReviewRequest) => unwrap(apiClient.post<ReviewResponse>('/approvals/review', body)),
  /** POST /approvals/modify — change submitted hours with a mandatory reason. */
  modifyHours: (body: ModifyHoursRequest) => unwrap(apiClient.post<Timesheet>('/approvals/modify', body)),
  /** POST /timesheets/:id/reopen — admin unlocks every entry on a timesheet. */
  reopen: (timesheetId: string, body: ReopenRequest) => unwrap(apiClient.post<Timesheet>(`/timesheets/${timesheetId}/reopen`, body)),
};
