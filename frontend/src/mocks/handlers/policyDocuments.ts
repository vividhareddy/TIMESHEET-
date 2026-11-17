/** Overtime policy documents and the OT assistant (mock). The assistant itself needs the real API and Claude. */
import type { PolicyDocument, PolicyDocumentStatus } from '@/types';
import { badRequest, HttpError, newId, notFound, route } from '../http';
import { db } from './scope';

const docs = (): PolicyDocument[] => (db().policyDocuments ??= []);

function find(id: string): PolicyDocument {
  const d = docs().find((x) => x.id === id);
  if (!d) throw notFound('Policy document');
  return d;
}

function validate(body: { title?: string; content?: string }) {
  const title = (body.title ?? '').trim();
  const content = (body.content ?? '').trim();
  const errors: Record<string, string> = {};
  if (!title) errors.title = 'Title is required.';
  if (!content) errors.content = 'Document text is required.';
  if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields.', errors);
  return { title, content };
}

export const policyDocumentRoutes = [
  route('GET', '/policy-documents', (req) => (req.user!.systemRole === 'admin' ? docs() : docs().filter((d) => d.status === 'approved'))),
  route('POST', '/policy-documents', (req) => {
    const now = new Date().toISOString();
    const doc: PolicyDocument = { id: newId('doc'), ...validate(req.body), status: 'draft', createdByName: req.user!.name, updatedByName: req.user!.name, createdAt: now, updatedAt: now };
    docs().push(doc);
    return doc;
  }, { roles: ['admin'] }),
  route('PUT', '/policy-documents/:id', (req) => {
    const doc = find(req.params.id);
    const input = validate(req.body);
    if (input.title !== doc.title || input.content !== doc.content) {
      Object.assign(doc, input, { status: 'draft', approvedByName: undefined, approvedAt: undefined });
    }
    Object.assign(doc, { updatedByName: req.user!.name, updatedAt: new Date().toISOString() });
    return doc;
  }, { roles: ['admin'] }),
  route('POST', '/policy-documents/:id/status', (req) => {
    const doc = find(req.params.id);
    const status = (req.body as { status?: PolicyDocumentStatus }).status;
    if (status !== 'approved' && status !== 'archived' && status !== 'draft') throw badRequest('Status must be approved, archived or draft.');
    const approved = status === 'approved';
    Object.assign(doc, { status, approvedByName: approved ? req.user!.name : undefined, approvedAt: approved ? new Date().toISOString() : undefined, updatedAt: new Date().toISOString() });
    return doc;
  }, { roles: ['admin'] }),
  route('DELETE', '/policy-documents/:id', (req) => {
    find(req.params.id);
    db().policyDocuments = docs().filter((d) => d.id !== req.params.id);
    return null;
  }, { roles: ['admin'] }),

  route('GET', '/ot-assistant/status', () => ({ enabled: false, approvedDocuments: docs().filter((d) => d.status === 'approved').length })),
  route('POST', '/ot-assistant/chat', () => {
    throw new HttpError(503, 'The OT assistant needs the real API (it uses Claude). It is not available in mock mode.');
  }),
];
