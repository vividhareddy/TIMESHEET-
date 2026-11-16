/** An error with an HTTP status, sent to the client as { message, fieldErrors? }. */
export class HttpError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string> | undefined;

  constructor(status: number, message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/** Throws a 400 with field errors when any were collected. */
export function assertValid(errors: Record<string, string>): void {
  if (Object.keys(errors).length > 0) throw new HttpError(400, 'Please correct the highlighted fields.', errors);
}

/** PostgreSQL / network error codes that mean "the database is unavailable", not "bad request". */
const DB_UNAVAILABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '28P01', '28000', '3D000', '57P01', '57P03']);

export function isDbUnavailable(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = (err as { message?: unknown })?.message;
  return (typeof code === 'string' && DB_UNAVAILABLE.has(code)) || (typeof message === 'string' && /timeout exceeded when trying to connect/i.test(message));
}

/** Unique-constraint name of a PostgreSQL unique violation (23505), if that is what err is. */
export function uniqueViolation(err: unknown): string | null {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' ? (e.constraint ?? '') : null;
}

// ----------------------------------------------------------- input helpers

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function isISODate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

/** bcrypt only uses the first 72 bytes of a password; longer ones are rejected rather than silently truncated. */
export const PASSWORD_MAX_BYTES = 72;

/** Returns an error message for an unacceptable password, or null. */
export function passwordProblem(password: string): string | null {
  if (!password) return 'Password is required.';
  if (password.length < 8) return 'Use at least 8 characters.';
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return `Use at most ${PASSWORD_MAX_BYTES} bytes.`;
  return null;
}

/** Throws 404 for a malformed id instead of letting PostgreSQL reject it. */
export function assertId(id: string | string[] | undefined, what: string): string {
  if (!isUuid(id)) throw new HttpError(404, `${what} not found.`);
  return id;
}
