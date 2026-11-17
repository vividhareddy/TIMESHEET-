import { useEffect, useRef, useState } from 'react';
import { Archive, CheckCircle2, FilePlus2, FileText, FileUp, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import type { PolicyDocument, PolicyDocumentStatus } from '@/types';
import { ApiError, policyDocumentService } from '@/services';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { PageHeader, Alert, EmptyState, Segmented } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Badge, type BadgeTone } from '@/components/common/Badge';
import { Button, IconButton } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { QueryBoundary } from '@/components/common/StatusScreen';
import { Field, Input, Textarea } from '@/components/forms/FormControls';

const MAX_CHARS = 200_000;
const STATUS: Record<PolicyDocumentStatus, { label: string; tone: BadgeTone }> = {
  approved: { label: 'Approved', tone: 'green' },
  draft: { label: 'Draft', tone: 'amber' },
  archived: { label: 'Archived', tone: 'slate' },
};

const formatDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function DocumentEditor({ open, doc, onClose, onSaved }: { open: boolean; doc: PolicyDocument | null; onClose: () => void; onSaved: (d: PolicyDocument) => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(doc?.title ?? '');
    setContent(doc?.content ?? '');
    setErrors({});
    setFormError(null);
  }, [open, doc]);

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(txt|md|markdown)$/i.test(file.name) && !file.type.startsWith('text/')) {
      setFormError('Only plain-text files (.txt or .md) can be loaded. Copy and paste the text of PDF or Word documents instead.');
      return;
    }
    const text = await file.text();
    setContent(text);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
    setFormError(null);
  };

  const save = async () => {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = 'Title is required.';
    if (!content.trim()) e.content = 'Document text is required.';
    else if (content.length > MAX_CHARS) e.content = `Use at most ${MAX_CHARS.toLocaleString()} characters.`;
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setFormError(null);
    try {
      const body = { title: title.trim(), content };
      onSaved(doc ? await policyDocumentService.update(doc.id, body) : await policyDocumentService.create(body));
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setErrors(err.fieldErrors);
      setFormError(err instanceof Error ? err.message : 'Could not save the document.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={doc ? 'Edit policy document' : 'New policy document'}
      description="Write or paste the company's overtime policy. It is saved as a draft until you approve it."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy}>{doc ? 'Save changes' : 'Save draft'}</Button>
        </>
      }
    >
      {doc?.status === 'approved' && (
        <Alert tone="warning" className="mb-4">This document is approved. Saving changes returns it to draft, and the OT assistant stops using it until you approve it again.</Alert>
      )}
      {formError && <Alert tone="danger" className="mb-4">{formError}</Alert>}
      <div className="space-y-4">
        <Field label="Title" required error={errors.title}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} invalid={!!errors.title} placeholder="e.g. Overtime Policy 2026" maxLength={150} />
        </Field>
        <Field label="Policy text" required error={errors.content} hint={`${content.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()} characters`}>
          <Textarea rows={16} value={content} onChange={(e) => setContent(e.target.value)} invalid={!!errors.content} className="font-mono text-xs" placeholder="Paste the full policy text here…" />
        </Field>
        <div>
          <input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className="hidden" onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} />
          <Button variant="secondary" size="sm" icon={FileUp} onClick={() => fileRef.current?.click()}>Load from a text file</Button>
        </div>
      </div>
    </Modal>
  );
}

