import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, FileText, Info, RotateCcw, Send, UserRound } from 'lucide-react';
import type { OtChatMessage, PolicyDocument } from '@/types';
import { otAssistantService, policyDocumentService } from '@/services';
import { useApiQuery } from '@/hooks/useApiQuery';
import { PageHeader, Alert } from '@/components/common/Misc';
import { Card, CardBody, CardHeader } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { Spinner } from '@/components/common/StatusScreen';
import { Textarea } from '@/components/forms/FormControls';

const MAX_QUESTION = 2000;
const SUGGESTIONS = [
  'Am I eligible for overtime?',
  'Does working on a public holiday count as overtime?',
  'Who approves my overtime, and how do I request it?',
  'What is the maximum overtime I can work in a week?',
];

/** Chat with the OT policy assistant, plus the approved documents it answers from. */
export function OtAssistantPage() {
  const status = useApiQuery(() => otAssistantService.status(), []);
  const docs = useApiQuery(() => policyDocumentService.list(), []);
  const approved = (docs.data ?? []).filter((d) => d.status === 'approved');
  const [messages, setMessages] = useState<OtChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<PolicyDocument | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, pending]);

  const ready = status.data?.enabled === true && (status.data?.approvedDocuments ?? 0) > 0;

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || pending || !ready) return;
    const next: OtChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setDraft('');
    setError(null);
    setPending(true);
    try {
      const { reply } = await otAssistantService.ask(next);
      setMessages([...next, { role: 'assistant', content: reply }]);
    } catch (err) {
      // Drop the unanswered question so the conversation keeps alternating, and offer it back for editing.
      setMessages(messages);
      setDraft(text);
      setError(err instanceof Error ? err.message : 'The assistant could not answer.');
    } finally {
      setPending(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(draft);
  };

  return (
    <div>
      <PageHeader
        title="OT Assistant"
        description="Ask questions about the overtime policy. Answers come only from your organisation's approved policy documents and settings."
        actions={messages.length > 0 ? <Button variant="ghost" icon={RotateCcw} onClick={() => { setMessages([]); setError(null); }} disabled={pending}>New conversation</Button> : undefined}
      />

      <Alert tone="info" icon={Info} className="mb-5">
        The assistant explains the rules. It cannot approve, reject or change overtime: requests are decided by the configured approver.
      </Alert>

      {status.error && <Alert tone="danger" className="mb-5">{status.error}</Alert>}
      {status.data && !status.data.enabled && (
        <Alert tone="warning" className="mb-5" title="The OT assistant is not set up">
          The server has no Anthropic API key configured. An administrator needs to add <code>ANTHROPIC_API_KEY</code> to the backend configuration.
        </Alert>
      )}
      {status.data?.enabled && status.data.approvedDocuments === 0 && (
        <Alert tone="warning" className="mb-5" title="No approved policy documents">
          The assistant answers only from approved overtime policy documents, and none have been approved yet.
        </Alert>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <Card className="flex min-h-[520px] flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-5" aria-live="polite">
            {messages.length === 0 && (
              <div className="py-6 text-center">
                <Bot className="mx-auto h-10 w-10 text-brand-600" />
                <p className="mt-3 text-sm font-medium text-slate-800">How can I help with overtime?</p>
                <p className="mt-1 text-sm text-slate-500">Try one of these questions:</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={!ready}
                      onClick={() => void ask(s)}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand-300 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${m.role === 'user' ? 'bg-slate-200 text-slate-600' : 'bg-brand-600 text-white'}`}>
                  {m.role === 'user' ? <UserRound className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                </div>
                <div
                  className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === 'user' ? 'rounded-tr-sm bg-brand-600 text-white' : 'rounded-tl-sm bg-slate-100 text-slate-800'
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {pending && (
              <div className="flex gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white"><Bot className="h-4 w-4" /></div>
                <div className="rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-2.5"><Spinner label="Checking the policy…" /></div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={onSubmit} className="border-t border-slate-200 p-4">
            {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
            <div className="flex items-end gap-2">
              <Textarea
                rows={2}
                value={draft}
                maxLength={MAX_QUESTION}
                disabled={!ready || pending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void ask(draft);
                  }
                }}
                placeholder={ready ? 'Ask about overtime rules… (Enter to send, Shift+Enter for a new line)' : 'The assistant is not available yet.'}
                className="flex-1 resize-none"
                aria-label="Your question"
              />
              <Button type="submit" icon={Send} loading={pending} disabled={!ready || !draft.trim()}>Ask</Button>
            </div>
          </form>
        </Card>

        <Card className="h-fit">
          <CardHeader title="Approved policy documents" description="What the assistant answers from." />
          <CardBody className="py-2">
            {docs.loading && !docs.data ? (
              <Spinner label="Loading…" />
            ) : docs.error ? (
              <p className="text-sm text-red-600">{docs.error}</p>
            ) : approved.length === 0 ? (
              <p className="py-2 text-sm text-slate-500">No approved documents yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {approved.map((d) => (
                  <li key={d.id}>
                    <button type="button" onClick={() => setReading(d)} className="flex w-full items-center gap-2 py-2.5 text-left text-sm text-brand-700 hover:underline">
                      <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="truncate">{d.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Modal
        open={!!reading}
        onClose={() => setReading(null)}
        size="xl"
        title={reading?.title ?? ''}
        description={reading?.approvedAt ? `Approved ${new Date(reading.approvedAt).toLocaleDateString()}` : undefined}
        footer={<Button variant="secondary" onClick={() => setReading(null)}>Close</Button>}
      >
        <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-700">{reading?.content}</pre>
      </Modal>
    </div>
  );
}
