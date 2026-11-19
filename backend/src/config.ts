
import dotenv from 'dotenv';

// Loaded here (not in server.ts) because ES module imports are evaluated before the importing file's body.
dotenv.config({ quiet: true });

const REQUIRED = ['MONGODB_URI', 'MONGODB_DB_NAME', 'JWT_SECRET'] as const;

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(
    `[config] Missing required environment variables: ${missing.join(', ')}. Check backend/.env (see backend/.env.example).`
  );
  process.exit(1);
}

if (!/^mongodb(?:\+srv)?:\/\//.test(process.env.MONGODB_URI!)) {
  console.error('[config] MONGODB_URI must start with "mongodb://" or "mongodb+srv://". Check backend/.env.');
  process.exit(1);
}

if (process.env.JWT_SECRET!.length < 32) {
  console.error('[config] JWT_SECRET must be at least 32 characters long. Check backend/.env.');
  process.exit(1);
}

/** Typed configuration read from environment variables (backend/.env). */
const port = Number(process.env.PORT) || 5032;
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5032';
const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

if (process.env.LMS_SSO_SECRET && process.env.LMS_SSO_SECRET.length < 32) {
  console.error('[config] LMS_SSO_SECRET must be at least 32 characters long. Check backend/.env.');
  process.exit(1);
}

export const config = {
  port,
  corsOrigin,
  publicUrls: {
    /** Where the timesheet frontend is served (Keka sign-in returns the browser here). */
    app: trimSlash(process.env.APP_PUBLIC_URL || corsOrigin),

    /** Where this API is reachable from the browser (the Keka callback address). */
    api: trimSlash(process.env.API_PUBLIC_URL || `http://localhost:${port}`),
  },
  lms: {
    /** The LMS portal ("My LMS" in the sidebar). This server proxies it under /lms on its own port. */
    url: trimSlash(process.env.LMS_URL || `${trimSlash(process.env.APP_PUBLIC_URL || corsOrigin)}/lms`),

    /** Loopback-only port the Python LMS listens on behind the /lms proxy. Browsers never use it directly. */
    internalPort: Number(process.env.LMS_INTERNAL_PORT) || 5007,

    /** Start the Python LMS together with this server (LMS_AUTOSTART=0 when it is run separately). */
    autostart: process.env.LMS_AUTOSTART !== '0',

    /** Python interpreter used to start the LMS. */
    python: process.env.LMS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),

    /** Shared with lms/backend/.env: signs the one-minute tickets that sign users in to the LMS. */
    ssoSecret: process.env.LMS_SSO_SECRET || '',
  },
  jwt: {
    secret: process.env.JWT_SECRET!,
    /** Lifetime of a normal sign-in token (jsonwebtoken / ms format, e.g. "8h"). */
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    /** Lifetime when the user ticks "Remember me". */
    rememberExpiresIn: process.env.JWT_REMEMBER_EXPIRES_IN || '7d',
  },
  mongo: {
    /** Full connection string including credentials. Never logged. */
    uri: process.env.MONGODB_URI!,
    dbName: process.env.MONGODB_DB_NAME!,
  },
  /**
   * Legacy PostgreSQL settings. Only the data-migration script and the not-yet-migrated modules
   * read these; they are optional and are removed once the migration is verified.
   */
  db: {
    host: process.env.PGHOST ?? '',
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE ?? '',
    user: process.env.PGUSER ?? '',
    password: process.env.PGPASSWORD ?? '',
  },
};
