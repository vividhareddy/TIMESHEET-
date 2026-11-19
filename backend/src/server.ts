import { config } from './config.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
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
import { lmsRouter } from './routes/lms.js';
import { LMS_MOUNT, lmsProxy, startLms, stopLms } from './lmsProxy.js';

const PORT = config.port;
const CORS_ORIGIN = config.corsOrigin;

export const app = express();
// The LMS under /lms is proxied as-is (before the JSON body parser, so request bodies stream through untouched).
app.use(lmsProxy);
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
app.use('/api/lms', lmsRouter);

app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ message: 'Not found' });
});

// Everything that isn't an /api/* request falls through to the React app below.
const NOT_API = /^(?!\/api).*/;
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');

/**
 * Serves the React frontend from this same Express process/port.
 * Dev: Vite runs in middleware mode (no separate Vite server/port — see https://vite.dev/guide/ssr#setting-up-the-dev-server).
 * Production: the prebuilt `frontend/dist` is served as static files, with an SPA fallback to index.html.
 *
 * `httpServer` is the one real HTTP server (created in main(), listening on PORT): Vite's HMR websocket
 * attaches to it instead of opening a server/port of its own (which would default to 5173).
 */
async function setupFrontend(httpServer: http.Server): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(frontendRoot, 'dist');
    app.use(express.static(distDir));
    app.use(NOT_API, (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
    return;
  }

  // Config is passed inline (mirroring frontend/vite.config.ts) rather than via `configFile`: loading an
  // external .ts config makes Vite write a transformed temp file next to it, which `tsx watch` then picks
  // up as a source change and restarts on, looping forever.
  const { createServer: createViteServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const vite = await createViteServer({
    root: frontendRoot,
    configFile: false,
    plugins: [react()],
    resolve: { alias: { '@': path.join(frontendRoot, 'src') } },
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: 'custom',
  });
  app.use(vite.middlewares);
  app.use(NOT_API, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const template = await fs.readFile(path.join(frontendRoot, 'index.html'), 'utf-8');
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (err) {
      next(err);
    }
  });
}

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

// Express 5 forwards errors from async handlers here. Registered after the frontend middleware (when
// there is any), since Express only looks forward through the stack for an error handler when next(err)
// is called. Responses use the { message, fieldErrors? } shape the frontend expects.
function attachErrorHandler(): void {
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
}

// Tests import the app and start the database themselves, without serving the frontend or listening.
const shouldListen = process.env.TIMESHEET_NO_LISTEN !== '1';

async function main(): Promise<void> {
  if (!shouldListen) {
    attachErrorHandler();
    return;
  }

  // Created before listening so Vite's HMR websocket (dev only) can attach to this same server/port
  // instead of opening one of its own.
  const server = http.createServer(app);
  await setupFrontend(server);
  attachErrorHandler();

  server.listen(PORT, () => {
    console.log(`[api] Server listening on http://localhost:${PORT} (CORS origin: ${CORS_ORIGIN})`);
    console.log(`[api] Timesheet: http://localhost:${PORT}/   LMS: http://localhost:${PORT}${LMS_MOUNT}/`);
    void startDatabase();
    void startLms();
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
    stopLms();
    await disconnectMongo().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('exit', stopLms);
}

void main();
