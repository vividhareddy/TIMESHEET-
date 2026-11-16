import type { AppSettings, Department, ReferenceData, WorkLocation } from '@/types';
import type { DepartmentInput, WorkLocationInput } from '@/types/api';
import { apiClient, unwrap } from './api';

/** Reference data and organisation settings. */
export const lookupService = {
  /** GET /lookups — every option list used by business dropdowns. */
  get: () => unwrap(apiClient.get<ReferenceData>('/lookups')),
  /** POST /lookups/departments */
  addDepartment: (body: DepartmentInput) => unwrap(apiClient.post<Department>('/lookups/departments', body)),
  /** DELETE /lookups/departments/:id */
  removeDepartment: (id: string) => unwrap(apiClient.delete<void>(`/lookups/departments/${id}`)),
  /** POST /lookups/work-locations */
  addWorkLocation: (body: WorkLocationInput) => unwrap(apiClient.post<WorkLocation>('/lookups/work-locations', body)),
  /** PUT /lookups/work-locations/:id */
  updateWorkLocation: (id: string, body: WorkLocationInput) => unwrap(apiClient.put<WorkLocation>(`/lookups/work-locations/${id}`, body)),
  /** DELETE /lookups/work-locations/:id */
  removeWorkLocation: (id: string) => unwrap(apiClient.delete<void>(`/lookups/work-locations/${id}`)),
  /** GET /settings */
  getSettings: () => unwrap(apiClient.get<AppSettings>('/settings')),
  /** PUT /settings */
  saveSettings: (body: AppSettings) => unwrap(apiClient.put<AppSettings>('/settings', body)),
};
