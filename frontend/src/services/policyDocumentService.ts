import type { PolicyDocument, PolicyDocumentStatus } from '@/types';
import { apiClient, unwrap } from './api';

export interface PolicyDocumentInput {
  title: string;
  content: string;
}

export const policyDocumentService = {
  /** GET /policy-documents — admins get every document; others only approved ones. */
  list: () => unwrap(apiClient.get<PolicyDocument[]>('/policy-documents')),
  /** POST /policy-documents — created as a draft. */
  create: (body: PolicyDocumentInput) => unwrap(apiClient.post<PolicyDocument>('/policy-documents', body)),
  /** PUT /policy-documents/:id — editing an approved document returns it to draft. */
  update: (id: string, body: PolicyDocumentInput) => unwrap(apiClient.put<PolicyDocument>(`/policy-documents/${id}`, body)),
  /** POST /policy-documents/:id/status */
  setStatus: (id: string, status: PolicyDocumentStatus) => unwrap(apiClient.post<PolicyDocument>(`/policy-documents/${id}/status`, { status })),
  /** DELETE /policy-documents/:id */
  remove: (id: string) => unwrap(apiClient.delete<void>(`/policy-documents/${id}`)),
};
