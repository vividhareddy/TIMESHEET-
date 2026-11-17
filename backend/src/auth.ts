import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { HttpError } from './http.js';
import { EMPLOYEE_PUBLIC_FIELDS, EmployeeModel, employeeFromDoc, type Employee, type EmployeeLean, type Role } from './models/employee.js';
import { RevokedToken } from './models/requests.js';

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
    const claims = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], issuer: ISSUER }) as Partial<TokenClaims>;
    if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string' || typeof claims.exp !== 'number') throw new Error('Incomplete token.');
    return claims as TokenClaims;
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

  const [employee, revoked] = await Promise.all([
    EmployeeModel.findById(claims.sub).select(EMPLOYEE_PUBLIC_FIELDS).lean<EmployeeLean>(),
    RevokedToken.exists({ _id: claims.jti }),
  ]);
  if (!employee || revoked) throw new HttpError(401, 'Your session has ended. Please sign in again.');
  if (employee.status !== 'active') throw new HttpError(403, 'Your account is inactive. Contact your administrator.');

  res.locals.user = { ...employeeFromDoc(employee), organisationId: employee.organisationId } satisfies AuthUser;
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

/**
 * Revokes the request's token (logout). Invalid or expired tokens are simply ignored.
 * A TTL index removes each revoked token once it would have expired anyway.
 */
export async function revokeToken(req: Request): Promise<void> {
  const token = bearerToken(req);
  if (!token) return;
  let claims: TokenClaims;
  try {
    claims = verify(token);
  } catch {
    return;
  }
  await RevokedToken.updateOne({ _id: claims.jti }, { $setOnInsert: { expiresAt: new Date(claims.exp * 1000) } }, { upsert: true });
}
