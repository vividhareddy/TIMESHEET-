/**
 * Copies every record from the legacy PostgreSQL database into MongoDB.
 *
 *   npm run migrate:dry-run   read PostgreSQL, transform and validate; writes nothing anywhere
 *   npm run migrate           copy records that are not in MongoDB yet, then verify
 *   npm run migrate:verify    compare PostgreSQL with MongoDB record by record; writes nothing
 *
 * Safety:
 *  - PostgreSQL is opened read-only (default_transaction_read_only = on): it is never modified.
 *  - Ids are preserved, so the script is idempotent and can be re-run at any time.
 *  - By default existing MongoDB documents are never overwritten (only missing ones are inserted).
 *    Pass --overwrite to replace them with the PostgreSQL version.
 */
import pg from 'pg';
import mongoose, { type Model } from 'mongoose';
import { config } from '../config.js';
import { connectMongo, describeMongoError, disconnectMongo } from '../mongo.js';
import { ensureMongoSchema } from '../mongoSchema.js';
import { Calendar, Holiday } from '../models/calendar.js';
import { EmployeeModel } from '../models/employee.js';
import { Department, Organisation, SystemFlag, WorkLocation } from '../models/organisation.js';
import { AllocationModel, Project } from '../models/project.js';
import { LeaveRequestModel, OvertimeRequestModel, RevokedToken } from '../models/requests.js';
import { TimesheetEvent, TimesheetModel } from '../models/timesheet.js';
import * as t from './pgTransforms.js';
import type { Doc } from './pgTransforms.js';

type Mode = 'dry-run' | 'migrate' | 'verify';
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

export interface Dataset {
  name: string;
  model: AnyModel;
  docs: Doc[];
  /** Number of PostgreSQL rows the documents were built from (entries are folded into timesheets). */
  sourceRows: number;
}

const d = (column: string) => `to_char(${column}, 'YYYY-MM-DD') AS ${column}`;

/** One SELECT per table. Calendar dates are read as text so no time-zone conversion can shift them. */
const QUERIES: Record<string, string> = {
  organisations: 'SELECT * FROM organisations',
  departments: 'SELECT * FROM departments',
  work_locations: 'SELECT * FROM work_locations',
  calendars: 'SELECT * FROM calendars',
  holidays: `SELECT id, calendar_id, ${d('date')}, name, type FROM holidays`,
  employees: `SELECT id, organisation_id, employee_code, name, email, password_hash, phone, department, designation, work_location, country,
                     calendar_id, manager_id, system_role, status, weekly_capacity, ${d('join_date')}, last_login_at, created_at, updated_at FROM employees`,
  projects: `SELECT id, organisation_id, code, name, client, description, manager_id, ${d('start_date')}, ${d('end_date')},
                    status, billable, color, created_at, updated_at FROM projects`,
  allocations: `SELECT id, organisation_id, employee_id, project_id, project_role, weekly_hours, ${d('start_date')}, ${d('end_date')},
                       created_by, created_at, updated_at FROM allocations`,
  timesheets: `SELECT id, organisation_id, employee_id, ${d('week_start')}, submitted_at, created_at, updated_at FROM timesheets`,
  timesheet_entries: 'SELECT * FROM timesheet_entries',
  timesheet_events: 'SELECT * FROM timesheet_events',
  leave_requests: `SELECT id, organisation_id, employee_id, ${d('date')}, duration, hours, reason, status, applied_on, reviewer_id, reviewer_comment, reviewed_at FROM leave_requests`,
  overtime_requests: `SELECT id, organisation_id, employee_id, project_id, ${d('week_start')}, ${d('date')}, hours, reason, source, status,
                             timesheet_id, created_at, reviewer_id, reviewer_comment, reviewed_at FROM overtime_requests`,
  // Tokens that have already expired are useless and are not copied.
  revoked_tokens: 'SELECT jti, expires_at FROM revoked_tokens WHERE expires_at > now()',
};

export type Tables = Record<keyof typeof QUERIES, Row[]>;

