import type { OvertimePolicy, OvertimeRequest } from '@/types';
import type { OvertimeCreateRequest, RequestReviewBody } from '@/types/api';
import { apiClient, unwrap } from './api';

export const overtimeService = {
  /** GET /overtime-requests — scoped to the signed-in user's visibility. */
  list: () => unwrap(apiClient.get<OvertimeRequest[]>('/overtime-requests')),
  /** POST /overtime-requests — pre-approval request for planned additional hours. */
  request: (body: OvertimeCreateRequest) => unwrap(apiClient.post<OvertimeRequest>('/overtime-requests', body)),
  /** POST /overtime-requests/:id/review */
  review: (id: string, body: RequestReviewBody) => unwrap(apiClient.post<OvertimeRequest>(`/overtime-requests/${id}/review`, body)),
  /** GET /policies/overtime */
  getPolicy: () => unwrap(apiClient.get<OvertimePolicy>('/policies/overtime')),
  /** PUT /policies/overtime */
  savePolicy: (body: OvertimePolicy) => unwrap(apiClient.put<OvertimePolicy>('/policies/overtime', body)),
};
