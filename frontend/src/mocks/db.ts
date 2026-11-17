/**
 * DEVELOPMENT ONLY — in-browser persistence for the mock API.
 * Starts EMPTY: no employees, projects or timesheets exist until they are created through the app
 * (or the sample dataset is loaded explicitly from the mock controls).
 */
import type { AppSettings, OvertimePolicy } from '@/types';
import type { MockDatabase } from './types';

const STORAGE_KEY = 'tsrm-mock-db-v2';

/** Server-side defaults applied when the database is initialised (BRD: 40h week, Mon–Fri × 8h). */
export function defaultSettings(): AppSettings {
  return {
    organisationName: '',
    defaultWeeklyTarget: 40,
    defaultHoursPerDay: 8,
    hourIncrement: 0.5,
    requireDescription: true,
    allowWeekendEntry: true,
    submissionDeadline: 'Monday 10:00',
    reminderEnabled: true,
  };
}

export function defaultPolicy(): OvertimePolicy {
  return {
    enabled: true,
    dailyThreshold: 8,
    weeklyThreshold: 40,
    weekendApplicable: true,
    holidayApplicable: true,
    weekdayMultiplier: 1.5,
    weekendMultiplier: 2,
    maxWeeklyOvertime: 12,
    requirePreApproval: false,
    approver: 'project_manager',
    autoFlag: true,
    eligibilityScope: 'all',
    eligibleDepartments: [],
  };
}

export function emptyDatabase(): MockDatabase {
  return {
    version: 2,
    credentials: {},
    employees: [],
    projects: [],
    allocations: [],
    calendars: [],
    timesheets: [],
    leaves: [],
    overtime: [],
    departments: [],
    workLocations: [],
    settings: defaultSettings(),
    policy: defaultPolicy(),
  };
}

function load(): MockDatabase {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MockDatabase;
      if (parsed.version === 2) return parsed;
    }
  } catch {
    /* corrupted or unavailable storage — start empty */
  }
  return emptyDatabase();
}

let db: MockDatabase = load();

export const mockDb = {
  get: (): MockDatabase => db,
  replace(next: MockDatabase): void {
    db = next;
    this.persist();
  },
  persist(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch {
      /* ignore quota / private mode */
    }
  },
};
