/** Client projects and the resource allocations made to them. */
import { Schema, model, type InferSchemaType } from 'mongoose';
import { CASE_INSENSITIVE, isoDate, js, jsonSchema, uuidId } from './common.js';

export const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'inactive'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const endNotBeforeStart = {
  validator(this: { startDate?: string }, endDate: string) {
    // `this` is the document on save; on update validators it is the query, where startDate is undefined.
    return typeof this?.startDate !== 'string' || endDate >= this.startDate;
  },
  message: 'endDate must be on or after startDate.',
};

// ----------------------------------------------------------------- projects

const projectSchema = new Schema(
  {
    _id: uuidId,
    organisationId: { type: String, required: true, ref: 'Organisation' },
    /** Always stored upper-case, so the unique index makes codes unique regardless of case. */
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    client: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, default: '', maxlength: 2000 },
    managerId: { type: String, required: true, ref: 'Employee' },
    startDate: isoDate(),
    endDate: { ...isoDate(), validate: [isoDate().validate, endNotBeforeStart] },
    status: { type: String, required: true, enum: PROJECT_STATUSES, default: 'active' },
    billable: { type: Boolean, required: true, default: true },
    color: { type: String, required: true, match: [/^#[0-9a-f]{6}$/i, 'color must be a hex colour like #1a2b3c.'] },
  },
  { collection: 'projects', timestamps: true },
);
projectSchema.index({ organisationId: 1, code: 1 }, { name: 'projects_code_key', unique: true });
projectSchema.index({ organisationId: 1, name: 1 }, { name: 'projects_name_key', unique: true, collation: CASE_INSENSITIVE });
projectSchema.index({ managerId: 1 }, { name: 'projects_manager_idx' });

export type ProjectDoc = InferSchemaType<typeof projectSchema>;
export const Project = model('Project', projectSchema);
export const projectValidator = jsonSchema(['organisationId', 'code', 'name', 'client', 'managerId', 'startDate', 'endDate', 'status', 'billable', 'color'], {
  organisationId: js.string,
  code: { bsonType: 'string', minLength: 1, maxLength: 20 },
  name: { bsonType: 'string', minLength: 1, maxLength: 150 },
  client: { bsonType: 'string', minLength: 1, maxLength: 150 },
  description: js.string,
  managerId: js.string,
  startDate: js.isoDate,
  endDate: js.isoDate,
  status: js.enum(PROJECT_STATUSES),
  billable: js.bool,
  color: { bsonType: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
});

// -------------------------------------------------------------- allocations

/** One employee can be on several projects. Kept (not deleted) once time is logged against them. */
const allocationSchema = new Schema(
  {
    _id: uuidId,
    organisationId: { type: String, required: true, ref: 'Organisation' },
    employeeId: { type: String, required: true, ref: 'Employee' },
    projectId: { type: String, required: true, ref: 'Project' },
    projectRole: { type: String, default: 'Team member', maxlength: 100 },
    weeklyHours: { type: Number, required: true, min: [0.01, 'weeklyHours must be above 0.'], max: 60 },
    startDate: isoDate(),
    endDate: { ...isoDate(), validate: [isoDate().validate, endNotBeforeStart] },
    createdBy: { type: String, default: null, ref: 'Employee' },
  },
  { collection: 'allocations', timestamps: true },
);
allocationSchema.index({ employeeId: 1, startDate: 1, endDate: 1 }, { name: 'allocations_employee_idx' });
allocationSchema.index({ projectId: 1 }, { name: 'allocations_project_idx' });
allocationSchema.index({ organisationId: 1, startDate: 1 }, { name: 'allocations_organisation_idx' });

export type AllocationDoc = InferSchemaType<typeof allocationSchema>;
export const AllocationModel = model('Allocation', allocationSchema);
export const allocationValidator = jsonSchema(['organisationId', 'employeeId', 'projectId', 'weeklyHours', 'startDate', 'endDate'], {
  organisationId: js.string,
  employeeId: js.string,
  projectId: js.string,
  projectRole: js.string,
  weeklyHours: { bsonType: 'number', minimum: 0, exclusiveMinimum: true, maximum: 60 },
  startDate: js.isoDate,
  endDate: js.isoDate,
  createdBy: js.nullableString,
});
