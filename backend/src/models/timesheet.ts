/** Weekly timesheets (with one embedded entry per project) and their audit trail. */
import { Schema, model, type InferSchemaType } from 'mongoose';
import { js, jsonSchema, mondayDate, uuidId } from './common.js';

export const ENTRY_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'returned'] as const;
export const EVENT_ACTIONS = ['saved', 'submitted', 'resubmitted', 'approved', 'rejected', 'returned', 'modified', 'reopened'] as const;

/** Per-day label on a timesheet entry — independent of the approval `status` above. */
export const ENTRY_TYPES = ['regular', 'half_day', 'overtime', 'leave', 'holiday'] as const;

const sevenDays = (allowNull: boolean) => ({
  validator: (hours: number[] | null | undefined) =>
    hours == null || hours.length === 0 ? allowNull : hours.length === 7 && hours.every((h) => typeof h === 'number' && h >= 0 && h <= 24),
  message: '{PATH} must hold 7 daily values between 0 and 24 (Monday–Sunday).',
});

const sevenEntryTypes = {
  validator: (types: string[] | null | undefined) => types == null || types.length === 0 || (types.length === 7 && types.every((t) => (ENTRY_TYPES as readonly string[]).includes(t))),
  message: '{PATH} must hold 7 daily entry types (Monday–Sunday).',
};

/**
 * One row per project on a weekly timesheet; hours[0..6] = Monday..Sunday. Approved per project.
 * Entries are embedded because they are always read and written with their timesheet; the array
 * order is the display order. A project appears at most once per timesheet (enforced on save).
 */
const entrySchema = new Schema(
  {
    projectId: { type: String, required: true, ref: 'Project' },
    hours: { type: [Number], required: true, validate: sevenDays(false) },
    /** Per-day label (regular/half_day/overtime/leave); defaults to 'regular' for every day. */
    entryTypes: { type: [String], default: () => Array(7).fill('regular'), validate: sevenEntryTypes },
    /** The employee's hours before an approver modified them; unset when never modified. */
    originalHours: { type: [Number], default: undefined, validate: sevenDays(true) },
    description: { type: String, default: '' },
    status: { type: String, required: true, enum: ENTRY_STATUSES, default: 'draft' },
    managerComment: { type: String, default: null },
    reviewedBy: { type: String, default: null, ref: 'Employee' },
    reviewedAt: { type: Date, default: null },
    updatedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

/** One weekly timesheet per employee per week (weeks start on Monday). */
const timesheetSchema = new Schema(
  {
    _id: uuidId,
    organisationId: { type: String, required: true, ref: 'Organisation' },
    employeeId: { type: String, required: true, ref: 'Employee' },
    weekStart: mondayDate,
    submittedAt: { type: Date, default: null },
    entries: {
      type: [entrySchema],
      default: () => [],
      validate: {
        validator: (entries: Array<{ projectId: string }>) => new Set(entries.map((e) => e.projectId)).size === entries.length,
        message: 'Each project can appear only once on a timesheet.',
      },
    },
  },
  { collection: 'timesheets', timestamps: true },
);
timesheetSchema.index({ employeeId: 1, weekStart: 1 }, { name: 'timesheets_employee_week_key', unique: true });
timesheetSchema.index({ organisationId: 1, weekStart: -1 }, { name: 'timesheets_week_idx' });
timesheetSchema.index({ 'entries.projectId': 1, 'entries.status': 1 }, { name: 'timesheet_entries_project_idx' });
timesheetSchema.index({ organisationId: 1, 'entries.status': 1 }, { name: 'timesheet_entries_status_idx' });

export type TimesheetEntryDoc = InferSchemaType<typeof entrySchema>;
export type TimesheetDoc = InferSchemaType<typeof timesheetSchema>;
export const TimesheetModel = model('Timesheet', timesheetSchema);

const hoursArray = { bsonType: 'array', minItems: 7, maxItems: 7, items: { bsonType: 'number', minimum: 0, maximum: 24 } };
export const timesheetValidator = jsonSchema(['organisationId', 'employeeId', 'weekStart', 'entries'], {
  organisationId: js.string,
  employeeId: js.string,
  weekStart: js.isoDate,
  submittedAt: js.nullableDate,
  entries: {
    bsonType: 'array',
    items: {
      bsonType: 'object',
      required: ['projectId', 'hours', 'status'],
      properties: {
        projectId: js.string,
        hours: hoursArray,
        entryTypes: { bsonType: 'array', minItems: 7, maxItems: 7, items: js.enum(ENTRY_TYPES) },
        originalHours: hoursArray,
        description: js.string,
        status: js.enum(ENTRY_STATUSES),
        managerComment: js.nullableString,
        reviewedBy: js.nullableString,
        reviewedAt: js.nullableDate,
        updatedAt: js.date,
      },
    },
  },
});

/** Audit trail: saves, submissions, approvals, rejections, returns, modifications and reopenings. */
const timesheetEventSchema = new Schema(
  {
    _id: uuidId,
    timesheetId: { type: String, required: true, ref: 'Timesheet' },
    at: { type: Date, required: true, default: () => new Date() },
    actorId: { type: String, required: true, ref: 'Employee' },
    action: { type: String, required: true, enum: EVENT_ACTIONS },
    /** Set for per-project actions (approve / reject / return / modify); null for whole-timesheet actions. */
    projectId: { type: String, default: null, ref: 'Project' },
    comment: { type: String, default: null },
  },
  { collection: 'timesheet_events' },
);
timesheetEventSchema.index({ timesheetId: 1, at: 1 }, { name: 'timesheet_events_timesheet_idx' });

export type TimesheetEventDoc = InferSchemaType<typeof timesheetEventSchema>;
export const TimesheetEvent = model('TimesheetEvent', timesheetEventSchema);
export const timesheetEventValidator = jsonSchema(['timesheetId', 'at', 'actorId', 'action'], {
  timesheetId: js.string,
  at: js.date,
  actorId: js.string,
  action: js.enum(EVENT_ACTIONS),
  projectId: js.nullableString,
  comment: js.nullableString,
});
