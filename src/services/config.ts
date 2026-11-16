/**
 * Data-layer configuration (see .env.development / .env.production / .env.example).
 *
 *   VITE_API_MODE=api   → every service calls the Node.js + Express API at VITE_API_BASE_URL
 *   VITE_API_MODE=mock  → requests are answered by the in-browser mock server in src/mocks
 *                         (development only — never treated as real records)
 */
export type ApiMode = 'api' | 'mock';

export const API_MODE: ApiMode = import.meta.env.VITE_API_MODE === 'mock' ? 'mock' : 'api';

export const IS_MOCK_MODE = API_MODE === 'mock';

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL || '/api';
