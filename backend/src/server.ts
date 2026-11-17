import { config } from './config.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { checkDatabaseConnection, checkDatabaseWrite, describeDbError, getDbIdentity, pool } from './db.js';
import { HttpError, isDbUnavailable } from './http.js';
import { ensureSchema } from './schema.js';
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
import { policyDocumentsRouter } from './routes/policyDocuments.js';
import { otAssistantRouter } from './routes/otAssistant.js';

const PORT = config.port;
const CORS_ORIGIN = config.corsOrigin;

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
// Policy documents can be long; every other route keeps the small default limit.
app.use('/api/policy-documents', express.json({ limit: '1mb' }));
app.use(express.json({ limit: '100kb' }));

/** Liveness check — does not touch the database. */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'timesheet-api', timestamp: new Date().toISOString() });
});

/** Database connectivity check: reads current_database() and verifies write access (nothing is persisted). */
app.get('/api/db-test', async (_req: Request, res: Response) => {
  try {
    const { database, user } = await getDbIdentity();
    await checkDatabaseWrite();
    res.json({ status: 'connected', database, user, read: 'ok', write: 'ok' });
  } catch (err) {
    const message = describeDbError(err);
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
app.use('/api/policy-documents', policyDocumentsRouter);
app.use('/api/ot-assistant', otAssistantRouter);

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
    console.error(`[db] ${describeDbError(err)}`);
    res.status(503).json({ message: 'The database is unavailable. Please try again shortly.' });
    return;
  }
  console.error('[api] Unhandled error:', err);
  res.status(500).json({ message: 'Something went wrong on the server. Please try again.' });
});

const server = app.listen(PORT, () => {
  console.log(`[api] Server listening on http://localhost:${PORT} (CORS origin: ${CORS_ORIGIN})`);
  void startDatabase();
});

/** Verifies the connection, then creates any missing tables. The API keeps running if this fails. */
async function startDatabase(): Promise<void> {
  if (!(await checkDatabaseConnection())) return;
  try {
    await ensureSchema();
    console.log('[db] Schema ready.');
  } catch (err) {
    console.error(`[db] Could not create the schema: ${describeDbError(err)}`);
  }
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[api] Port ${PORT} is already in use. Set a different PORT in backend/.env.`);
  } else {
    console.error('[api] Server error:', err.message);
  }
  process.exit(1);
});

async function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down.`);
  server.close();
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
