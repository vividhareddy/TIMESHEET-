import type { OtAssistantStatus, OtChatMessage } from '@/types';
import { apiClient, unwrap } from './api';

export const otAssistantService = {
  /** GET /ot-assistant/status */
  status: () => unwrap(apiClient.get<OtAssistantStatus>('/ot-assistant/status')),
  /** POST /ot-assistant/chat — the whole conversation; the last message is the new question. */
  ask: (messages: OtChatMessage[]) =>
    // Answers can take longer than the default 15 s request timeout.
    unwrap(apiClient.post<{ reply: string }>('/ot-assistant/chat', { messages }, { timeout: 120_000 })),
};
