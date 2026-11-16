/** Minimal HTTP primitives for the development mock server. */
import type { Employee, Role } from '@/types';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface MockRequest {
  method: Method;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  /** Authenticated user (null on public routes without a token). */
  user: Employee | null;
}

export class HttpError extends Error {
  status: number;
  fieldErrors?: Record<string, string>;
  constructor(status: number, message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export const badRequest = (message: string, fieldErrors?: Record<string, string>) => new HttpError(400, message, fieldErrors);
export const conflict = (message: string, fieldErrors?: Record<string, string>) => new HttpError(409, message, fieldErrors);
export const notFound = (what: string) => new HttpError(404, `${what} not found.`);
export const forbidden = (message = 'You do not have permission to perform this action.') => new HttpError(403, message);

interface RouteOptions {
  /** false = public route. Default: authenticated. */
  auth?: boolean;
  roles?: Role[];
}

export interface Route {
  method: Method;
  pattern: RegExp;
  keys: string[];
  handler: (req: MockRequest) => unknown;
  options: RouteOptions;
}

export function route(method: Method, path: string, handler: (req: MockRequest) => unknown, options: RouteOptions = {}): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?:([a-zA-Z]+)/g, (_m, key: string) => {
        keys.push(key);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, keys, handler, options };
}

/** Require one of the given roles. */
export function requireRole(user: Employee | null, ...roles: Role[]): Employee {
  if (!user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  if (roles.length && !roles.includes(user.systemRole)) throw forbidden();
  return user;
}

export function required(body: Record<string, unknown>, fields: Record<string, string>): void {
  const errors: Record<string, string> = {};
  for (const [field, label] of Object.entries(fields)) {
    const v = body?.[field];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) errors[field] = `${label} is required.`;
  }
  if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields.', errors);
}

export const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
