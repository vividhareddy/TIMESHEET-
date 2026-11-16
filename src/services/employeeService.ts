import type { Employee, EmployeeStatus } from '@/types';
import type { EmployeeInput, StatusChangeRequest } from '@/types/api';
import { apiClient, unwrap } from './api';

export const employeeService = {
  /** GET /employees */
  list: () => unwrap(apiClient.get<Employee[]>('/employees')),
  /** GET /employees/:id */
  get: (id: string) => unwrap(apiClient.get<Employee>(`/employees/${id}`)),
  /** POST /employees — server validates unique employee ID and email (409 with fieldErrors). */
  create: (body: EmployeeInput) => unwrap(apiClient.post<Employee>('/employees', body)),
  /** PUT /employees/:id */
  update: (id: string, body: EmployeeInput) => unwrap(apiClient.put<Employee>(`/employees/${id}`, body)),
  /** PATCH /employees/:id/status */
  setStatus: (id: string, status: EmployeeStatus) =>
    unwrap(apiClient.patch<Employee>(`/employees/${id}/status`, { status } satisfies StatusChangeRequest<EmployeeStatus>)),
};
