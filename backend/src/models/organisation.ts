/** Organisation (with its settings and overtime policy), departments and work locations. */
import { Schema, model, type InferSchemaType } from 'mongoose';
import { CASE_INSENSITIVE, COUNTRIES, js, jsonSchema, uuidId } from './common.js';

// ------------------------------------------------------------ organisations

const organisationSchema = new Schema(
  {
    _id: uuidId,
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 150 },
    /** Organisation-wide timesheet settings; defaults are applied in code when a key is missing. */
    settings: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
    /** Overtime policy; defaults are applied in code when a key is missing. */
    overtimePolicy: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
  },
  { collection: 'organisations', timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
organisationSchema.index({ name: 1 }, { name: 'organisations_name_key', unique: true, collation: CASE_INSENSITIVE });

export type OrganisationDoc = InferSchemaType<typeof organisationSchema>;
export const Organisation = model('Organisation', organisationSchema);
export const organisationValidator = jsonSchema(['name', 'settings', 'overtimePolicy', 'createdAt'], {
  name: { bsonType: 'string', minLength: 1, maxLength: 150 },
  settings: { bsonType: 'object' },
  overtimePolicy: { bsonType: 'object' },
  createdAt: js.date,
});

// -------------------------------------------------------------- departments

const departmentSchema = new Schema(
  {
    _id: uuidId,
    organisationId: { type: String, required: true, ref: 'Organisation' },
    name: { type: String, required: true, trim: true, maxlength: 100 },
  },
  { collection: 'departments' },
);
departmentSchema.index({ organisationId: 1, name: 1 }, { name: 'departments_name_key', unique: true, collation: CASE_INSENSITIVE });

export type DepartmentDoc = InferSchemaType<typeof departmentSchema>;
export const Department = model('Department', departmentSchema);
export const departmentValidator = jsonSchema(['organisationId', 'name'], {
  organisationId: js.string,
  name: { bsonType: 'string', minLength: 1, maxLength: 100 },
});

// ----------------------------------------------------------- work locations

const workLocationSchema = new Schema(
  {
    _id: uuidId,
    organisationId: { type: String, required: true, ref: 'Organisation' },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    country: { type: String, required: true, enum: COUNTRIES },
    defaultCalendarId: { type: String, default: null, ref: 'Calendar' },
  },
  { collection: 'work_locations' },
);
workLocationSchema.index({ organisationId: 1, name: 1 }, { name: 'work_locations_name_key', unique: true, collation: CASE_INSENSITIVE });

export type WorkLocationDoc = InferSchemaType<typeof workLocationSchema>;
export const WorkLocation = model('WorkLocation', workLocationSchema);
export const workLocationValidator = jsonSchema(['organisationId', 'name', 'country'], {
  organisationId: js.string,
  name: { bsonType: 'string', minLength: 1, maxLength: 100 },
  country: js.enum(COUNTRIES),
  defaultCalendarId: js.nullableString,
});

// ------------------------------------------------------------- system flags

/**
 * Singleton markers. `{ _id: 'setup' }` is inserted in the same transaction that creates the
 * organisation and first administrator, so two concurrent first-run requests cannot both succeed.
 */
const systemFlagSchema = new Schema({ _id: { type: String, required: true }, at: { type: Date, required: true, default: () => new Date() } }, { collection: 'system_flags' });
export const SystemFlag = model('SystemFlag', systemFlagSchema);