/** Builds the MongoDB documents for every collection from the PostgreSQL rows. */
export function buildDatasets(rows: Tables): Dataset[] {
  const entriesByTimesheet = new Map<string, Row[]>();
  for (const e of rows.timesheet_entries!) {
    const list = entriesByTimesheet.get(e.timesheet_id) ?? [];
    list.push(e);
    entriesByTimesheet.set(e.timesheet_id, list);
  }
  const set = (name: string, model: AnyModel, source: Row[], fn: (r: Row) => Doc, extraRows = 0): Dataset => ({ name, model, docs: source.map(fn), sourceRows: source.length + extraRows });
  return [
    set('organisations', Organisation, rows.organisations!, t.organisation),
    set('departments', Department, rows.departments!, t.department),
    set('work_locations', WorkLocation, rows.work_locations!, t.workLocation),
    set('calendars', Calendar, rows.calendars!, t.calendar),
    set('holidays', Holiday, rows.holidays!, t.holiday),
    set('employees', EmployeeModel, rows.employees!, t.employee),
    set('projects', Project, rows.projects!, t.project),
    set('allocations', AllocationModel, rows.allocations!, t.allocation),
    set('timesheets', TimesheetModel, rows.timesheets!, (r) => t.timesheet(r, entriesByTimesheet.get(r.id) ?? []), rows.timesheet_entries!.length),
    set('timesheet_events', TimesheetEvent, rows.timesheet_events!, t.timesheetEvent),
    set('leave_requests', LeaveRequestModel, rows.leave_requests!, t.leaveRequest),
    set('overtime_requests', OvertimeRequestModel, rows.overtime_requests!, t.overtimeRequest),
    set('revoked_tokens', RevokedToken, rows.revoked_tokens!, t.revokedToken),
  ];
}

/** Checks every document against its Mongoose schema and every reference against its target collection. */
export async function validateDatasets(datasets: Dataset[], rows?: Tables): Promise<string[]> {
  const problems: string[] = [];
  const ids = new Map(datasets.map((s) => [s.name, new Set(s.docs.map((x) => x._id))]));
  const has = (collection: string, id: unknown) => id == null || ids.get(collection)!.has(id as string);
  const ref = (set: string, doc: Doc, field: string, target: string, value: unknown = doc[field]) => {
    if (!has(target, value)) problems.push(`${set} ${doc._id}: ${field} → missing ${target} ${String(value)}`);
  };

  for (const { name, model, docs } of datasets) {
    for (const doc of docs) {
      const error = await new model(doc).validate().then(() => null, (e: { errors?: Record<string, Error>; message: string }) => e);
      if (error) problems.push(`${name} ${doc._id}: ${error.errors ? Object.values(error.errors).map((e) => (e as Error).message).join('; ') : error.message}`);
      if ('organisationId' in doc) ref(name, doc, 'organisationId', 'organisations');
    }
  }
  const each = (name: string, fn: (doc: Doc) => void) => datasets.find((s) => s.name === name)!.docs.forEach(fn);
  each('work_locations', (x) => ref('work_locations', x, 'defaultCalendarId', 'calendars'));
  each('holidays', (x) => ref('holidays', x, 'calendarId', 'calendars'));
  each('employees', (x) => {
    ref('employees', x, 'calendarId', 'calendars');
    ref('employees', x, 'managerId', 'employees');
  });
  each('projects', (x) => ref('projects', x, 'managerId', 'employees'));
  each('allocations', (x) => {
    ref('allocations', x, 'employeeId', 'employees');
    ref('allocations', x, 'projectId', 'projects');
    ref('allocations', x, 'createdBy', 'employees');
  });
  each('timesheets', (x) => {
    ref('timesheets', x, 'employeeId', 'employees');
    for (const e of x.entries as Array<{ projectId: string; reviewedBy: string | null }>) {
      ref('timesheets', x, 'entries.projectId', 'projects', e.projectId);
      ref('timesheets', x, 'entries.reviewedBy', 'employees', e.reviewedBy);
    }
  });
  each('timesheet_events', (x) => {
    ref('timesheet_events', x, 'timesheetId', 'timesheets');
    ref('timesheet_events', x, 'actorId', 'employees');
    ref('timesheet_events', x, 'projectId', 'projects');
  });
  each('leave_requests', (x) => {
    ref('leave_requests', x, 'employeeId', 'employees');
    ref('leave_requests', x, 'reviewerId', 'employees');
  });
  each('overtime_requests', (x) => {
    ref('overtime_requests', x, 'employeeId', 'employees');
    ref('overtime_requests', x, 'projectId', 'projects');
    ref('overtime_requests', x, 'timesheetId', 'timesheets');
    ref('overtime_requests', x, 'reviewerId', 'employees');
  });

  if (rows) {
    // Every timesheet_entries row must have ended up embedded in a timesheet.
    const embedded = datasets.find((s) => s.name === 'timesheets')!.docs.reduce((n, x) => n + (x.entries as unknown[]).length, 0);
    if (embedded !== rows.timesheet_entries!.length) problems.push(`timesheet_entries: ${rows.timesheet_entries!.length} rows in PostgreSQL but ${embedded} embedded entries`);
  }
  return problems;
}

