import { config } from './config.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { checkDatabaseConnection, checkDatabaseWrite, connectMongo, describeMongoError, disconnectMongo, getDbIdentity, isDbUnavailable, isMongoConnected } from './mongo.js';
import { HttpError } from './http.js';
import { ensureMongoSchema } from './mongoSchema.js';
import { authRouter } from './routes/auth.js';
import { allocationsRouter } from './routes/allocations.js';
import { timesheetsRouter, approvalsRouter } from './routes/timesheets.js';
import { leaveRouter } from './routes/leave.js';
import { overtimeRouter } from './routes/overtime.js';
import { reportsRouter } from './routes/reports.js';
import { employeesRouter } from './routes/employees.js';
import { organisationRouter } from './routes/organisation.js';
import { calendarsRouter } from './routes/calendars.js';
import { projectsRouter } from './routes/projects.js';

const PORT = config.port;
const CORS_ORIGIN = config.corsOrigin;

export const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '100kb' }));

/** Liveness check — does not touch the database. */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'timesheet-api', timestamp: new Date().toISOString() });
});

/** Database connectivity check: pings MongoDB, reads the database name and verifies write access (nothing is left behind). */
app.get('/api/db-test', async (_req: Request, res: Response) => {
  try {
    if (!isMongoConnected()) await startDatabase(true);
    const { database, user } = await getDbIdentity();
    await checkDatabaseWrite();
    res.json({ status: 'connected', engine: 'mongodb', database, user, read: 'ok', write: 'ok' });
  } catch (err) {
    const message = describeMongoError(err);
    console.error(`[db] /api/db-test failed: ${message}`);
    res.status(503).json({ status: 'error', message });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/calendars', calendarsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api', organisationRouter); // /lookups, /settings, /policies/overtime
app.use('/api/allocations', allocationsRouter);
app.use('/api/timesheets', timesheetsRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/leave-requests', leaveRouter);
app.use('/api/overtime-requests', overtimeRouter);
app.use('/api/reports', reportsRouter);

app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ message: 'Not found' });
});

// Express 5 forwards errors from async handlers here. Responses use the { message, fieldErrors? } shape the frontend expects.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message, ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}) });
    return;
  }
  // Malformed JSON body and other client errors raised by Express middleware.
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ message: status === 400 ? 'The request body is not valid JSON.' : 'Bad request.' });
    return;
  }
  if (isDbUnavailable(err)) {
    console.error(`[db] ${describeMongoError(err)}`);
    res.status(503).json({ message: 'The database is unavailable. Please try again shortly.' });
    return;
  }
  console.error('[api] Unhandled error:', err);
  res.status(500).json({ message: 'Something went wrong on the server. Please try again.' });
});

const RETRY_MS = 15_000;
let retryTimer: NodeJS.Timeout | undefined;
let schemaReady = false;

/**
 * Connects, then creates any missing collections, validators and indexes. The API keeps running if
 * this fails, and the first connection is retried in the background until it succeeds (after that
 * the driver reconnects by itself).
 */
export async function startDatabase(throwOnFailure = false): Promise<void> {
  try {
    if (!isMongoConnected()) {
      if (throwOnFailure) await connectMongo();
      else if (!(await checkDatabaseConnection())) throw new Error('not connected');
    }
    if (!schemaReady) {
      await ensureMongoSchema();
      schemaReady = true;
      console.log('[db] Collections, validators and indexes are ready.');
    }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  } catch (err) {
    if (isMongoConnected()) console.error(`[db] Could not prepare the collections: ${describeMongoError(err)}`);
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void startDatabase();
      }, RETRY_MS);
      retryTimer.unref();
    }
    if (throwOnFailure) throw err;
  }
}

// Tests import the app and start the database themselves.
if (process.env.TIMESHEET_NO_LISTEN !== '1') {
  const server = app.listen(PORT, () => {
    console.log(`[api] Server listening on http://localhost:${PORT} (CORS origin: ${CORS_ORIGIN})`);
    void startDatabase();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[api] Port ${PORT} is already in use. Set a different PORT in backend/.env.`);
    } else {
      console.error('[api] Server error:', err.message);
    }
    process.exit(1);
  });

  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal} received, shutting down.`);
    server.close();
    await disconnectMongo().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
