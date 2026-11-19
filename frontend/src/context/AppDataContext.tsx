/**
 * Client-side cache of business data for the signed-in user.
 * Everything is fetched through the service layer; every mutation goes to the API and the cache
 * is updated from the API response (or re-fetched). There is no fallback or fabricated data:
 * failures surface as loading / error states.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import type {
  Allocation,
  AppSettings,
  Employee,
  EmployeeStatus,
  ISODate,
  LeaveRequest,
  OvertimePolicy,
  OvertimeRequest,
  Project,
  ProjectStatus,
  ReferenceData,
  RequestStatus,
  Timesheet,
  TimesheetEntry,
  WorkCalendar,
} from '@/types';
import type {
  AllocationInput,
  ApprovalItemRef,
  CalendarInput,
  EmployeeInput,
  HolidayInput,
  LeaveApplyRequest,
  OvertimeCreateRequest,
  ProjectInput,
  ReviewAction,
  WorkLocationInput,
} from '@/types/api';
import {
  allocationService,
  approvalService,
  calendarService,
  employeeService,
  leaveService,
  lookupService,
  overtimeService,
  projectService,
  timesheetService,
  ApiError,
} from '@/services';
import { useSession } from './SessionContext';
import { ErrorScreen, LoadingScreen } from '@/components/common/StatusScreen';
import { Button } from '@/components/common/Button';

export type { ReviewAction };

export interface AppData {
  lookups: ReferenceData;
  settings: AppSettings;
  policy: OvertimePolicy;
  employees: Employee[];
  projects: Project[];
  allocations: Allocation[];
  calendars: WorkCalendar[];
  timesheets: Timesheet[];
  leaves: LeaveRequest[];
  overtime: OvertimeRequest[];
}

type Collection = keyof AppData;

const RAW_LOADERS: { [K in Collection]: () => Promise<AppData[K]> } = {
  lookups: lookupService.get,
  settings: lookupService.getSettings,
  policy: overtimeService.getPolicy,
  employees: employeeService.list,
  projects: projectService.list,
  allocations: () => allocationService.list(),
  calendars: calendarService.list,
  timesheets: () => timesheetService.list(),
  leaves: leaveService.list,
  overtime: overtimeService.list,
};

/** Collections whose server module may not be built yet (the API answers 501 Not Implemented). */
const MODULE_LABELS: Partial<Record<Collection, string>> = {
  projects: 'Projects',
  allocations: 'Allocations',
  timesheets: 'Timesheets',
  leaves: 'Leave',
  overtime: 'Overtime',
};

/** Marker for a module the server reports as not implemented. */
const UNAVAILABLE = Symbol('unavailable');

async function load<K extends Collection>(key: K): Promise<AppData[K] | typeof UNAVAILABLE> {
  try {
    return await RAW_LOADERS[key]();
  } catch (err) {
    if (MODULE_LABELS[key] && err instanceof ApiError && err.status === 501) return UNAVAILABLE;
    throw err;
  }
}

/**
 * Loads collections. A module the server has not implemented yet becomes an empty list and is
 * reported in unavailable, so the UI can say so instead of failing or showing invented data.
 */
async function loadMany(keys: Collection[]): Promise<{ values: Partial<AppData>; unavailable: Collection[] }> {
  const results = await Promise.all(keys.map((k) => load(k)));
  const values: Partial<Record<Collection, unknown>> = {};
  const unavailable: Collection[] = [];
  keys.forEach((k, i) => {
    if (results[i] === UNAVAILABLE) {
      values[k] = [];
      unavailable.push(k);
    } else values[k] = results[i];
  });
  return { values: values as Partial<AppData>, unavailable };
}