// ------------------------------------------------------------------- write

/** Inserts the documents that are missing (or replaces all of them with --overwrite). Returns how many were written. */
export async function writeDataset({ model, docs }: Dataset, overwrite: boolean): Promise<{ inserted: number; replaced: number; kept: number }> {
  let inserted = 0;
  let replaced = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = docs.slice(i, i + 500);
    const ops = batch.map((doc) => {
      const { _id, ...fields } = doc;
      return overwrite
        ? { replaceOne: { filter: { _id }, replacement: fields, upsert: true } }
        : { updateOne: { filter: { _id }, update: { $setOnInsert: fields }, upsert: true } };
    });
    // The native collection is used so stored values (timestamps, casing) are exactly the migrated ones.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await model.collection.bulkWrite(ops as any, { ordered: false });
    inserted += result.upsertedCount;
    replaced += overwrite ? result.modifiedCount : 0;
  }
  return { inserted, replaced, kept: docs.length - inserted - replaced };
}

// ------------------------------------------------------------------ verify

/** Fields the running application changes as a matter of course, so they are not part of the comparison. */
const VOLATILE = new Set(['__v', 'lastLoginAt']);

/** Stable JSON for comparison: sorted keys, dates as ISO strings, volatile fields ignored. */
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export interface VerifyResult {
  name: string;
  source: number;
  found: number;
  missing: string[];
  different: string[];
  extra: number;
}

/** Compares every migrated document with what is stored in MongoDB. */
export async function verifyDataset({ name, model, docs }: Dataset): Promise<VerifyResult> {
  const stored = new Map<string, unknown>();
  for await (const doc of model.collection.find({})) stored.set(String(doc._id), doc);
  const missing: string[] = [];
  const different: string[] = [];
  for (const doc of docs) {
    const other = stored.get(doc._id);
    if (!other) missing.push(doc._id);
    else if (JSON.stringify(canonical(doc)) !== JSON.stringify(canonical(other))) different.push(doc._id);
  }
  const sourceIds = new Set(docs.map((x) => x._id));
  const extra = [...stored.keys()].filter((id) => !sourceIds.has(id)).length;
  return { name, source: docs.length, found: docs.length - missing.length, missing, different, extra };
}

// --------------------------------------------------------------------- run

