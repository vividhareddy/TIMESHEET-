import axios, { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import type { ApiErrorBody } from '@/types/api';
import { API_BASE_URL } from './config';

const TOKEN_KEY = 'tsrm-token';

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Bearer-token (JWT) storage. The token comes from POST /auth/login or /auth/setup.
 * "Remember me" keeps it in localStorage (survives closing the browser); otherwise it lives in
 * sessionStorage and is gone when the tab closes. The server also enforces the token's expiry.
 */
export const tokenStore = {
  get(): string | null {
    return storage('session')?.getItem(TOKEN_KEY) ?? storage('local')?.getItem(TOKEN_KEY) ?? null;
  },
  set(token: string, remember = false): void {
    tokenStore.clear();
    try {
      storage(remember ? 'local' : 'session')?.setItem(TOKEN_KEY, token);
    } catch {
      /* storage full or blocked — the session will simply not survive a reload */
    }
  },
  clear(): void {
    try {
      storage('local')?.removeItem(TOKEN_KEY);
      storage('session')?.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

/** Called when an authenticated request is rejected with 401 (expired, revoked or invalid token). */
let unauthorizedHandler: ((message: string) => void) | null = null;
export function onUnauthorized(handler: ((message: string) => void) | null): void {
  unauthorizedHandler = handler;
}
const AUTH_ENTRY_PATHS = ['/auth/login', '/auth/setup', '/auth/logout'];

/** Normalised error thrown by every service call. */
export class ApiError extends Error {
  status?: number;
  fieldErrors?: Record<string, string>;
  constructor(message: string, status?: number, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Reusable API service: the single Axios instance every *Service module uses to call the
 * Node.js + Express + PostgreSQL backend. Base URL comes from VITE_API_BASE_URL (.env.development);
 * it attaches the bearer token and normalises every failure into an ApiError.
 */
export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Mock mode: install the development mock server as the Axios adapter.
 * The static env comparison lets the production build drop src/mocks entirely.
 */
const mockAdapter: Promise<AxiosAdapter | null> =
  import.meta.env.VITE_API_MODE === 'mock'
    ? import('@/mocks/server').then((m) => m.installMockServer(apiClient))
    : Promise.resolve(null);

apiClient.interceptors.request.use(async (config) => {
  // Axios merges the adapter into the request config before interceptors run,
  // so requests issued before the mock server finished loading must be pointed at it explicitly.
  const adapter = await mockAdapter;
  if (adapter) config.adapter = adapter;
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use(
  (res) => {
    // Guard against proxies / static hosts answering API routes with HTML (e.g. an SPA fallback page).
    const type = String(res.headers?.['content-type'] ?? '');
    const hasBody = res.status !== 204 && res.data !== undefined && res.data !== '';
    if (hasBody && !type.includes('application/json') && typeof res.data !== 'object') {
      return Promise.reject(new ApiError('The server returned an unexpected response. Check that the API is running and VITE_API_BASE_URL is correct.', res.status));
    }
    return res;
  },
  (error: AxiosError<ApiErrorBody>) => {
    if (!error.response) {
      return Promise.reject(new ApiError('Unable to reach the server. Check your connection or try again shortly.'));
    }
    const body = error.response.data;
    const message = body?.message ?? `Request failed (${error.response.status})`;
    const hadToken = !!error.config?.headers?.Authorization;
    if (error.response.status === 401 && hadToken && !AUTH_ENTRY_PATHS.some((p) => error.config?.url?.startsWith(p))) {
      tokenStore.clear();
      unauthorizedHandler?.(message);
    }
    return Promise.reject(new ApiError(message, error.response.status, body?.fieldErrors));
  },
);

/** Unwrap the response body. */
export const unwrap = <T>(p: Promise<AxiosResponse<T>>): Promise<T> => p.then((r) => r.data);
