import type { CourseCatalog } from '@/types/api';
import { apiClient, unwrap } from './api';

export const lmsService = {
  /** POST /lms/launch — the LMS address with a one-minute single sign-on ticket for the signed-in user. */
  launch: () => unwrap(apiClient.post<{ url: string }>('/lms/launch')),
  /** GET /lms/courses — published LMS courses open to every employee (no personal data). */
  courses: () => unwrap(apiClient.get<CourseCatalog>('/lms/courses')),
};
