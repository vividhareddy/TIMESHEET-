import type { Project, ProjectStatus } from '@/types';
import type { ProjectInput, ProjectStatusRequest } from '@/types/api';
import { apiClient, unwrap } from './api';

export const projectService = {
  /** GET /projects */
  list: () => unwrap(apiClient.get<Project[]>('/projects')),
  /** POST /projects */
  create: (body: ProjectInput) => unwrap(apiClient.post<Project>('/projects', body)),
  /** PUT /projects/:id */
  update: (id: string, body: ProjectInput) => unwrap(apiClient.put<Project>(`/projects/${id}`, body)),
  /** GET /projects/:id */
  get: (id: string) => unwrap(apiClient.get<Project>(`/projects/${id}`)),
  /** DELETE /projects/:id — refused (409) once the project has allocations or timesheet records. */
  remove: (id: string) => unwrap(apiClient.delete<void>(`/projects/${id}`)),
  /** PATCH /projects/:id/status */
  setStatus: (id: string, status: ProjectStatus) =>
    unwrap(apiClient.patch<Project>(`/projects/${id}/status`, { status } satisfies ProjectStatusRequest)),
};