async function readPostgres(): Promise<Tables> {
  const { host, port, database, user, password } = config.db;
  const missing = Object.entries({ PGHOST: host, PGDATABASE: database, PGUSER: user, PGPASSWORD: password }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing PostgreSQL settings in backend/.env: ${missing.join(', ')} (see backend/.env.example).`);

  // Read-only session: this script cannot change the PostgreSQL database even by mistake.
  const pool = new pg.Pool({ host, port, database, user, password, max: 2, connectionTimeoutMillis: 5_000, options: '-c default_transaction_read_only=on' });
  try {
    const { rows: who } = await pool.query<{ db: string; usr: string }>('SELECT current_database() AS db, current_user AS usr');
    console.log(`[pg] Connected to PostgreSQL database "${who[0]!.db}" as "${who[0]!.usr}" (read-only).`);
    const out: Tables = {};
    const client = await pool.connect();
    try {
      // One repeatable-read snapshot, so all tables are read at the same moment.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      for (const [table, sql] of Object.entries(QUERIES)) {
        const exists = await client.query<{ t: string | null }>('SELECT to_regclass($1) AS t', [`public.${table}`]);
        out[table] = exists.rows[0]?.t ? (await client.query(sql)).rows : [];
        if (!exists.rows[0]?.t) console.warn(`[pg] Table "${table}" does not exist; treating it as empty.`);
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    return out;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'ECONNREFUSED') throw new Error(`PostgreSQL refused the connection at ${host}:${port}. Is the PostgreSQL service running?`);
    if (e.code === '28P01') throw new Error('PostgreSQL rejected the password. Check PGPASSWORD in backend/.env.');
    if (e.code === '3D000') throw new Error(`PostgreSQL database "${database}" does not exist. Check PGDATABASE.`);
    throw err;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const mode: Mode = args.has('--dry-run') ? 'dry-run' : args.has('--verify') ? 'verify' : 'migrate';
  const overwrite = args.has('--overwrite');
  console.log(`PostgreSQL → MongoDB migration (${mode}${overwrite ? ', overwrite' : ''})\n`);

  const rows = await readPostgres();
  const datasets = buildDatasets(rows);
  console.log('\nPostgreSQL rows read:');
  for (const [table, list] of Object.entries(rows)) console.log(`  ${pad(table, 20)} ${list.length}`);

  const problems = await validateDatasets(datasets, rows);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s) found in the source data — nothing was written:`);
    for (const p of problems.slice(0, 50)) console.error(`  - ${p}`);
    if (problems.length > 50) console.error(`  … and ${problems.length - 50} more`);
    return 1;
  }
  console.log('\nAll documents pass schema validation and every reference resolves.');
  if (mode === 'dry-run') {
    console.log('\nDry run complete: nothing was written to MongoDB. Run "npm run migrate" to copy the data.');
    return 0;
  }

  await connectMongo();
  console.log(`\n[db] Connected to MongoDB database "${mongoose.connection.db!.databaseName}".`);
  await ensureMongoSchema();

  if (mode === 'migrate') {
    console.log('\nWriting to MongoDB:');
    for (const set of datasets) {
      const r = await writeDataset(set, overwrite);
      console.log(`  ${pad(set.name, 20)} inserted ${pad(r.inserted, 6)} ${overwrite ? `replaced ${pad(r.replaced, 6)}` : `already present ${pad(r.kept, 6)}`}`);
    }
    // Marks first-run setup as done, exactly as the application does when it creates the organisation.
    if (rows.organisations!.length) await SystemFlag.collection.updateOne({ _id: 'setup' } as never, { $setOnInsert: { at: new Date() } }, { upsert: true });
  }

  console.log('\nVerification (PostgreSQL vs MongoDB):');
  console.log(`  ${pad('collection', 20)} ${pad('source', 8)} ${pad('found', 8)} ${pad('missing', 8)} ${pad('different', 10)} extra-in-mongo`);
  let failed = false;
  for (const set of datasets) {
    const v = await verifyDataset(set);
    console.log(`  ${pad(v.name, 20)} ${pad(v.source, 8)} ${pad(v.found, 8)} ${pad(v.missing.length, 8)} ${pad(v.different.length, 10)} ${v.extra}`);
    for (const id of v.missing.slice(0, 5)) console.error(`      missing   ${id}`);
    for (const id of v.different.slice(0, 5)) console.error(`      different ${id}`);
    // Revoked tokens expire by themselves, so a missing one is not a failure.
    if (v.name !== 'revoked_tokens' && (v.missing.length || v.different.length)) failed = true;
  }
  if (failed) {
    console.error('\nVerification FAILED: MongoDB does not match PostgreSQL for the records listed above.');
    console.error('"different" usually means the record was changed in MongoDB after it was migrated; use --overwrite only if PostgreSQL is still the source of truth.');
    return 1;
  }
  console.log('\nVerification passed: every PostgreSQL record is present in MongoDB with identical values.');
  console.log('The PostgreSQL database was not modified and remains available as a backup.');
  return 0;
}

// Only run when executed directly (the test suite imports the functions above).
if (process.argv[1] && /migratePgToMongo\.(ts|js)$/.test(process.argv[1])) {
  main()
    .catch((err) => {
      console.error(`\nMigration failed: ${describeMongoError(err)}`);
      return 1;
    })
    .then(async (code) => {
      await disconnectMongo().catch(() => undefined);
      process.exit(code);
    });
}
