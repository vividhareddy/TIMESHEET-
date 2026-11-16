import type { AdminDashboardSummary, AssociateDashboardSummary, HoursReport, HoursReportQuery, ManagerDashboardSummary } from '@/types/api';
import { apiClient, unwrap } from './api';

/** Aggregations are computed by the server from database records. */
export const reportService = {
  /** GET /reports/dashboard/admin */
  adminDashboard: () => unwrap(apiClient.get<AdminDashboardSummary>('/reports/dashboard/admin')),
  /** GET /reports/dashboard/manager — for the signed-in project manager. */
  managerDashboard: () => unwrap(apiClient.get<ManagerDashboardSummary>('/reports/dashboard/manager')),
  /** GET /reports/dashboard/associate — for the signed-in employee, current week. */
  associateDashboard: () => unwrap(apiClient.get<AssociateDashboardSummary>('/reports/dashboard/associate')),
  /** GET /reports/hours — employee, project, allocation-vs-actual, approval and overtime aggregates. */
  hours: (params: HoursReportQuery) => unwrap(apiClient.get<HoursReport>('/reports/hours', { params })),
};
