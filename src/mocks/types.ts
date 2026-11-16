import type {
  Allocation,
  AppSettings,
  Department,
  Employee,
  LeaveRequest,
  OvertimePolicy,
  OvertimeRequest,
  Project,
  Timesheet,
  WorkCalendar,
  WorkLocation,
} from '@/types';

/** Shape of the mock database (mirrors the PostgreSQL tables the backend will own). */
export interface MockDatabase {
  version: 2;
  /** employeeId → password (mock only; the real API stores salted hashes). */
  credentials: Record<string, string>;
  employees: Employee[];
  projects: Project[];
  allocations: Allocation[];
  calendars: WorkCalendar[];
  timesheets: Timesheet[];
  leaves: LeaveRequest[];
  overtime: OvertimeRequest[];
  departments: Department[];
  workLocations: WorkLocation[];
  settings: AppSettings;
  policy: OvertimePolicy;
}
