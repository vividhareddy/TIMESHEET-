import type { LeaveRequest } from '@/types';
import type { LeaveApplyRequest, RequestReviewBody } from '@/types/api';
import { apiClient, unwrap } from './api';

export const leaveService = {
  /** GET /leave-requests — own requests, direct reports' for managers, all for admins. */
  list: () => unwrap(apiClient.get<LeaveRequest[]>('/leave-requests')),
  /** POST /leave-requests — leave hours are calculated by the server from the employee's calendar. */
  apply: (body: LeaveApplyRequest) => unwrap(apiClient.post<LeaveRequest>('/leave-requests', body)),
  /** POST /leave-requests/:id/review */
  review: (id: string, body: RequestReviewBody) => unwrap(apiClient.post<LeaveRequest>(`/leave-requests/${id}/review`, body)),
  /** DELETE /leave-requests/:id — withdraw a pending request. */
  cancel: (id: string) => unwrap(apiClient.delete<void>(`/leave-requests/${id}`)),
};
