import type { Allocation } from '@/types';
import type { AllocationInput, AllocationQuery } from '@/types/api';
import { apiClient, unwrap } from './api';

export const allocationService = {
  /** GET /allocations — scoped by the server to what the signed-in user may see. */
  list: (params?: AllocationQuery) => unwrap(apiClient.get<Allocation[]>('/allocations', { params })),
  /** POST /allocations */
  create: (body: AllocationInput) => unwrap(apiClient.post<Allocation>('/allocations', body)),
  /** PUT /allocations/:id */
  update: (id: string, body: AllocationInput) => unwrap(apiClient.put<Allocation>(`/allocations/${id}`, body)),
  /** DELETE /allocations/:id */
  remove: (id: string) => unwrap(apiClient.delete<void>(`/allocations/${id}`)),
};
