import type { Employee } from '@/types';
import type { AuthResponse, LoginRequest, MockAccount, SetupRequest, SetupStatusResponse } from '@/types/api';
import { apiClient, tokenStore, unwrap } from './api';
import { IS_MOCK_MODE } from './config';

export const authService = {
  /** GET /auth/setup-status — whether the first administrator still has to be created. */
  setupStatus: () => unwrap(apiClient.get<SetupStatusResponse>('/auth/setup-status')),

  /** POST /auth/setup — creates the first administrator on an empty database. */
  async setup(body: SetupRequest): Promise<Employee> {
    const res = await unwrap(apiClient.post<AuthResponse>('/auth/setup', body));
    tokenStore.set(res.token);
    return res.user;
  },

  /** POST /auth/login — "remember me" keeps the JWT after the browser closes. */
  async login(body: LoginRequest): Promise<Employee> {
    const res = await unwrap(apiClient.post<AuthResponse>('/auth/login', body));
    tokenStore.set(res.token, !!body.rememberMe);
    return res.user;
  },

  /** GET /auth/me — the signed-in user (requires a stored token). */
  me: () => unwrap(apiClient.get<Employee>('/auth/me')),

  async logout(): Promise<void> {
    try {
      await apiClient.post('/auth/logout');
    } finally {
      tokenStore.clear();
    }
  },

  hasToken: () => !!tokenStore.get(),

  // --------------------------------------------------- mock mode only

  /** GET /auth/mock-accounts — accounts in the mock database (mock mode only). */
  mockAccounts(): Promise<MockAccount[]> {
    if (!IS_MOCK_MODE) return Promise.resolve([]);
    return unwrap(apiClient.get<MockAccount[]>('/auth/mock-accounts'));
  },

  /** POST /auth/mock-login — sign in as a mock account without a password (mock mode only). */
  async mockLogin(userId: string): Promise<Employee> {
    if (!IS_MOCK_MODE) throw new Error('Mock sign-in is only available in mock mode.');
    const res = await unwrap(apiClient.post<AuthResponse>('/auth/mock-login', { userId }));
    tokenStore.set(res.token);
    return res.user;
  },
};
