import dotenv from 'dotenv';

// Loaded here (not in server.ts) because ES module imports are evaluated before the importing file's body.
dotenv.config({ quiet: true });

const REQUIRED = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'JWT_SECRET'] as const;

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[config] Missing required environment variables: ${missing.join(', ')}. Check backend/.env (see backend/.env.example).`);
  process.exit(1);
}
if (process.env.JWT_SECRET!.length < 32) {
  console.error('[config] JWT_SECRET must be at least 32 characters long. Check backend/.env.');
  process.exit(1);
}

/** Typed configuration read from environment variables (backend/.env). */
export const config = {
  port: Number(process.env.PORT) || 5000,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  jwt: {
    secret: process.env.JWT_SECRET!,
    /** Lifetime of a normal sign-in token (jsonwebtoken / ms format, e.g. "8h"). */
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    /** Lifetime when the user ticks "Remember me". */
    rememberExpiresIn: process.env.JWT_REMEMBER_EXPIRES_IN || '7d',
  },
  db: {
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT),
    database: process.env.PGDATABASE!,
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
  },
};
