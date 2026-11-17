import { Schema, model, type InferSchemaType } from 'mongoose';
import { COUNTRIES, isoDate, js, jsonSchema, uuidId } from './common.js';
import { todayISO } from '../lib/dates.js';

export type Role = 'admin' | 'manager' | 'associate';
export const ROLES = ['admin', 'manager', 'associate'] as const satisfies readonly Role[];
export const EMPLOYEE_STATUSES = ['active', 'inactive'] as const;

/** The Employee shape the frontend expects (src/types/index.ts). Never includes the password hash. */
export interface Employee {
  id: string;
  employeeCode: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  designation: string;
  workLocation: string;
  country: string;
  calendarId: string;
  managerId: string | null;
  systemRole: Role;
  status: 'active' | 'inactive';
  weeklyCapacity: number;
  joinDate: string;
}

const employeeSchema = new Schema(
  {
    _id: uuidId,
    organisationId: { type: String, required: true, ref: 'Organisation' },
    employeeCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    /** Always stored lower-case, so the unique index makes emails unique regardless of case. */
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    /** bcrypt hash. Never returned by the API (see employeeFromDoc). */
    passwordHash: { type: String, required: true, maxlength: 100 },
    phone: { type: String, default: '', maxlength: 30 },
    department: { type: String, default: '', maxlength: 100 },
    designation: { type: String, default: '', maxlength: 100 },
    workLocation: { type: String, default: '', maxlength: 100 },
    country: { type: String, enum: COUNTRIES, default: 'US' },
    calendarId: { type: String, default: null, ref: 'Calendar' },
    managerId: { type: String, default: null, ref: 'Employee' },
    systemRole: { type: String, required: true, enum: ROLES },
    status: { type: String, required: true, enum: EMPLOYEE_STATUSES, default: 'active' },
    weeklyCapacity: { type: Number, required: true, min: 0, default: 40 },
    joinDate: { ...isoDate(), default: () => todayISO() },
    lastLoginAt: { type: Date, default: null },
  },
  { collection: 'employees', timestamps: true },
);
employeeSchema.index({ employeeCode: 1 }, { name: 'employees_employee_code_key', unique: true });
employeeSchema.index({ email: 1 }, { name: 'employees_email_key', unique: true });
employeeSchema.index({ organisationId: 1, name: 1 }, { name: 'employees_organisation_idx' });
employeeSchema.index({ organisationId: 1, managerId: 1 }, { name: 'employees_manager_idx' });

export type EmployeeDoc = InferSchemaType<typeof employeeSchema>;
export const EmployeeModel = model('Employee', employeeSchema);
export const employeeValidator = jsonSchema(['organisationId', 'employeeCode', 'name', 'email', 'passwordHash', 'systemRole', 'status', 'weeklyCapacity', 'joinDate'], {
  organisationId: js.string,
  employeeCode: { bsonType: 'string', minLength: 1, maxLength: 20 },
  name: { bsonType: 'string', minLength: 1, maxLength: 100 },
  email: { bsonType: 'string', minLength: 3, maxLength: 254 },
  passwordHash: { bsonType: 'string', minLength: 20, maxLength: 100 },
  phone: js.string,
  department: js.string,
  designation: js.string,
  workLocation: js.string,
  country: js.enum(COUNTRIES),
  calendarId: js.nullableString,
  managerId: js.nullableString,
  systemRole: js.enum(ROLES),
  status: js.enum(EMPLOYEE_STATUSES),
  weeklyCapacity: js.number(0),
  joinDate: js.isoDate,
  lastLoginAt: js.nullableDate,
});

/** Fields to select when the password hash is not needed. */
export const EMPLOYEE_PUBLIC_FIELDS = '-passwordHash';

/** An employee document as read with .lean(). */
export interface EmployeeLean {
  _id: string;
  organisationId: string;
  employeeCode: string;
  name: string;
  email: string;
  passwordHash?: string;
  phone?: string;
  department?: string;
  designation?: string;
  workLocation?: string;
  country?: string;
  calendarId?: string | null;
  managerId?: string | null;
  systemRole: Role;
  status: 'active' | 'inactive';
  weeklyCapacity: number;
  joinDate: string;
}

/** Stored document → the Employee shape the frontend expects. Never includes the password hash. */
export function employeeFromDoc(d: EmployeeLean): Employee {
  return {
    id: d._id,
    employeeCode: d.employeeCode,
    name: d.name,
    email: d.email,
    phone: d.phone ?? '',
    department: d.department ?? '',
    designation: d.designation ?? '',
    workLocation: d.workLocation ?? '',
    country: d.country ?? 'US',
    calendarId: d.calendarId ?? '',
    managerId: d.managerId ?? null,
    systemRole: d.systemRole,
    status: d.status,
    weeklyCapacity: d.weeklyCapacity,
    joinDate: d.joinDate,
  };
}
