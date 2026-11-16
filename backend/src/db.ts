import pg from 'pg';
import { config } from './config.js';

/** Shared PostgreSQL connection pool. Credentials come only from environment variables. */
export const pool = new pg.Pool({
  ...config.db,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// An idle client erroring (e.g. PostgreSQL restarted) must not crash the process.
pool.on('error', (err) => {
  console.error('[db] Unexpected error on an idle PostgreSQL client:', err.message);
});

/** Turns common PostgreSQL / network errors into an actionable message (never includes the password). */
export function describeDbError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const { host, port, user, database } = config.db;
  switch (e.code) {
    case 'ECONNREFUSED':
      return `Connection refused at ${host}:${port}. Is the PostgreSQL service running?`;
    case 'ENOTFOUND':
      return `Host "${host}" could not be resolved. Check PGHOST.`;
    case '28P01':
      return `Password authentication failed for user "${user}". Check PGPASSWORD in backend/.env.`;
    case '28000':
      return `User "${user}" is not allowed to connect. Check PGUSER and pg_hba.conf.`;
    case '3D000':
      return `Database "${database}" does not exist. Check PGDATABASE.`;
    default:
      return e.message ?? 'Unknown database error.';
  }
}

export interface DbIdentity {
  database: string;
  user: string;
}

/** SELECT current_database(), current_user */
export async function getDbIdentity(): Promise<DbIdentity> {
  const { rows } = await pool.query<DbIdentity>('SELECT current_database() AS database, current_user AS "user"');
  const row = rows[0];
  if (!row) throw new Error('Database returned no rows.');
  return row;
}

/** Logs whether the database is reachable at startup. Returns true when connected. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    const { database, user } = await getDbIdentity();
    console.log(`[db] Connected to PostgreSQL database "${database}" as "${user}".`);
    return true;
  } catch (err) {
    console.error(`[db] Could not connect to PostgreSQL: ${describeDbError(err)}`);
    console.error('[db] The API will keep running; GET /api/db-test will report the error.');
    return false;
  }
}
