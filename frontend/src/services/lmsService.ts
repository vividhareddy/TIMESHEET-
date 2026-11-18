import { apiClient, unwrap } from './api';

export const lmsService = {
  /** POST /lms/launch — the LMS address with a one-minute single sign-on ticket for the signed-in user. */
  launch: () => unwrap(apiClient.post<{ url: string }>('/lms/launch')),
};
