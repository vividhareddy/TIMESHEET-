import mongoose, { type ClientSession } from 'mongoose';
import { config } from './config.js';

// Fail fast (→ 503) instead of queueing queries while disconnected.
mongoose.set('bufferCommands', false);
// Indexes and collections are created explicitly by ensureMongoSchema(), not lazily per model.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('strictQuery', true);

mongoose.connection.on('error', (err: Error) => {
  console.error(`[db] MongoDB connection error: ${describeMongoError(err)}`);
});
mongoose.connection.on('disconnected', () => console.warn('[db] MongoDB disconnected; the driver will keep trying to reconnect.'));
mongoose.connection.on('reconnected', () => console.log('[db] MongoDB reconnected.'));

/** Opens the shared connection pool. Credentials come only from MONGODB_URI. */
export async function connectMongo(): Promise<void> {
  await mongoose.connect(config.mongo.uri, {
    dbName: config.mongo.dbName,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8_000,
    retryWrites: true,
    w: 'majority',
  });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

export const isMongoConnected = (): boolean => mongoose.connection.readyState === 1;

/** The native database handle (throws when not connected). */
function nativeDb() {
  const db = mongoose.connection.db;
  if (!db || !isMongoConnected()) {
    throw Object.assign(new Error('Not connected to MongoDB.'), { name: 'MongoNotConnectedError' });
  }
  return db;
}

/**
 * Runs fn in a multi-document transaction (Atlas clusters are replica sets, so these are supported).
 * Transient conflicts between concurrent transactions are retried automatically; any error thrown
 * by fn aborts the transaction. Every query inside fn must be given the session.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
}

// ------------------------------------------------------------------ errors

const UNAVAILABLE_NAMES = new Set([
  'MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoNotConnectedError',
  'MongoTopologyClosedError', 'MongoPoolClearedError', 'MongooseServerSelectionError',
]);

/** True when err means "the database is unavailable", not "bad request". */
export function isDbUnavailable(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown; code?: unknown };
  if (typeof e?.name === 'string' && UNAVAILABLE_NAMES.has(e.name)) return true;
  // 18 = AuthenticationFailed, 8000 = Atlas error (e.g. bad auth)
  if (e?.code === 18 || e?.code === 8000) return true;
  return typeof e?.message === 'string' && /bufferCommands = false|buffering timed out|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(e.message);
}

/** Name of the unique index that a duplicate-key error (E11000) violated, or null if err is something else. */
export function uniqueViolation(err: unknown): string | null {
  const e = err as { code?: number; message?: string; keyPattern?: Record<string, unknown> };
  if (e?.code !== 11000) return null;
  return /index: (\S+)/.exec(e.message ?? '')?.[1] ?? Object.keys(e.keyPattern ?? {}).join('_');
}

/** Turns common MongoDB / network errors into an actionable message. Never includes the connection string. */
export function describeMongoError(err: unknown): string {
  const e = err as { name?: string; code?: number | string; message?: string };
  const message = (e?.message ?? '').replace(/mongodb(\+srv)?:\/\/\S+/gi, '<connection string>');
  if (e?.code === 18 || e?.code === 8000 || /bad auth|authentication failed/i.test(message)) {
    return 'MongoDB rejected the username or password. Check MONGODB_URI in backend/.env (special characters in the password must be URL-encoded, e.g. "@" → "%40").';
  }
  if (e?.name === 'MongoParseError') {
    return `MONGODB_URI is not a valid connection string (${message}). Special characters in the password must be URL-encoded.`;
  }
  if (/ENOTFOUND|querySrv/i.test(message)) return 'The MongoDB host could not be resolved. Check the cluster address in MONGODB_URI and your internet connection.';
  if (e?.name === 'MongoServerSelectionError' || e?.name === 'MongooseServerSelectionError') {
    return 'Could not reach the MongoDB cluster. Check that your IP address is allowed in Atlas → Network Access and that the cluster is running.';
  }
  if (e?.name === 'MongoNotConnectedError' || /bufferCommands = false/i.test(message)) return 'Not connected to MongoDB.';
  return message || 'Unknown database error.';
}

// ------------------------------------------------------------- health checks

export interface DbIdentity {
  database: string;
  user: string;
}

/** Pings the server and reads back the database name and authenticated user. */
export async function getDbIdentity(): Promise<DbIdentity> {
  const db = nativeDb();
  await db.command({ ping: 1 });
  const status = await db.command({ connectionStatus: 1 });
  const user = (status.authInfo?.authenticatedUsers?.[0]?.user as string | undefined) ?? '';
  return { database: db.databaseName, user };
}

/**
 * Proves the connected user can write: inserts a document into a scratch collection, reads it back,
 * updates it and deletes it again, so nothing is left behind.
 */
export async function checkDatabaseWrite(): Promise<void> {
  const col = nativeDb().collection<{ _id: string; value: string; at: Date }>('connection_checks');
  const _id = `check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await col.insertOne({ _id, value: 'ok', at: new Date() });
    const updated = await col.findOneAndUpdate({ _id }, { $set: { value: 'updated' } }, { returnDocument: 'after' });
    if (updated?.value !== 'updated') throw new Error('Write check could not read back the document it wrote.');
  } finally {
    await col.deleteOne({ _id }).catch(() => undefined);
  }
}

/** Connects at startup and logs the outcome. Returns true when connected. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    if (!isMongoConnected()) await connectMongo();
    const { database, user } = await getDbIdentity();
    console.log(`[db] Connected to MongoDB database "${database}"${user ? ` as "${user}"` : ''}.`);
    return true;
  } catch (err) {
    console.error(`[db] Could not connect to MongoDB: ${describeMongoError(err)}`);
    console.error('[db] The API will keep running; GET /api/db-test will report the error.');
    return false;
  }
}
