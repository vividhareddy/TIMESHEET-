import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './http.js';
import { EMPLOYEE_COLUMNS, toEmployee, type Employee, type EmployeeRow, type Role } from './models/employee.js';

const ISSUER = 'timesheet-api';

interface TokenClaims {
  sub: string;
  jti: string;
  exp: number;
}

/** The signed-in employee, loaded fresh from the database on every request. */
export interface AuthUser extends Employee {
  organisationId: string;
}

/**
 * Signs a JWT for an employee. The token only identifies the user (sub) and itself (jti);
 * role and status are always read from the database, so changes take effect immediately.
 */
export function signToken(employeeId: string, rememberMe: boolean): { token: string; expiresAt: string } {
  const expiresIn = (rememberMe ? config.jwt.rememberExpiresIn : config.jwt.expiresIn) as jwt.SignOptions['expiresIn'];
  const token = jwt.sign({}, config.jwt.secret, {
    algorithm: 'HS256',
    issuer: ISSUER,
    subject: employeeId,
    jwtid: randomUUID(),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
  });
  const { exp } = jwt.decode(token) as TokenClaims;
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
}

function verify(token: string): TokenClaims {
  try {
    return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], issuer: ISSUER }) as TokenClaims;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new HttpError(401, 'Your session has expired. Please sign in again.');
    throw new HttpError(401, 'Your session is not valid. Please sign in again.');
  }
}

/** Requires a valid, unrevoked JWT for an active employee; sets res.locals.user. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'Please sign in to continue.');
  const claims = verify(token);

  const { rows } = await pool.query<EmployeeRow & { organisation_id: string; revoked: boolean }>(
    `SELECT ${EMPLOYEE_COLUMNS}, organisation_id,
            EXISTS (SELECT 1 FROM revoked_tokens WHERE jti = $2) AS revoked
       FROM employees WHERE id = $1`,
    [claims.sub, claims.jti],
  );
  const row = rows[0];
  if (!row || row.revoked) throw new HttpError(401, 'Your session has ended. Please sign in again.');
  if (row.status !== 'active') throw new HttpError(403, 'Your account is inactive. Contact your administrator.');

  res.locals.user = { ...toEmployee(row), organisationId: row.organisation_id } satisfies AuthUser;
  res.locals.token = claims;
  next();
}

/** Allows only the given roles (use after requireAuth). */
export function requireRole(...roles: Role[]) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const user = res.locals.user as AuthUser | undefined;
    if (!user) throw new HttpError(401, 'Please sign in to continue.');
    if (!roles.includes(user.systemRole)) throw new HttpError(403, 'You do not have permission to perform this action.');
    next();
  };
}

export const currentUser = (res: Response): AuthUser => res.locals.user as AuthUser;

/** Revokes the request's token (logout). Invalid or expired tokens are simply ignored. */
export async function revokeToken(req: Request): Promise<void> {
  const token = bearerToken(req);
  if (!token) return;
  let claims: TokenClaims;
  try {
    claims = verify(token);
  } catch {
    return;
  }
  await pool.query(
    `INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT (jti) DO NOTHING`,
    [claims.jti, claims.exp],
  );
  await pool.query('DELETE FROM revoked_tokens WHERE expires_at < now()');
}