interface AppDataApi extends AppData {
  /** Names of modules the server has not implemented yet (their lists are empty). */
  unavailableModules: string[];
  /** Re-fetch some (or all) collections from the API. */
  refresh(...keys: Collection[]): Promise<void>;
  // master data
  saveEmployee(input: EmployeeInput, id?: string): Promise<Employee>;
  setEmployeeStatus(id: string, status: EmployeeStatus): Promise<void>;
  saveProject(input: ProjectInput, id?: string): Promise<Project>;
  setProjectStatus(id: string, status: ProjectStatus): Promise<void>;
  deleteProject(id: string): Promise<void>;
  saveAllocation(input: AllocationInput, id?: string): Promise<Allocation>;
  deleteAllocation(id: string): Promise<void>;
  // timesheets & approvals
  saveTimesheet(weekStart: ISODate, entries: TimesheetEntry[], submit: boolean): Promise<Timesheet>;
  reviewEntries(items: ApprovalItemRef[], action: ReviewAction, comment?: string): Promise<void>;
  modifyEntryHours(item: ApprovalItemRef, hours: number[], reason: string): Promise<void>;
  reopenTimesheet(timesheetId: string, reason: string): Promise<void>;
  // calendars & reference data
  createCalendar(input: CalendarInput): Promise<WorkCalendar>;
  updateCalendar(id: string, input: CalendarInput): Promise<void>;
  saveHoliday(calendarId: string, input: HolidayInput, holidayId?: string): Promise<void>;
  deleteHoliday(calendarId: string, holidayId: string): Promise<void>;
  addDepartment(name: string): Promise<void>;
  removeDepartment(id: string): Promise<void>;
  addWorkLocation(input: WorkLocationInput): Promise<void>;
  updateWorkLocation(id: string, input: WorkLocationInput): Promise<void>;
  removeWorkLocation(id: string): Promise<void>;
  // leave & overtime
  applyLeave(body: LeaveApplyRequest): Promise<LeaveRequest>;
  reviewLeave(id: string, status: Exclude<RequestStatus, 'pending'>, comment?: string): Promise<void>;
  cancelLeave(id: string): Promise<void>;
  requestOvertime(body: OvertimeCreateRequest): Promise<void>;
  reviewOvertime(id: string, status: Exclude<RequestStatus, 'pending'>, comment?: string): Promise<void>;
  // configuration
  saveSettings(settings: AppSettings): Promise<void>;
  savePolicy(policy: OvertimePolicy): Promise<void>;
}

