/**
 * DEVELOPMENT ONLY — illustrative sample dataset for the mock API.
 * Loaded only when a developer explicitly chooses "Load sample data" in mock mode.
 * These are fictitious records and are never shipped in production builds.
 * Timesheets, leave and overtime are generated relative to the current week.
 */
import type {
  Allocation,
  ApprovalEvent,
  Employee,
  EntryStatus,
  LeaveRequest,
  OvertimeRequest,
  Timesheet,
  TimesheetEntry,
} from '@/types';
import { addDays, currentWeekStart } from '@/utils/date';
import { allocationsForWeek, computeOvertime, leaveHours, weekExpectations } from '@/utils/timesheet';
import type { MockDatabase } from '../types';
import { SAMPLE_DEPARTMENTS, SAMPLE_WORK_LOCATIONS, seedEmployees } from './employees';
import { seedAllocations, seedProjects } from './projects';
import { seedCalendars, seedOvertimePolicy, seedSettings } from './calendars';

/** Password for every sample account (mock mode only). */
export const SAMPLE_PASSWORD = 'Password@123';

const DESCRIPTIONS: Record<string, string[]> = {
  'prj-kore': [
    'Built dialog flows for the claims-status virtual assistant and updated NLU training utterances.',
    'Integrated Kore.ai webhook with policy lookup service; fixed intent-detection regressions.',
    'Sprint 14 bot testing, entity extraction tuning and code review for the FAQ module.',
    'Implemented live-agent handoff and wrote regression tests for authentication journeys.',
  ],
  'prj-zelis': [
    'Claims pricing API enhancements and unit tests for the repricing rules engine.',
    'Provider payments portal — remittance search screen and UAT defect fixes.',
    'Supported UAT cycle 3, triaged defects with client QA and updated test evidence.',
    'EDI 835 parser performance improvements and deployment to staging.',
  ],
  'prj-uber': [
    'Driver onboarding dashboard — fixed funnel metrics and document-verification filters.',
    'Data pipeline QA for weekly trip aggregates; reconciled counts with source tables.',
    'Built Airflow DAG for background-check status sync and added alerting.',
    'Sprint demo prep and stakeholder walkthrough of onboarding drop-off insights.',
  ],
};

/** Split a day's hours across projects in proportion to allocation, in 0.5h units. */
function distribute(total: number, allocs: Allocation[], dayIndex: number): number[] {
  const units = Math.round(total * 2);
  const weightTotal = allocs.reduce((s, a) => s + a.weeklyHours, 0) || 1;
  const raw = allocs.map((a) => (a.weeklyHours / weightTotal) * units);
  const result = raw.map(Math.floor);
  let remaining = units - result.reduce((s, v) => s + v, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v), tie: (i + dayIndex) % allocs.length }))
    .sort((x, y) => y.frac - x.frac || x.tie - y.tie);
  for (const o of order) {
    if (remaining <= 0) break;
    result[o.i] += 1;
    remaining -= 1;
  }
  const hours = result.map((u) => u / 2);
  // Natural day-to-day variance without changing the daily total.
  if (hours.length >= 2) {
    if (dayIndex === 1 && hours[0] >= 1) { hours[0] -= 1; hours[1] += 1; }
    if (dayIndex === 3 && hours[1] >= 0.5) { hours[1] -= 0.5; hours[0] += 0.5; }
  }
  return hours;
}

type StatusRule = (employeeId: string, offset: number, projectId: string) => EntryStatus;

const statusRule: StatusRule = (employeeId, offset, projectId) => {
  if (offset === 0) return 'draft';
  if (offset === 1) {
    if (employeeId === 'emp-06') return 'draft';
    if (employeeId === 'emp-07') return 'approved';
    if (employeeId === 'emp-05' && projectId === 'prj-zelis') return 'approved';
    if (employeeId === 'emp-12' && projectId === 'prj-kore') return 'approved';
    return 'pending';
  }
  if (offset === 2) {
    if (employeeId === 'emp-05' && projectId === 'prj-uber') return 'returned';
    if (employeeId === 'emp-11' && projectId === 'prj-kore') return 'rejected';
  }
  return 'approved';
};

const REVIEW_COMMENTS: Record<string, string> = {
  'emp-05|prj-uber|2': 'Thursday shows 2h on Uber but no sprint ticket was logged. Please split the hours correctly and add the ticket reference in the description.',
  'emp-11|prj-kore|2': 'Kore.ai hours exceed the approved scope for this sprint. Please rebook the analysis work under Uber as agreed in Monday\'s stand-up.',
};

