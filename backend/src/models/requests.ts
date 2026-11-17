/** Leave requests, overtime requests and revoked (signed-out) JWTs. */
import { Schema, model, type InferSchemaType } from 'mongoose';
import { isoDate, js, jsonSchema, mondayDate, uuidId } from './common.js';

// ----------------------------------------------------------- leave requests

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export const LEAVE_DURATIONS = ['full', 'half'] as const;

/** Withdrawn requests are kept with status 'withdrawn' (hidden from the API) instead of being deleted. */
const leaveRequestSchema = new Schema(
  {
    _id: uuidId,
    organisationId: { type: String, required: true, ref: 'Organisation' },
    employeeId: { type: String, required: true, ref: 'Employee' },
    date: isoDate(),
    duration: { type: String, required: true, enum: LEAVE_DURATIONS },
    hours: { type: Number, required: true, min: [0.01, 'hours must be above 0.'] },
    reason: { type: String, required: true },
    status: { type: String, required: true, enum: LEAVE_STATUSES, default: 'pending' },
    appliedOn: { type: Date, required: true, default: () => new Date() },
    reviewerId: { type: String, default: null, ref: 'Employee' },
    reviewerComment: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
  },
  { collection: 'leave_requests' },
);
// At most one live (pending or approved) request per employee per day.
leaveRequestSchema.index(
  { employeeId: 1, date: 1 },
  { name: 'leave_requests_active_day_key', unique: true, partialFilterExpression: { status: { $in: ['pending', 'approved'] } } },
);
leaveRequestSchema.index({ organisationId: 1, status: 1, date: -1 }, { name: 'leave_requests_organisation_idx' });

export type LeaveRequestDoc = InferSchemaType<typeof leaveRequestSchema>;
export const LeaveRequestModel = model('LeaveRequest', leaveRequestSchema);
export const leaveRequestValidator = jsonSchema(['organisationId', 'employeeId', 'date', 'duration', 'hours', 'reason', 'status', 'appliedOn'], {
  organisationId: js.string,
  employeeId: js.string,
  date: js.isoDate,
  duration: js.enum(LEAVE_DURATIONS),
  hours: { bsonType: 'number', minimum: 0, exclusiveMinimum: true },
  reason: js.string,
  status: js.enum(LEAVE_STATUSES),
  appliedOn: js.date,
  reviewerId: js.nullableString,
  reviewerComment: js.nullableString,
  reviewedAt: js.nullableDate,
});

// -------------------------------------------------------- overtime requests

export const OVERTIME_SOURCES = ['timesheet', 'pre_approval'] as const;
export const OVERTIME_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** Kept separate from ordinary timesheet hours: auto-flagged from timesheets or requested in advance. */
const overtimeRequestSchema = new Schema(
  {
    _id: uuidId,
    organisationId: { type: String, required: true, ref: 'Organisation' },
    employeeId: { type: String, required: true, ref: 'Employee' },
    projectId: { type: String, required: true, ref: 'Project' },
    weekStart: mondayDate,
    /** The specific day, for pre-approval requests; null for records flagged from a whole timesheet. */
    date: { ...isoDate(false), default: null },
    hours: { type: Number, required: true, min: [0.01, 'hours must be above 0.'] },
    reason: { type: String, required: true },
    source: { type: String, required: true, enum: OVERTIME_SOURCES },
    status: { type: String, required: true, enum: OVERTIME_STATUSES, default: 'pending' },
    /** Set exactly when source is 'timesheet'. */
    timesheetId: {
      type: String,
      default: null,
      ref: 'Timesheet',
      validate: {
        validator(this: { source?: string }, timesheetId: string | null) {
          return this?.source === undefined || (this.source === 'timesheet') === (timesheetId != null);
        },
        message: 'timesheetId must be set for timesheet overtime and empty for pre-approval requests.',
      },
    },
    reviewerId: { type: String, default: null, ref: 'Employee' },
    reviewerComment: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
  },
  { collection: 'overtime_requests', timestamps: { createdAt: true, updatedAt: false } },
);
// One auto-flagged record per timesheet per project.
overtimeRequestSchema.index(
  { timesheetId: 1, projectId: 1 },
  { name: 'overtime_timesheet_project_key', unique: true, partialFilterExpression: { source: 'timesheet' } },
);
overtimeRequestSchema.index({ employeeId: 1, weekStart: 1 }, { name: 'overtime_requests_employee_idx' });
overtimeRequestSchema.index({ organisationId: 1, weekStart: -1 }, { name: 'overtime_requests_organisation_idx' });
overtimeRequestSchema.index({ projectId: 1, status: 1 }, { name: 'overtime_requests_project_idx' });

export type OvertimeRequestDoc = InferSchemaType<typeof overtimeRequestSchema>;
export const OvertimeRequestModel = model('OvertimeRequest', overtimeRequestSchema);
export const overtimeRequestValidator = jsonSchema(['organisationId', 'employeeId', 'projectId', 'weekStart', 'hours', 'reason', 'source', 'status', 'createdAt'], {
  organisationId: js.string,
  employeeId: js.string,
  projectId: js.string,
  weekStart: js.isoDate,
  date: js.nullableIsoDate,
  hours: { bsonType: 'number', minimum: 0, exclusiveMinimum: true },
  reason: js.string,
  source: js.enum(OVERTIME_SOURCES),
  status: js.enum(OVERTIME_STATUSES),
  timesheetId: js.nullableString,
  createdAt: js.date,
  reviewerId: js.nullableString,
  reviewerComment: js.nullableString,
  reviewedAt: js.nullableDate,
});

// ----------------------------------------------------------- revoked tokens

/** Signed-out JWTs by token id. MongoDB deletes each one automatically once it would have expired anyway. */
const revokedTokenSchema = new Schema(
  {
    /** The token's jti claim. */
    _id: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'revoked_tokens' },
);
revokedTokenSchema.index({ expiresAt: 1 }, { name: 'revoked_tokens_expiry_ttl', expireAfterSeconds: 0 });

export const RevokedToken = model('RevokedToken', revokedTokenSchema);
export const revokedTokenValidator = jsonSchema(['expiresAt'], { expiresAt: js.date });
