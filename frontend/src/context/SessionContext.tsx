import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Employee } from '@/types';
import type { LoginRequest, SetupRequest } from '@/types/api';
import { ApiError, authService } from '@/services';
import { onUnauthorized } from '@/services/api';

/**
 * Authentication state. The signed-in user always comes from the API
 * (POST /auth/login, POST /auth/setup or GET /auth/me) — never from local data.
 * The user's role is assigned in the database; the client only uses it to pick a workspace,
 * while the API enforces every permission.
 */
type SessionStatus = 'checking' | 'anonymous' | 'authenticated' | 'error';

interface SessionApi {
  status: SessionStatus;
  user: Employee | null;
  error: string | null;
  /** Why the user was signed out (e.g. session expired), shown on the login page. */
  notice: string | null;
  login(body: LoginRequest): Promise<Employee>;
  mockLogin(userId: string): Promise<Employee>;
  setup(body: SetupRequest): Promise<Employee>;
  logout(): Promise<void>;
  /** Re-read the signed-in user (e.g. after an admin edits their own profile). */
  refreshUser(): Promise<void>;
  retry(): void;
}

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('checking');
  const [user, setUser] = useState<Employee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    if (!authService.hasToken()) {
      setStatus('anonymous');
      return;
    }
    setStatus('checking');
    authService
      .me()
      .then((u) => {
        if (!active) return;
        setUser(u);
        setStatus('authenticated');
      })
      .catch(async (err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          await authService.logout().catch(() => undefined);
          setNotice(err.message);
          setStatus('anonymous');
        } else {
          setError(err instanceof Error ? err.message : 'Unable to verify your session.');
          setStatus('error');
        }
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  // Any API call rejected with 401 mid-session (expired / revoked token) returns the user to the login page.
  useEffect(() => {
    onUnauthorized((message) => {
      setUser(null);
      setNotice(message);
      setStatus('anonymous');
    });
    return () => onUnauthorized(null);
  }, []);

  const signedIn = useCallback((u: Employee) => {
    setUser(u);
    setError(null);
    setNotice(null);
    setStatus('authenticated');
    return u;
  }, []);

  const login = useCallback(async (body: LoginRequest) => signedIn(await authService.login(body)), [signedIn]);
  const mockLogin = useCallback(async (id: string) => signedIn(await authService.mockLogin(id)), [signedIn]);
  const setup = useCallback(async (body: SetupRequest) => signedIn(await authService.setup(body)), [signedIn]);

  const logout = useCallback(async () => {
    await authService.logout().catch(() => undefined);
    setUser(null);
    setNotice(null);
    setStatus('anonymous');
  }, []);

  const refreshUser = useCallback(async () => {
    setUser(await authService.me());
  }, []);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const value = useMemo<SessionApi>(
    () => ({ status, user, error, notice, login, mockLogin, setup, logout, refreshUser, retry }),
    [status, user, error, notice, login, mockLogin, setup, logout, refreshUser, retry],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
