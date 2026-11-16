/**
 * DEVELOPMENT ONLY — mock implementation of the REST API, installed as the Axios adapter
 * when VITE_API_MODE=mock. Services and UI are unchanged between mock and real mode.
 */
import { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { HttpError, type Method, type MockRequest } from './http';
import { mockDb } from './db';
import { routes } from './handlers';

const LATENCY_MS = 150;

function resolveUser(config: InternalAxiosRequestConfig) {
  const header = AxiosHeaders.from(config.headers).get('Authorization');
  const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
  const id = token.startsWith('mock-token.') ? token.slice('mock-token.'.length) : '';
  const user = mockDb.get().employees.find((e) => e.id === id && e.status === 'active');
  return user ? structuredClone(user) : null;
}

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  const method = (config.method ?? 'get').toUpperCase() as Method;
  const path = (config.url ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').split('?')[0];
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries((config.params ?? {}) as Record<string, unknown>)) if (v !== undefined && v !== null && v !== '') query[k] = String(v);

  let status = 200;
  let data: unknown;
  try {
    const match = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!match) throw new HttpError(404, `No route for ${method} ${path}`);
    const values = path.match(match.pattern)!.slice(1);
    const user = resolveUser(config);
    if (match.options.auth !== false && !user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
    if (match.options.roles && user && !match.options.roles.includes(user.systemRole)) throw new HttpError(403, 'You do not have permission to perform this action.');
    const req: MockRequest = {
      method,
      path,
      params: Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i])])),
      query,
      body: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : config.data ?? {},
      user,
    };
    data = await match.handler(req);
    if (method !== 'GET') mockDb.persist();
    if (data === undefined) status = 204;
    else if (method === 'POST') status = 201;
  } catch (err) {
    const e = err instanceof HttpError ? err : new HttpError(500, err instanceof Error ? err.message : 'Unexpected server error');
    status = e.status;
    data = { message: e.message, fieldErrors: e.fieldErrors };
  }

  const response = {
    data: data === undefined ? undefined : structuredClone(data),
    status,
    statusText: String(status),
    headers: new AxiosHeaders(),
    config,
    request: {},
  };
  if (status >= 400) {
    throw new AxiosError(String((data as { message?: string })?.message), status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST, config, {}, response);
  }
  return response;
};

export function installMockServer(client: AxiosInstance): AxiosAdapter {
  client.defaults.adapter = mockAdapter;
  // eslint-disable-next-line no-console
  console.info('%c[mock api] Requests are served by the development mock server (VITE_API_MODE=mock).', 'color:#b45309');
  return mockAdapter;
}
