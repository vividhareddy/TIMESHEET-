/**
 * Company overtime policy documents. Administrators write and approve them; everyone else (and the OT assistant)
 * only ever sees approved documents. Editing an approved document sends it back to draft for re-approval.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { HttpError, assertId, assertValid, str } from '../http.js';

export const MAX_DOCUMENT_CHARS = 200_000;

export interface PolicyDocument {
  id: string;
  title: string;
  content: string;
  status: 'draft' | 'approved' | 'archived';
  createdByName?: string;
  updatedByName?: string;
  approvedByName?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface PolicyDocumentRow {
  id: string;
  title: string;
  content: string;
  status: PolicyDocument['status'];
  created_by_name: string | null;
  updated_by_name: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `SELECT d.id, d.title, d.content, d.status, d.approved_at, d.created_at, d.updated_at,
         c.name AS created_by_name, u.name AS updated_by_name, a.name AS approved_by_name
    FROM policy_documents d
    LEFT JOIN employees c ON c.id = d.created_by
    LEFT JOIN employees u ON u.id = d.updated_by
    LEFT JOIN employees a ON a.id = d.approved_by`;

const toDocument = (r: PolicyDocumentRow): PolicyDocument => ({
  id: r.id,
  title: r.title,
  content: r.content,
  status: r.status,
  ...(r.created_by_name ? { createdByName: r.created_by_name } : {}),
  ...(r.updated_by_name ? { updatedByName: r.updated_by_name } : {}),
  ...(r.approved_by_name ? { approvedByName: r.approved_by_name } : {}),
  ...(r.approved_at ? { approvedAt: r.approved_at.toISOString() } : {}),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** Approved documents of an organisation, oldest first (used by the OT assistant). */
export async function approvedDocuments(org: string): Promise<PolicyDocument[]> {
  const { rows } = await pool.query<PolicyDocumentRow>(`${SELECT} WHERE d.organisation_id = $1 AND d.status = 'approved' ORDER BY d.approved_at, d.created_at`, [org]);
  return rows.map(toDocument);
}

async function loadDocument(org: string, id: string): Promise<PolicyDocument> {
  const { rows } = await pool.query<PolicyDocumentRow>(`${SELECT} WHERE d.organisation_id = $1 AND d.id = $2`, [org, id]);
  if (!rows[0]) throw new HttpError(404, 'Policy document not found.');
  return toDocument(rows[0]);
}

function validate(body: unknown): { title: string; content: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const title = str(b.title);
  const content = typeof b.content === 'string' ? b.content.replace(/\r\n/g, '\n').trim() : '';
  const errors: Record<string, string> = {};
  if (!title) errors.title = 'Title is required.';
  else if (title.length > 150) errors.title = 'Use at most 150 characters.';
  if (!content) errors.content = 'Document text is required.';
  else if (content.length > MAX_DOCUMENT_CHARS) errors.content = `Use at most ${MAX_DOCUMENT_CHARS.toLocaleString('en-US')} characters.`;
  assertValid(errors);
  return { title, content };
}

export const policyDocumentsRouter = Router();
policyDocumentsRouter.use(requireAuth);

/** GET /api/policy-documents — administrators see every document; everyone else only approved ones. */
policyDocumentsRouter.get('/', async (_req, res) => {
  const user = currentUser(res);
  const onlyApproved = user.systemRole !== 'admin';
  const { rows } = await pool.query<PolicyDocumentRow>(
    `${SELECT} WHERE d.organisation_id = $1 ${onlyApproved ? "AND d.status = 'approved'" : ''} ORDER BY lower(d.title)`,
    [user.organisationId],
  );
  res.json(rows.map(toDocument));
});

/** POST /api/policy-documents — { title, content }; created as a draft. */
policyDocumentsRouter.post('/', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const input = validate(req.body);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO policy_documents (organisation_id, title, content, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
    [user.organisationId, input.title, input.content, user.id],
  );
  res.status(201).json(await loadDocument(user.organisationId, rows[0]!.id));
});

/** PUT /api/policy-documents/:id — { title, content }; an edited approved or archived document becomes a draft again. */
policyDocumentsRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Policy document');
  const input = validate(req.body);
  const { rowCount } = await pool.query(
    `UPDATE policy_documents
        SET title = $3::text, content = $4::text, updated_by = $5, updated_at = now(),
            status = CASE WHEN title = $3::text AND content = $4::text THEN status ELSE 'draft' END,
            approved_by = CASE WHEN title = $3::text AND content = $4::text THEN approved_by END,
            approved_at = CASE WHEN title = $3::text AND content = $4::text THEN approved_at END
      WHERE organisation_id = $1 AND id = $2`,
    [user.organisationId, id, input.title, input.content, user.id],
  );
  if (!rowCount) throw new HttpError(404, 'Policy document not found.');
  res.json(await loadDocument(user.organisationId, id));
});

/** POST /api/policy-documents/:id/status — { status: 'approved' | 'archived' | 'draft' }. */
policyDocumentsRouter.post('/:id/status', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Policy document');
  const status = str(req.body?.status);
  if (!['approved', 'archived', 'draft'].includes(status)) throw new HttpError(400, 'Status must be approved, archived or draft.');
  const { rowCount } = await pool.query(
    `UPDATE policy_documents
        SET status = $3::text,
            approved_by = CASE WHEN $3::text = 'approved' THEN $4::uuid END,
            approved_at = CASE WHEN $3::text = 'approved' THEN now() END,
            updated_at = now()
      WHERE organisation_id = $1 AND id = $2`,
    [user.organisationId, id, status, user.id],
  );
  if (!rowCount) throw new HttpError(404, 'Policy document not found.');
  res.json(await loadDocument(user.organisationId, id));
});

/** DELETE /api/policy-documents/:id */
policyDocumentsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const user = currentUser(res);
  const id = assertId(req.params.id, 'Policy document');
  const { rowCount } = await pool.query('DELETE FROM policy_documents WHERE organisation_id = $1 AND id = $2', [user.organisationId, id]);
  if (!rowCount) throw new HttpError(404, 'Policy document not found.');
  res.status(204).end();
});
