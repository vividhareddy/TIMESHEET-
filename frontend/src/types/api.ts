/**
 * Request / response contracts between the React client and the Node.js + Express API.
 * The mock server (dev only) implements exactly these contracts.
 */
import type {
  Allocation,
  ApprovalEvent,
  AppSettings,
  CountryCode,
  Employee,
  EntryStatus,
  HolidayType,
  ISODate,
  LeaveDuration,
  Project,
  ProjectStatus,
  RequestStatus,
  Role,
  TimesheetEntry,
  TimesheetStatus,
  WorkCalendar,
} from './index';

// ------------------------------------------------------------------- errors

export interface ApiErrorBody {
  message: string;
  /** Field-level validation messages, e.g. { email: 'Already in use' } */
  fieldErrors?: Record<string, string>;
}

// --------------------------------------------------------------------- auth

export interface LoginRequest {
  email: string;
  password: string;
  /** Longer-lived token, kept after the browser closes. */
  rememberMe?: boolean;
}

export interface AuthResponse {
  /** Signed JWT sent as "Authorization: Bearer <token>". */
  token: string;
  /** ISO timestamp when the token expires. */
  expiresAt?: string;
  user: Employee;
}

export interface SetupStatusResponse {
  /** True when the database has no users yet and the first administrator must be created. */
  needsSetup: boolean;
  /** True when "Sign in with Keka account" is configured on the server. */
  kekaSignIn?: boolean;
}

export interface SetupRequest {
  organisationName: string;
  name: string;
  email: string;
  password: string;
}

/** Mock mode only: accounts available for quick sign-in. */
export interface MockAccount {
  id: string;
  name: string;
  designation: string;
  systemRole: Role;
}

// --------------------------------------------------------------- employees

/**
 * Create / update body. password is required when creating an account (temporary password set by the
 * administrator); on update a non-empty value resets the password and an empty / missing one keeps it.
 */
export type EmployeeInput = Omit<Employee, 'id'> & { password?: string };

// ---------------------------------------------------------------- projects

export type ProjectInput = Omit<Project, 'id' | 'createdAt'>;

export interface StatusChangeRequest<S extends string> {
  status: S;
}

export type ProjectStatusRequest = StatusChangeRequest<ProjectStatus>;

// ------------------------------------------------------------- allocations

export type AllocationInput = Omit<Allocation, 'id'>;

export interface AllocationQuery {
  employeeId?: string;
  projectId?: string;
}

// -------------------------------------------------------------- timesheets

export interface TimesheetQuery {
  employeeId?: string;
  weekStart?: ISODate;
}

export interface TimesheetEntryInput {
  projectId: string;
  hours: number[];
  description: string;
}

export interface SaveTimesheetRequest {
  weekStart: ISODate;
  entries: TimesheetEntryInput[];
}

// --------------------------------------------------------------- approvals

export type ReviewAction = 'approved' | 'rejected' | 'returned';

export interface ApprovalQuery {
  status?: EntryStatus | 'all';
  projectId?: string;
  weekStart?: ISODate;
}

/** One project entry on one weekly timesheet, as seen by its approver. */
export interface ApprovalItem {
  id: string;
  timesheetId: string;
  weekStart: ISODate;
  employee: Pick<Employee, 'id' | 'name' | 'designation' | 'weeklyCapacity' | 'calendarId'>;
  project: Pick<Project, 'id' | 'name' | 'color'>;
  entry: TimesheetEntry;
  total: number;
  allocation: Allocation | null;
  /** All projects on the same weekly timesheet. */
  timesheetTotal: number;
  expectedHours: number;
  weekAllocatedHours: number;
  weekAllocationCount: number;
  history: ApprovalEvent[];
}

export interface ApprovalItemRef {
  timesheetId: string;
  projectId: string;
}

export interface ReviewRequest {
  items: ApprovalItemRef[];
  action: ReviewAction;
  comment?: string;
}

export interface ReviewResponse {
  updated: number;
}

export interface ModifyHoursRequest extends ApprovalItemRef {
  hours: number[];
  reason: string;
}

export interface ReopenRequest {
  reason: string;
}

// --------------------------------------------------------------- calendars

export type CalendarInput = Omit<WorkCalendar, 'id' | 'holidays'>;

export interface HolidayInput {
  date: ISODate;
  name: string;
  type: HolidayType;
}

// ------------------------------------------------------------ lookups admin

export interface DepartmentInput {
  name: string;
}

export interface WorkLocationInput {
  name: string;
  country: CountryCode;
  defaultCalendarId: string | null;
}

// ------------------------------------------------------------------- leave

export interface LeaveApplyRequest {
  date: ISODate;
  duration: LeaveDuration;
  reason: string;
}

export interface RequestReviewBody {
  status: Exclude<RequestStatus, 'pending'>;
  comment?: string;
}

// ---------------------------------------------------------------- overtime

export interface OvertimeCreateRequest {
  projectId: string;
  date: ISODate;
  hours: number;
  reason: string;
}

// ----------------------------------------------------------------- reports

export interface AdminDashboardSummary {
  activeEmployees: number;
  inactiveEmployees: number;
  activeProjects: number;
  totalProjects: number;
  activeAllocations: number;
  allocatedPeople: number;
  pendingApprovals: number;
  weeklyAllocatedHours: number;
}

export interface ManagerDashboardSummary {
  assignedProjects: number;
  teamMembers: number;
  pendingApprovals: number;
  approvedEntries: number;
  returnedEntries: number;
  pendingOvertime: number;
}

export interface AssociateDashboardSummary {
  assignedProjects: number;
  weeklyTarget: number;
  expectedHours: number;
  enteredHours: number;
  remainingHours: number;
  currentStatus: TimesheetStatus;
  entriesAwaitingApproval: number;
}

export interface HoursReportQuery {
  from: ISODate; // week start (Monday)
  to: ISODate; // week start (Monday), inclusive
  projectId?: string;
}

export interface EmployeeHoursRow {
  employeeId: string;
  name: string;
  designation: string;
  projects: number;
  expected: number;
  allocated: number;
  actual: number;
  approved: number;
  pending: number;
}

export interface ProjectHoursRow {
  projectId: string;
  name: string;
  color: string;
  managerName: string;
  team: number;
  allocated: number;
  actual: number;
  approved: number;
  pending: number;
}

export interface AllocationActualRow {
  employeeId: string;
  employeeName: string;
  projectId: string;
  projectName: string;
  color: string;
  allocated: number;
  actual: number;
}

export interface WeeklyHoursPoint {
  weekStart: ISODate;
  actual: number;
  allocated: number;
  counts: Partial<Record<EntryStatus, number>>;
}

export interface OvertimeSummaryRow {
  employeeId: string;
  name: string;
  approved: number;
  pending: number;
  rejected: number;
  payable: number;
}

export interface HoursReport {
  weeks: ISODate[];
  totals: { actual: number; approved: number; pending: number; overtime: number; entries: number };
  statusCounts: Partial<Record<EntryStatus, number>>;
  weekly: WeeklyHoursPoint[];
  employees: EmployeeHoursRow[];
  projects: ProjectHoursRow[];
  allocation: AllocationActualRow[];
  overtime: OvertimeSummaryRow[];
  overtimeMultiplier: number;
}

export type SettingsBody = AppSettings;