const AppDataContext = createContext<AppDataApi | null>(null);

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const copy = [...list];
  copy[idx] = item;
  return copy;
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();
  const [data, setData] = useState<AppData | null>(null);
  const [unavailable, setUnavailable] = useState<Collection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Initial load — all collections in parallel. Reloads when the signed-in user changes.
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    loadMany(Object.keys(RAW_LOADERS) as Collection[])
      .then(({ values, unavailable: missing }) => {
        if (!active) return;
        setUnavailable(missing);
        setData(values as AppData);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Unable to load data.');
      });
    return () => {
      active = false;
    };
  }, [user?.id, attempt]);

  const patch = useCallback(<K extends Collection>(key: K, fn: (current: AppData[K]) => AppData[K]) => {
    setData((d) => (d ? { ...d, [key]: fn(d[key]) } : d));
  }, []);

  const refresh = useCallback(async (...keys: Collection[]) => {
    const list = keys.length ? keys : (Object.keys(RAW_LOADERS) as Collection[]);
    const { values, unavailable: missing } = await loadMany(list);
    setUnavailable((u) => [...u.filter((k) => !list.includes(k)), ...missing]);
    setData((d) => (d ? { ...d, ...values } : d));
  }, []);

  const actions = useMemo(
    () => ({
      refresh,
      // ---------------------------------------------------------- masters
      async saveEmployee(input: EmployeeInput, id?: string) {
        const saved = id ? await employeeService.update(id, input) : await employeeService.create(input);
        patch('employees', (l) => upsert(l, saved));
        return saved;
      },
      async setEmployeeStatus(id: string, status: EmployeeStatus) {
        const saved = await employeeService.setStatus(id, status);
        patch('employees', (l) => upsert(l, saved));
      },
      async saveProject(input: ProjectInput, id?: string) {
        const saved = id ? await projectService.update(id, input) : await projectService.create(input);
        patch('projects', (l) => upsert(l, saved));
        return saved;
      },
      async deleteProject(id: string) {
        await projectService.remove(id);
        patch('projects', (l) => l.filter((p) => p.id !== id));
      },
      async setProjectStatus(id: string, status: ProjectStatus) {
        const saved = await projectService.setStatus(id, status);
        patch('projects', (l) => upsert(l, saved));
      },
      async saveAllocation(input: AllocationInput, id?: string) {
        const saved = id ? await allocationService.update(id, input) : await allocationService.create(input);
        patch('allocations', (l) => upsert(l, saved));
        return saved;
      },
      async deleteAllocation(id: string) {
        await allocationService.remove(id);
        patch('allocations', (l) => l.filter((a) => a.id !== id));
      },
      // ------------------------------------------------------- timesheets
      async saveTimesheet(weekStart: ISODate, entries: TimesheetEntry[], submit: boolean) {
        const body = { weekStart, entries: entries.map(({ projectId, hours, entryTypes, description }) => ({ projectId, hours, entryTypes, description })) };
        const saved = submit ? await timesheetService.submit(body) : await timesheetService.saveDraft(body);
        patch('timesheets', (l) => upsert(l, saved));
        if (submit) await refresh('overtime');
        return saved;
      },
      async reviewEntries(items: ApprovalItemRef[], action: ReviewAction, comment?: string) {
        await approvalService.review({ items, action, comment });
        await refresh('timesheets', 'overtime');
      },
      async modifyEntryHours(item: ApprovalItemRef, hours: number[], reason: string) {
        const saved = await approvalService.modifyHours({ ...item, hours, reason });
        patch('timesheets', (l) => upsert(l, saved));
        await refresh('overtime');
      },
      async reopenTimesheet(timesheetId: string, reason: string) {
        const saved = await approvalService.reopen(timesheetId, { reason });
        patch('timesheets', (l) => upsert(l, saved));
      },
      // -------------------------------------------- calendars & reference
      async createCalendar(input: CalendarInput) {
        const saved = await calendarService.create(input);
        patch('calendars', (l) => upsert(l, saved));
        return saved;
      },
      async updateCalendar(id: string, input: CalendarInput) {
        const saved = await calendarService.update(id, input);
        patch('calendars', (l) => upsert(l, saved));
      },
      async saveHoliday(calendarId: string, input: HolidayInput, holidayId?: string) {
        const saved = holidayId ? await calendarService.updateHoliday(calendarId, holidayId, input) : await calendarService.addHoliday(calendarId, input);
        patch('calendars', (l) => upsert(l, saved));
      },
      async deleteHoliday(calendarId: string, holidayId: string) {
        const saved = await calendarService.deleteHoliday(calendarId, holidayId);
        patch('calendars', (l) => upsert(l, saved));
      },
      async addDepartment(name: string) {
        await lookupService.addDepartment({ name });
        await refresh('lookups');
      },
      async removeDepartment(id: string) {
        await lookupService.removeDepartment(id);
        await refresh('lookups');
      },
      async addWorkLocation(input: WorkLocationInput) {
        await lookupService.addWorkLocation(input);
        await refresh('lookups');
      },
      async updateWorkLocation(id: string, input: WorkLocationInput) {
        await lookupService.updateWorkLocation(id, input);
        await refresh('lookups');
      },
      async removeWorkLocation(id: string) {
        await lookupService.removeWorkLocation(id);
        await refresh('lookups');
      },
      // --------------------------------------------------- leave/overtime
      async applyLeave(body: LeaveApplyRequest) {
        const saved = await leaveService.apply(body);
        patch('leaves', (l) => upsert(l, saved));
        return saved;
      },
      async reviewLeave(id: string, status: Exclude<RequestStatus, 'pending'>, comment?: string) {
        const saved = await leaveService.review(id, { status, comment });
        patch('leaves', (l) => upsert(l, saved));
      },
      async cancelLeave(id: string) {
        await leaveService.cancel(id);
        patch('leaves', (l) => l.filter((x) => x.id !== id));
      },
      async requestOvertime(body: OvertimeCreateRequest) {
        const saved = await overtimeService.request(body);
        patch('overtime', (l) => upsert(l, saved));
      },
      async reviewOvertime(id: string, status: Exclude<RequestStatus, 'pending'>, comment?: string) {
        const saved = await overtimeService.review(id, { status, comment });
        patch('overtime', (l) => upsert(l, saved));
      },
      // ---------------------------------------------------- configuration
      async saveSettings(settings: AppSettings) {
        const saved = await lookupService.saveSettings(settings);
        patch('settings', () => saved);
      },
      async savePolicy(policy: OvertimePolicy) {
        const saved = await overtimeService.savePolicy(policy);
        patch('policy', () => saved);
      },
    }),
    [patch, refresh],
  );

  const unavailableModules = useMemo(() => unavailable.map((k) => MODULE_LABELS[k] ?? k), [unavailable]);
  const value = useMemo<AppDataApi | null>(() => (data ? { ...data, ...actions, unavailableModules } : null), [data, actions, unavailableModules]);

  if (error) {
    return (
      <ErrorScreen
        title="We couldn't load your workspace"
        message={error}
        onRetry={() => setAttempt((a) => a + 1)}
        actions={<Button variant="ghost" icon={LogOut} onClick={logout}>Sign out</Button>}
      />
    );
  }
  if (!value) return <LoadingScreen label="Loading workspace…" />;
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

/** For shared components that may render outside the data provider. */
export function useOptionalAppData(): AppDataApi | null {
  return useContext(AppDataContext);
}

export function useAppData(): AppDataApi {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error('useAppData must be used within AppDataProvider');
  return ctx;
}
