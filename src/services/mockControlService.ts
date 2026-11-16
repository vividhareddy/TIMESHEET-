import { apiClient, unwrap } from './api';
import { IS_MOCK_MODE } from './config';

/**
 * Development-only controls for the mock database. These endpoints exist only in mock mode;
 * the real API has no equivalent and these calls are refused in api mode.
 */
function guard(): void {
  if (!IS_MOCK_MODE) throw new Error('Mock database controls are only available in mock mode.');
}

export const mockControlService = {
  /** Wipe the mock database back to an empty state. */
  async reset(): Promise<void> {
    guard();
    await unwrap(apiClient.post('/__mock/reset'));
  },
  /** Load the illustrative sample dataset into the mock database. */
  async loadSampleData(): Promise<void> {
    guard();
    await unwrap(apiClient.post('/__mock/sample-data'));
  },
};
