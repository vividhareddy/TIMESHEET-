import mongoose, { type Model } from 'mongoose';
import { Organisation, Department, WorkLocation, SystemFlag, organisationValidator, departmentValidator, workLocationValidator } from './models/organisation.js';
import { Calendar, Holiday, calendarValidator, holidayValidator } from './models/calendar.js';
import { EmployeeModel, employeeValidator } from './models/employee.js';
import { Project, AllocationModel, projectValidator, allocationValidator } from './models/project.js';
import { TimesheetModel, TimesheetEvent, timesheetValidator, timesheetEventValidator } from './models/timesheet.js';
import {
  LeaveRequestModel, OvertimeRequestModel, RevokedToken,
  leaveRequestValidator, overtimeRequestValidator, revokedTokenValidator,
} from './models/requests.js';

/** Every collection the API owns, with the server-side ($jsonSchema) validator MongoDB enforces on writes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const COLLECTIONS: Array<{ model: Model<any>; validator?: Record<string, unknown> }> = [
  { model: Organisation, validator: organisationValidator },
  { model: Department, validator: departmentValidator },
  { model: WorkLocation, validator: workLocationValidator },
  { model: Calendar, validator: calendarValidator },
  { model: Holiday, validator: holidayValidator },
  { model: EmployeeModel, validator: employeeValidator },
  { model: Project, validator: projectValidator },
  { model: AllocationModel, validator: allocationValidator },
  { model: TimesheetModel, validator: timesheetValidator },
  { model: TimesheetEvent, validator: timesheetEventValidator },
  { model: LeaveRequestModel, validator: leaveRequestValidator },
  { model: OvertimeRequestModel, validator: overtimeRequestValidator },
  { model: RevokedToken, validator: revokedTokenValidator },
  { model: SystemFlag },
];

/**
 * Creates the collections, validators and indexes this API needs if they do not exist yet.
 * Idempotent: safe to run on every start; existing documents are never modified or dropped.
 * Collections are created up front because they must exist before being used in a transaction.
 */
export async function ensureMongoSchema(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected to MongoDB.');
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const { model, validator } of COLLECTIONS) {
    const name = model.collection.collectionName;
    if (!existing.has(name)) {
      await db.createCollection(name, validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {});
    } else if (validator) {
      await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    }
    await model.createIndexes();
  }
}
