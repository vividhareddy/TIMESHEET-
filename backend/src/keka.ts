/**
 * "Sign in with Keka account" for the timesheet (and, through single sign-on, the LMS).
 *
 * Keka is the OpenID Connect identity provider (authorization code flow): the browser is sent to Keka's sign-in
 * page, Keka returns it to GET /api/auth/keka/callback with a code, and the API exchanges the code for the user's
 * identity. The application never sees Keka passwords. This mirrors the LMS's former Keka sign-in (lms/backend/src/keka.py).
 *
 * Settings (backend/.env; see .env.example):
 *   KEKA_COMPANY             your Keka subdomain: <company>.keka.com (required)
 *   KEKA_ENVIRONMENT         keka (default) or kekademo for Keka's sandbox
 *   KEKA_SSO_CLIENT_ID       SSO client ID from Keka Support (required)
 *   KEKA_SSO_CLIENT_SECRET   SSO client secret, when Keka issues one
 *   KEKA_SSO_SCOPE           default "openid"
 *   KEKA_SSO_REDIRECT_URI    optional; defaults to <API_PUBLIC_URL>/api/auth/keka/callback
 *   KEKA_API_CLIENT_ID, KEKA_API_CLIENT_SECRET, KEKA_API_KEY   optional Keka HRIS API credentials: when set, only
 *                            employees Keka marks "Working" can sign in
 *   KEKA_SSO_AUTHORITY, KEKA_API_BASE_URL   optional host overrides (sandbox, proxies)
 */
import { config } from './config.js';

export type KekaErrorCode =
  | 'keka-not-configured'
  | 'keka-cancelled'
  | 'keka-expired'
  | 'keka-other-company'
  | 'keka-not-employee'
  | 'keka-inactive'
  | 'keka-unreachable'
  | 'keka-failed';

/** A Keka sign-in that cannot continue. The code is shown on the login page as a fixed message. */
export class KekaSignInError extends Error {
  constructor(readonly code: KekaErrorCode) {
    super(code);
  }
}

const env = (name: string, fallback = '') => (process.env[name] ?? fallback).trim();

export function kekaSettings() {
  const company = env('KEKA_COMPANY').toLowerCase();
  const environment = env('KEKA_ENVIRONMENT', 'keka').toLowerCase();
  return {
    company,
    authority: env('KEKA_SSO_AUTHORITY').replace(/\/+$/, '') || `https://login.${environment}.com`,
    apiBase: env('KEKA_API_BASE_URL').replace(/\/+$/, '') || (company ? `https://${company}.${environment}.com/api/v1` : ''),
    ssoClientId: env('KEKA_SSO_CLIENT_ID'),
    ssoClientSecret: env('KEKA_SSO_CLIENT_SECRET'),
    ssoScope: env('KEKA_SSO_SCOPE', 'openid'),
    redirectUri: env('KEKA_SSO_REDIRECT_URI') || `${config.publicUrls.api}/api/auth/keka/callback`,
    apiClientId: env('KEKA_API_CLIENT_ID'),
    apiClientSecret: env('KEKA_API_CLIENT_SECRET'),
    apiKey: env('KEKA_API_KEY'),
    apiGrantType: env('KEKA_API_GRANT_TYPE', 'kekaapi'),
  };
}

type Settings = ReturnType<typeof kekaSettings>;

export const kekaSsoReady = (s: Settings = kekaSettings()) => !!(s.company && s.ssoClientId);
const kekaApiReady = (s: Settings) => !!(s.company && s.apiClientId && s.apiClientSecret && s.apiKey);

/** GET (or POST a form) to Keka and return the JSON body. Any failure becomes 'keka-unreachable'. */
async function call(url: string, form?: Record<string, string>, bearer?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  try {
    const response = await fetch(url, {
      method: form ? 'POST' : 'GET',
      headers,
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new KekaSignInError('keka-unreachable');
  }
}

let apiToken: { value: string; expires: number } | null = null;

async function kekaApiToken(s: Settings): Promise<string> {
  if (apiToken && apiToken.expires > Date.now() + 60_000) return apiToken.value;
  const result = await call(`${s.authority}/connect/token`, {
    grant_type: s.apiGrantType, scope: 'kekaapi', client_id: s.apiClientId, client_secret: s.apiClientSecret, api_key: s.apiKey,
  });
  const value = typeof result.access_token === 'string' ? result.access_token : '';
  if (!value) throw new KekaSignInError('keka-unreachable');
  apiToken = { value, expires: Date.now() + (Number(result.expires_in) || 3600) * 1000 };
  return value;
}

/** The Keka HRIS employee with exactly this work email, or null. */
async function findKekaEmployee(email: string, s: Settings): Promise<Record<string, unknown> | null> {
  const query = new URLSearchParams({ searchKey: email, pageNumber: '1', pageSize: '200' });
  const result = await call(`${s.apiBase}/hris/employees?${query}`, undefined, await kekaApiToken(s));
  const data = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
  return data.find((e) => String(e.email ?? '').trim().toLowerCase() === email) ?? null;
}

const isWorking = (employee: Record<string, unknown>) =>
  employee.employmentStatus === 0 || String(employee.employmentStatus ?? '').trim().toLowerCase() === 'working';

export function kekaAuthorizeUrl(state: string, nonce: string): string {
  const s = kekaSettings();
  return `${s.authority}/connect/authorize?${new URLSearchParams({
    response_type: 'code', client_id: s.ssoClientId, redirect_uri: s.redirectUri, scope: s.ssoScope, state, nonce,
  })}`;
}

/** Finishes a Keka sign-in: exchanges the code and returns the verified, lower-case work email. */
export async function kekaVerifiedEmail(code: string): Promise<string> {
  const s = kekaSettings();
  if (!kekaSsoReady(s)) throw new KekaSignInError('keka-not-configured');
  if (!code) throw new KekaSignInError('keka-failed');
  const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: s.redirectUri, client_id: s.ssoClientId };
  if (s.ssoClientSecret) form.client_secret = s.ssoClientSecret;
  const access = (await call(`${s.authority}/connect/token`, form)).access_token;
  if (typeof access !== 'string' || !access) throw new KekaSignInError('keka-failed');
  const info = await call(`${s.authority}/connect/userinfo`, undefined, access);
  // Only people from this company's Keka account may sign in.
  if (String(info.subdomain ?? '').trim().toLowerCase() !== s.company) throw new KekaSignInError('keka-other-company');
  const email = String(info.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new KekaSignInError('keka-failed');
  if (kekaApiReady(s)) {
    const employee = await findKekaEmployee(email, s);
    if (!employee) throw new KekaSignInError('keka-not-employee');
    if (!isWorking(employee)) throw new KekaSignInError('keka-inactive');
  }
  return email;
}