/** Extra hours injected to demonstrate overtime handling: [employee, offset, dayIndex, projectId, hours] */
const OVERTIME_SAMPLES: Array<[string, number, number, string, number]> = [
  ['emp-08', 1, 1, 'prj-uber', 2],
  ['emp-08', 1, 3, 'prj-uber', 1.5],
  ['emp-11', 3, 2, 'prj-uber', 2],
  ['emp-05', 4, 5, 'prj-kore', 3],
];

/** Current-week drafts: employee → number of days already filled. */
const CURRENT_WEEK_DRAFTS: Record<string, number> = { 'emp-05': 4, 'emp-09': 2, 'emp-07': 4 };

let eventCounter = 0;
const event = (e: Omit<ApprovalEvent, 'id'>): ApprovalEvent => ({ ...e, id: `evt-${++eventCounter}` });

export function buildSampleDatabase(): MockDatabase {
  eventCounter = 0;
  const W = currentWeekStart();
  const employees = seedEmployees.map((e) => ({ ...e }));
  const calendars = seedCalendars.map((c) => ({ ...c, holidays: [...c.holidays] }));
  const calOf = (e: Employee) => calendars.find((c) => c.id === e.calendarId);
  const empById = (id: string) => employees.find((e) => e.id === id)!;

  // ------------------------------------------------------------------ leave
  const leaveSpecs: Array<[string, number, LeaveRequest['duration'], string, LeaveRequest['status'], string?]> = [
    ['emp-05', -12, 'full', 'Family function in Vijayawada.', 'approved'],
    ['emp-05', 9, 'half', 'Medical appointment in the afternoon.', 'pending'],
    ['emp-07', -4, 'full', 'Personal errand — vehicle registration.', 'approved'],
    ['emp-09', 11, 'full', 'Sister\'s graduation ceremony.', 'pending'],
    ['emp-12', -18, 'half', 'Bank work.', 'rejected', 'UAT sign-off scheduled that afternoon — please pick another date.'],
    ['emp-08', 15, 'full', 'Moving to a new apartment.', 'pending'],
    ['emp-06', -25, 'full', 'Unwell — fever.', 'approved'],
  ];
  const leaves: LeaveRequest[] = leaveSpecs.map(([employeeId, offset, duration, reason, status, comment], i) => {
    const emp = empById(employeeId);
    const date = addDays(W, offset);
    return {
      id: `lv-${i + 1}`,
      employeeId,
      date,
      duration,
      hours: leaveHours(emp, calOf(emp), duration),
      reason,
      status,
      appliedOn: `${addDays(date, -10)}T09:15:00`,
      reviewerId: status === 'pending' ? undefined : emp.managerId ?? undefined,
      reviewerComment: comment,
    };
  });

  // ------------------------------------------------------------- timesheets
  const projectManager = (pid: string) => seedProjects.find((p) => p.id === pid)?.managerId ?? 'emp-01';
  const timesheets: Timesheet[] = [];
  const associates = employees.filter((e) => e.systemRole === 'associate' && e.status === 'active');

  for (const emp of associates) {
    for (let offset = 6; offset >= 0; offset--) {
      if (offset === 0 && !(emp.id in CURRENT_WEEK_DRAFTS)) continue;
      const weekStart = addDays(W, -7 * offset);
      const allocs = allocationsForWeek(seedAllocations, emp.id, weekStart);
      if (!allocs.length) continue;
      const days = weekExpectations(emp, calOf(emp), leaves, weekStart);
      const filledDays = offset === 0 ? CURRENT_WEEK_DRAFTS[emp.id] : 5;

      const perDay = days.map((d, i) => (i < filledDays ? distribute(d.expected, allocs, i) : allocs.map(() => 0)));
      const entries: TimesheetEntry[] = allocs.map((alloc, pi) => {
        const hours = perDay.map((day) => day[pi] ?? 0);
        for (const [eid, off, dayIdx, pid, extra] of OVERTIME_SAMPLES) {
          if (eid === emp.id && off === offset && pid === alloc.projectId) hours[dayIdx] += extra;
        }
        const status = statusRule(emp.id, offset, alloc.projectId);
        const key = `${emp.id}|${alloc.projectId}|${offset}`;
        const pool = DESCRIPTIONS[alloc.projectId] ?? ['Project delivery activities.'];
        return {
          projectId: alloc.projectId,
          hours,
          entryTypes: Array(7).fill('regular'),
          description: offset === 0 && pi === 2 ? '' : pool[(offset + pi) % pool.length],
          status,
          managerComment: REVIEW_COMMENTS[key],
          reviewedBy: status === 'approved' || status === 'returned' || status === 'rejected' ? projectManager(alloc.projectId) : undefined,
          reviewedAt: status !== 'draft' && status !== 'pending' ? `${addDays(weekStart, 7)}T11:20:00` : undefined,
        };
      });

      const submittedAt = `${addDays(weekStart, 4)}T17:40:00`;
      const history: ApprovalEvent[] = [];
      const anySubmitted = entries.some((e) => e.status !== 'draft');
      if (anySubmitted) {
        history.push(event({ at: submittedAt, actorId: emp.id, action: 'submitted', comment: 'Weekly timesheet submitted.' }));
        for (const e of entries) {
          if (e.status === 'pending' || e.status === 'draft') continue;
          history.push(event({
            at: e.reviewedAt!,
            actorId: e.reviewedBy!,
            action: e.status as ApprovalEvent['action'],
            projectId: e.projectId,
            comment: e.managerComment,
          }));
        }
      } else {
        history.push(event({ at: `${addDays(weekStart, Math.max(0, filledDays - 1))}T18:05:00`, actorId: emp.id, action: 'saved', comment: 'Draft saved.' }));
      }

      timesheets.push({
        id: `ts-${emp.id}-${weekStart}`,
        employeeId: emp.id,
        weekStart,
        entries,
        submittedAt: anySubmitted ? submittedAt : undefined,
        updatedAt: anySubmitted ? submittedAt : `${weekStart}T18:05:00`,
        history,
      });
    }
  }

  // --------------------------------------------------------------- overtime
  const overtime: OvertimeRequest[] = [];
  for (const ts of timesheets) {
    if (ts.entries.every((e) => e.status === 'draft')) continue;
    const emp = empById(ts.employeeId);
    const ot = computeOvertime(ts.entries, ts.weekStart, calOf(emp), seedOvertimePolicy);
    for (const [projectId, hours] of Object.entries(ot.byProject)) {
      const entry = ts.entries.find((e) => e.projectId === projectId);
      const status = entry?.status === 'approved' ? 'approved' : entry?.status === 'rejected' ? 'rejected' : 'pending';
      overtime.push({
        id: `ot-${overtime.length + 1}`,
        employeeId: emp.id,
        projectId,
        weekStart: ts.weekStart,
        hours,
        reason: 'Additional hours flagged automatically from the submitted timesheet.',
        source: 'timesheet',
        status,
        createdAt: ts.submittedAt ?? ts.updatedAt,
        timesheetId: ts.id,
        reviewerId: status === 'pending' ? undefined : projectManager(projectId),
        reviewerComment: status === 'approved' ? 'Approved — release support work.' : undefined,
      });
    }
  }
  overtime.push(
    {
      id: `ot-${overtime.length + 1}`,
      employeeId: 'emp-11',
      projectId: 'prj-uber',
      weekStart: addDays(W, 7),
      date: addDays(W, 12),
      hours: 4,
      reason: 'Weekend production data-migration cutover window agreed with the client.',
      source: 'pre_approval',
      status: 'pending',
      createdAt: `${addDays(W, -1)}T14:10:00`,
    },
    {
      id: `ot-${overtime.length + 2}`,
      employeeId: 'emp-10',
      projectId: 'prj-kore',
      weekStart: addDays(W, -7),
      date: addDays(W, -2),
      hours: 3,
      reason: 'Infrastructure patching during the Saturday maintenance window.',
      source: 'pre_approval',
      status: 'approved',
      createdAt: `${addDays(W, -9)}T10:00:00`,
      reviewerId: 'emp-02',
      reviewerComment: 'Approved. Please log the hours against Kore.ai.',
    },
  );

  return {
    version: 2,
    credentials: Object.fromEntries(employees.map((e) => [e.id, SAMPLE_PASSWORD])),
    employees,
    projects: seedProjects.map((p) => ({ ...p })),
    allocations: seedAllocations.map((x) => ({ ...x })),
    calendars,
    timesheets,
    leaves,
    overtime,
    departments: SAMPLE_DEPARTMENTS.map((name, i) => ({ id: `dep-${i + 1}`, name })),
    workLocations: SAMPLE_WORK_LOCATIONS.map((l, i) => ({
      id: `loc-${i + 1}`,
      name: l.label,
      country: l.country,
      defaultCalendarId: calendars.find((c) => c.country === l.country)?.id ?? null,
    })),
    policy: { ...seedOvertimePolicy },
    settings: { ...seedSettings },
  };
}