export function PolicyDocumentsPage() {
  const query = useApiQuery(() => policyDocumentService.list(), []);
  const { busy, run } = useAsyncAction();
  const [filter, setFilter] = useState<'all' | PolicyDocumentStatus>('all');
  const [editing, setEditing] = useState<PolicyDocument | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<PolicyDocument | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const openEditor = (doc: PolicyDocument | null) => {
    setEditing(doc);
    setEditorOpen(true);
  };
  const setStatus = (doc: PolicyDocument, status: PolicyDocumentStatus, title: string) =>
    run(async () => {
      await policyDocumentService.setStatus(doc.id, status);
      query.reload();
    }, { title });

  return (
    <div>
      <PageHeader
        title="OT Policy Documents"
        description="Approved documents are visible to every employee and are the only source the OT assistant answers from."
        actions={<Button icon={FilePlus2} onClick={() => openEditor(null)}>New document</Button>}
      />

      <QueryBoundary query={query} loadingLabel="Loading policy documents…">
        {(docs) => {
          const counts = { all: docs.length, approved: 0, draft: 0, archived: 0 } as Record<'all' | PolicyDocumentStatus, number>;
          docs.forEach((d) => counts[d.status]++);
          const shown = docs.filter((d) => filter === 'all' || d.status === filter);
          const selected = shown.find((d) => d.id === selectedId) ?? shown[0];
          return (
            <>
              {counts.approved === 0 && (
                <Alert tone="warning" className="mb-5" title="No approved documents">
                  The OT assistant cannot answer questions until at least one policy document is approved.
                </Alert>
              )}
              <div className="mb-4">
                <Segmented
                  value={filter}
                  onChange={setFilter}
                  options={(['all', 'approved', 'draft', 'archived'] as const).map((s) => ({ value: s, label: s === 'all' ? 'All' : STATUS[s].label, count: counts[s] }))}
                />
              </div>
              {shown.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={FileText}
                    title={docs.length === 0 ? 'No policy documents yet' : 'No documents in this view'}
                    description={docs.length === 0 ? 'Add your overtime policy so employees and the OT assistant can refer to it.' : undefined}
                    action={docs.length === 0 ? <Button icon={FilePlus2} onClick={() => openEditor(null)}>New document</Button> : undefined}
                  />
                </Card>
              ) : (
                <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
                  <Card className="h-fit">
                    <ul className="divide-y divide-slate-100">
                      {shown.map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(d.id)}
                            className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 ${selected?.id === d.id ? 'bg-brand-50/60' : ''}`}
                          >
                            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-slate-800">{d.title}</span>
                              <span className="block text-xs text-slate-500">Updated {formatDate(d.updatedAt)}</span>
                            </span>
                            <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Card>

                  {selected && (
                    <Card>
                      <CardHeader
                        title={selected.title}
                        description={
                          selected.status === 'approved'
                            ? `Approved by ${selected.approvedByName ?? 'an administrator'} on ${formatDate(selected.approvedAt)}`
                            : `${STATUS[selected.status].label} · last updated ${formatDate(selected.updatedAt)}${selected.updatedByName ? ` by ${selected.updatedByName}` : ''}`
                        }
                        actions={
                          <div className="flex flex-wrap items-center gap-1">
                            {selected.status !== 'approved' && (
                              <Button size="sm" variant="success" icon={CheckCircle2} loading={busy} onClick={() => setStatus(selected, 'approved', 'Document approved')}>Approve</Button>
                            )}
                            {selected.status === 'approved' && (
                              <Button size="sm" variant="warning" icon={Archive} loading={busy} onClick={() => setStatus(selected, 'archived', 'Document archived')}>Archive</Button>
                            )}
                            {selected.status === 'archived' && (
                              <Button size="sm" variant="secondary" icon={RotateCcw} loading={busy} onClick={() => setStatus(selected, 'draft', 'Document moved to drafts')}>Restore as draft</Button>
                            )}
                            <IconButton icon={Pencil} label="Edit" onClick={() => openEditor(selected)} />
                            <IconButton icon={Trash2} label="Delete" tone="danger" onClick={() => setDeleting(selected)} />
                          </div>
                        }
                      />
                      <CardBody>
                        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-700">{selected.content}</pre>
                      </CardBody>
                    </Card>
                  )}
                </div>
              )}
            </>
          );
        }}
      </QueryBoundary>

      <DocumentEditor
        open={editorOpen}
        doc={editing}
        onClose={() => setEditorOpen(false)}
        onSaved={(d) => {
          setSelectedId(d.id);
          setFilter('all');
          query.reload();
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        title="Delete policy document?"
        message={deleting ? `“${deleting.title}” will be permanently deleted. To stop using it but keep a record, archive it instead.` : ''}
        confirmLabel="Delete"
        tone="danger"
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const doc = deleting;
          if (!doc) return;
          const ok = await run(() => policyDocumentService.remove(doc.id), { title: 'Document deleted' });
          if (ok) {
            setDeleting(null);
            query.reload();
          }
        }}
      />
    </div>
  );
}
