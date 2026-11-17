// ---------------------------------------------------------------------------
// Domain types for the Project Timesheet & Resource Management System.
// These mirror the shape the future Node.js/Express/PostgreSQL API will return.
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'manager' | 'associate';

export type ISODate = string; // yyyy-mm-dd

export type CountryCode = 'US' | 'IN';

export type EmployeeStatus = 'active' | 'inactive';

export interface Employee {
  id: string;
  employeeCode: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  designation: string;
  workLocation: string;
  country: CountryCode;
  calendarId: string;
  managerId: string | null;
  systemRole: Role;
  status: EmployeeStatus;
  /** Weekly working-hour target for this employee. */
  weeklyCapacity: number;
  joinDate: ISODate;
  /** 'inherit' follows the overtime policy's department rule; the others override it for this person. */
  overtimeEligibility: OvertimeEligibility;
}

export type OvertimeEligibility = 'inherit' | 'eligible' | 'not_eligible';

export type ProjectStatus = 'active' | 'on_hold' | 'completed' | 'inactive';

export interface Project {
  id: string;
  code: string;
  name: string;
  client: string;
  description: string;
  managerId: string;
  startDate: ISODate;
  endDate: ISODate;
  status: ProjectStatus;
  billable: boolean;
  color: string;
  /** When the project was created (set by the server). */
  createdAt?: string;
}

export interface Allocation {
  id: string;
  employeeId: string;
  projectId: string;
  projectRole: string;
  weeklyHours: number;
  startDate: ISODate;
  endDate: ISODate;
}

// ---------------------------------------------------------------- Timesheets

export type EntryStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'returned';

export type TimesheetStatus =
  | 'not_started'
  | 'draft'
  | 'submitted'
  | 'partially_approved'
  | 'approved'
  | 'returned'
  | 'rejected';

export interface TimesheetEntry {
  projectId: string;
  /** Hours for Monday..Sunday (index 0 = Monday). */
  hours: number[];
  description: string;
  status: EntryStatus;
  managerComment?: string;
  /** Hours as submitted by the employee, kept when a manager modifies them. */
  originalHours?: number[];
  reviewedBy?: string;
  reviewedAt?: string;
}

export type HistoryAction =
  | 'saved'
  | 'submitted'
  | 'resubmitted'
  | 'approved'
  | 'rejected'
  | 'returned'
  | 'modified'
  | 'reopened';

export interface ApprovalEvent {
  id: string;
  at: string; // ISO datetime
  actorId: string;
  action: HistoryAction;
  projectId?: string;
  comment?: string;
}

export interface Timesheet {
  id: string;
  employeeId: string;
  weekStart: ISODate; // Monday
  entries: TimesheetEntry[];
  submittedAt?: string;
  updatedAt: string;
  history: ApprovalEvent[];
}

// ------------------------------------------------------------------ Calendars

export type HolidayType = 'public' | 'company';

export interface Holiday {
  id: string;
  date: ISODate;
  name: string;
  type: HolidayType;
}

export interface WorkCalendar {
  id: string;
  name: string;
  country: CountryCode;
  timezone: string;
  /** 0 = Sunday ... 6 = Saturday */
  workingDays: number[];
  hoursPerDay: number;
  holidays: Holiday[];
}

// ---------------------------------------------------------------------- Leave

export type LeaveDuration = 'full' | 'half';
export type RequestStatus = 'pending' | 'approved' | 'rejected';

export interface LeaveRequest {
  id: string;
  employeeId: string;
  date: ISODate;
  duration: LeaveDuration;
  /** Calculated from the employee's calendar — never entered manually. */
  hours: number;
  reason: string;
  status: RequestStatus;
  appliedOn: string;
  reviewerId?: string;
  reviewerComment?: string;
}

// ------------------------------------------------------------------- Overtime

export type OvertimeSource = 'timesheet' | 'pre_approval';

export interface OvertimeRequest {
  id: string;
  employeeId: string;
  projectId: string;
  weekStart: ISODate;
  date?: ISODate;
  hours: number;
  reason: string;
  source: OvertimeSource;
  status: RequestStatus;
  createdAt: string;
  reviewerId?: string;
  reviewerComment?: string;
  /** Linked timesheet when source = timesheet */
  timesheetId?: string;
}

export type OvertimeApprover = 'project_manager' | 'reporting_manager' | 'admin';

export interface OvertimePolicy {
  enabled: boolean;
  dailyThreshold: number;
  weeklyThreshold: number;
  weekendApplicable: boolean;
  holidayApplicable: boolean;
  weekdayMultiplier: number;
  weekendMultiplier: number;
  maxWeeklyOvertime: number;
  requirePreApproval: boolean;
  approver: OvertimeApprover;
  autoFlag: boolean;
  /** 'all' = every department is eligible; 'departments' = only eligibleDepartments (employee overrides still apply). */
  eligibilityScope: 'all' | 'departments';
  /** Department names. */
  eligibleDepartments: string[];
}

/** GET /overtime-requests/eligibility — the signed-in employee's eligibility. */
export interface OvertimeEligibilityStatus {
  eligible: boolean;
  reason: string;
}

export type PolicyDocumentStatus = 'draft' | 'approved' | 'archived';

/** An overtime policy document. Only approved documents are visible to employees and used by the OT assistant. */
export interface PolicyDocument {
  id: string;
  title: string;
  content: string;
  status: PolicyDocumentStatus;
  createdByName?: string;
  updatedByName?: string;
  approvedByName?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OtChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface OtAssistantStatus {
  /** False when the server has no Anthropic API key configured. */
  enabled: boolean;
  approvedDocuments: number;
}

export interface AppSettings {
  organisationName: string;
  defaultWeeklyTarget: number;
  defaultHoursPerDay: number;
  hourIncrement: number;
  requireDescription: boolean;
  allowWeekendEntry: boolean;
  submissionDeadline: string; // e.g. "Monday 10:00"
  reminderEnabled: boolean;
}

// ------------------------------------------------------------ Reference data

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

export interface Department {
  id: string;
  name: string;
}

export interface WorkLocation {
  id: string;
  name: string;
  country: CountryCode;
  /** Holiday calendar assigned by default to employees at this location. */
  defaultCalendarId: string | null;
}

/** Option lists served by GET /lookups — the single source for every business dropdown. */
export interface ReferenceData {
  departments: Department[];
  workLocations: WorkLocation[];
  countries: SelectOption<CountryCode>[];
  roles: SelectOption<Role>[];
  employeeStatuses: SelectOption<EmployeeStatus>[];
  projectStatuses: SelectOption<ProjectStatus>[];
  entryStatuses: SelectOption<EntryStatus>[];
  timesheetStatuses: SelectOption<TimesheetStatus>[];
  requestStatuses: SelectOption<RequestStatus>[];
  leaveDurations: SelectOption<LeaveDuration>[];
  holidayTypes: SelectOption<HolidayType>[];
  overtimeApprovers: SelectOption<OvertimeApprover>[];
}

// ----------------------------------------------------------- UI helper types

export interface Notification {
  id: string;
  title: string;
  description: string;
  to: string;
  tone: 'info' | 'warning' | 'success' | 'danger';
}
