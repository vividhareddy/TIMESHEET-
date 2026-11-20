import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, Clock3, Database, Eye, EyeOff, FlaskConical, Info, KeyRound, LogIn, RotateCcw, ShieldCheck } from 'lucide-react';
import type { Role } from '@/types';
import { useSession } from '@/context/SessionContext';
import { useToast } from '@/context/ToastContext';
import { useApiQuery } from '@/hooks/useApiQuery';
import { API_BASE_URL, ApiError, IS_MOCK_MODE, authService, mockControlService } from '@/services';
import { Button } from '@/components/common/Button';
import { Field, Input } from '@/components/forms/FormControls';
import { Alert, Avatar } from '@/components/common/Misc';
import { ErrorState, Spinner } from '@/components/common/StatusScreen';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

const ROLE_ORDER: Role[] = ['admin', 'manager', 'associate'];
const ROLE_HEADINGS: Record<Role, string> = { admin: 'Administrators', manager: 'Project managers', associate: 'Associates' };

export function LoginPage() {
  const setup = useApiQuery(() => authService.setupStatus(), []);
  const accounts = useApiQuery(() => authService.mockAccounts(), [setup.data?.needsSetup]);
  const reloadAll = () => {
    setup.reload();
    accounts.reload();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-100 px-4 py-10">
      <div className="mb-8 flex flex-col items-center gap-2 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-sidebar text-brand-200 shadow-card">
          <Clock3 className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xl font-bold tracking-tight text-slate-900">ShimentoX</p>
          <p className="text-sm font-medium text-brand-600">TimeTrack Pro</p>
        </div>
        {IS_MOCK_MODE && <MockBadge />}
      </div>

      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-pop">
        {setup.error ? (
          <ErrorState title="Cannot reach the server" message={setup.error} onRetry={setup.reload} compact />
        ) : !setup.data ? (
          <Spinner label="Connecting…" className="py-6" />
        ) : (
          <EntryTabs needsSetup={setup.data.needsSetup} onAlreadySetUp={setup.reload} />
        )}
      </div>

      <p className="mt-6 max-w-md text-center text-xs text-slate-500">
        Allocate people to client projects, record weekly hours and route each project's hours to its project manager for approval.
      </p>

      {IS_MOCK_MODE && (
        <div className="mt-8 w-full max-w-2xl">
          <MockPanel
            needsSetup={setup.data?.needsSetup}
            accounts={accounts.data ?? []}
            loading={accounts.loading}
            onChanged={reloadAll}
          />
        </div>
      )}
    </div>
  );
}

function MockBadge() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800" title="Requests are served by the in-browser development mock API">
      <FlaskConical className="h-3 w-3" /> Mock API
    </span>
  );
}

/**
 * Sign in is always available. "Create organisation" is offered only while the database has no
 * organisation (first run); after that the tab disappears and accounts are created by the administrator.
 */
function EntryTabs({ needsSetup, onAlreadySetUp }: { needsSetup: boolean; onAlreadySetUp: () => void }) {
  const [tab, setTab] = useState<'signin' | 'setup'>(needsSetup ? 'setup' : 'signin');
  const active = needsSetup ? tab : 'signin';

  const tabClass = (t: 'signin' | 'setup') =>
    `flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
    }`;

  return (
    <div className="space-y-5">
      {needsSetup && (
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1" role="tablist">
          <button type="button" role="tab" aria-selected={active === 'signin'} className={tabClass('signin')} onClick={() => setTab('signin')}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={active === 'setup'} className={tabClass('setup')} onClick={() => setTab('setup')}>
            Create organisation
          </button>
        </div>
      )}
      {active === 'setup' ? (
        <SetupForm onAlreadySetUp={onAlreadySetUp} />
      ) : (
        <>
          {needsSetup && (
            <Alert tone="info" icon={Info}>
              No organisation exists yet, so there are no accounts to sign in with.{' '}
              <button type="button" className="font-medium underline" onClick={() => setTab('setup')}>Create your organisation</button> first.
            </Alert>
          )}
          <LoginForm />
        </>
      )}
    </div>
  );
}

type LoginErrorTone = 'danger' | 'warning';

/** Maps API failures to a message the user can act on. */
function describeLoginError(err: unknown): { tone: LoginErrorTone; title: string; message: string } {
  if (err instanceof ApiError) {
    if (err.status === 401) return { tone: 'danger', title: 'Sign-in failed', message: 'The email or password is incorrect. Check both and try again.' };
    if (err.status === 403) return { tone: 'warning', title: 'Account inactive', message: err.message };
    if (err.status === 429) return { tone: 'warning', title: 'Too many attempts', message: err.message };
    if (err.status === 400) return { tone: 'danger', title: 'Check your details', message: err.message };
    if (err.status === undefined) return { tone: 'danger', title: 'Cannot reach the server', message: err.message };
    return { tone: 'danger', title: 'Sign-in failed', message: err.message };
  }
  return { tone: 'danger', title: 'Sign-in failed', message: err instanceof Error ? err.message : 'Please try again.' };
}

/** Messages for the ?signin_error= codes the API returns after an unsuccessful Keka sign-in. */
const KEKA_SIGNIN_ERRORS: Record<string, string> = {
  'keka-not-configured': 'Sign-in with Keka is not set up yet. Ask your administrator, or sign in with your email and password.',
  'keka-cancelled': 'Keka sign-in was cancelled. Try again when you are ready.',
  'keka-expired': 'Your Keka sign-in took too long or was interrupted. Please try again.',
  'keka-other-company': 'This Keka account belongs to a different company. Sign in with your ShimentoX Keka account.',
  'keka-not-employee': 'Your Keka account was found, but there is no matching employee account here. Contact your administrator.',
  'keka-inactive': 'Your account is not active. Contact HR or your administrator.',
  'keka-unreachable': 'Keka could not be reached right now. Please try again in a few minutes.',
  'keka-failed': 'Keka sign-in could not be completed. Please try again.',
};

/**
 * Reads (once per page load) the result of a Keka sign-in from the address bar and removes it, so a reload or
 * React's development double-render never reuses the one-time code.
 */
let kekaReturn: { code: string | null; error: string | null } | null = null;
function takeKekaReturn() {
  if (kekaReturn) return kekaReturn;
  const params = new URLSearchParams(window.location.search);
  kekaReturn = { code: params.get('keka_code'), error: params.get('signin_error') };
  if (kekaReturn.code || kekaReturn.error) {
    params.delete('keka_code');
    params.delete('signin_error');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  }
  return kekaReturn;
}
let kekaExchangeStarted = false;

function LoginForm() {
  const { login, kekaLogin, notice } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<ReturnType<typeof describeLoginError> | null>(null);
  const [busy, setBusy] = useState(false);
  const [kekaBusy, setKekaBusy] = useState(false);

  // Coming back from Keka: finish the sign-in, or explain why it failed.
  useEffect(() => {
    const { code, error: kekaError } = takeKekaReturn();
    if (kekaError) setError({ tone: 'danger', title: 'Keka sign-in failed', message: KEKA_SIGNIN_ERRORS[kekaError] ?? KEKA_SIGNIN_ERRORS['keka-failed']! });
    if (!code || kekaExchangeStarted) return;
    kekaExchangeStarted = true;
    setKekaBusy(true);
    kekaLogin(code)
      .catch((err: unknown) => setError({ ...describeLoginError(err), title: 'Keka sign-in failed' }))
      .finally(() => setKekaBusy(false));
  }, [kekaLogin]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = email.trim();
    const errors: { email?: string; password?: string } = {};
    if (!trimmed) errors.email = 'Work email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) errors.email = 'Enter a valid email address.';
    if (!password) errors.password = 'Password is required.';
    setFieldErrors(errors);
    setError(null);
    if (errors.email || errors.password) return;

    setBusy(true);
    try {
      // On success the session switches to "authenticated" and the router opens the role's dashboard.
      await login({ email: trimmed, password, rememberMe });
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setError(describeLoginError(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600"><LogIn className="h-5 w-5" /></span>
        <div>
          <h2 className="text-base font-semibold text-slate-900">Sign in</h2>
          <p className="text-sm text-slate-500">Use your work email and password. You will be taken to the workspace for your role.</p>
        </div>
      </div>

      {notice && !error && <Alert tone="info" icon={Info}>{notice}</Alert>}
      {error && (
        <Alert tone={error.tone} icon={AlertCircle} title={error.title}>
          {error.message}
        </Alert>
      )}

      <Field label="Work email" required error={fieldErrors.email}>
        <Input
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          invalid={!!fieldErrors.email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
          }}
          placeholder="name@company.com"
        />
      </Field>

      <Field label="Password" required error={fieldErrors.password}>
        <div className="relative">
          <Input
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            invalid={!!fieldErrors.password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
            }}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            title={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </Field>

      <div className="flex items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
          />
          Remember me
        </label>
        <button type="button" onClick={() => setShowForgot((s) => !s)} className="text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline">
          Forgot password?
        </button>
      </div>

      {showForgot && (
        <Alert tone="info" icon={KeyRound} title="Reset your password">
          Passwords are reset by your organisation's administrator. Ask them to set a new temporary password for you under <span className="font-medium">Employees → Edit</span>, then sign in with it.
        </Alert>
      )}

      <Button type="submit" icon={LogIn} loading={busy} disabled={kekaBusy} className="w-full">Sign in</Button>

      {!IS_MOCK_MODE && (
        <>
          <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400" role="separator">
            <span className="h-px flex-1 bg-slate-200" />or<span className="h-px flex-1 bg-slate-200" />
          </div>
          <a
            href={`${API_BASE_URL}/auth/keka/start`}
            onClick={() => setKekaBusy(true)}
            aria-disabled={kekaBusy}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30 aria-disabled:pointer-events-none aria-disabled:opacity-60"
          >
            {kekaBusy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" aria-hidden /> : <KeyRound className="h-4 w-4" />}
            Sign in with Keka account
          </a>
          <p className="text-center text-xs text-slate-500">Use the same email and password you use for Keka. The same sign-in also opens your LMS.</p>
        </>
      )}
      <p className="text-center text-xs text-slate-500">Accounts are created by your administrator. There is no self-registration.</p>
    </form>
  );
}

type SetupFields = { organisationName: string; name: string; email: string; password: string };

/** Client-side checks; mirror the backend rules in backend/src/routes/auth.ts (the backend re-validates). */
function validateSetup(f: SetupFields): Record<string, string> {
  const errors: Record<string, string> = {};
  const org = f.organisationName.trim();
  const name = f.name.trim();
  const email = f.email.trim();
  if (!org) errors.organisationName = 'Organisation name is required.';
  else if (org.length < 2 || org.length > 150) errors.organisationName = 'Use between 2 and 150 characters.';
  if (!name) errors.name = 'Full name is required.';
  else if (name.length < 2 || name.length > 100) errors.name = 'Use between 2 and 100 characters.';
  if (!email) errors.email = 'Work email is required.';
  else if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (!f.password) errors.password = 'Password is required.';
  else if (f.password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (new TextEncoder().encode(f.password).length > 72) errors.password = 'Use at most 72 characters.';
  return errors;
}

function SetupForm({ onAlreadySetUp }: { onAlreadySetUp: () => void }) {
  const { setup } = useSession();
  const toast = useToast();
  const [form, setForm] = useState<SetupFields>({ organisationName: '', name: '', email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof SetupFields, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    // Clear a field's message as soon as the user edits it.
    setFieldErrors((errs) => {
      if (!errs[k]) return errs;
      const { [k]: _removed, ...rest } = errs;
      return rest;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const errors = validateSetup(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError('Please correct the highlighted fields.');
      return;
    }
    setBusy(true);
    try {
      const user = await setup({
        organisationName: form.organisationName.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      toast.success('Organisation created', `Welcome, ${user.name}. You are signed in as the administrator.`);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setError(err instanceof Error ? err.message : 'Setup failed.');
      // Someone else completed setup meanwhile: switch to the sign-in form.
      if (err instanceof ApiError && err.status === 409 && !err.fieldErrors) {
        toast.error('Setup already completed', 'Please sign in with the administrator account.');
        onAlreadySetUp();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600"><ShieldCheck className="h-5 w-5" /></span>
        <div>
          <h2 className="text-base font-semibold text-slate-900">Set up your organisation</h2>
          <p className="text-sm text-slate-500">The database is empty. Create the first administrator account to get started — you will then add calendars, employees and projects.</p>
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Organisation name" required error={fieldErrors.organisationName}>
        <Input value={form.organisationName} onChange={(e) => set('organisationName', e.target.value)} required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your full name" required error={fieldErrors.name}>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} required />
        </Field>
        <Field label="Work email" required error={fieldErrors.email}>
          <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required />
        </Field>
      </div>
      <Field label="Password" required error={fieldErrors.password} hint="At least 8 characters.">
        <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} required minLength={8} />
      </Field>
      <Button type="submit" loading={busy} className="w-full">Create administrator account</Button>
    </form>
  );
}

/** Development helpers — rendered only when VITE_API_MODE=mock. */
function MockPanel({ needsSetup, accounts, loading, onChanged }: { needsSetup: boolean | undefined; accounts: Array<{ id: string; name: string; designation: string; systemRole: Role }>; loading: boolean; onChanged: () => void }) {
  const { mockLogin } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      if (success) toast.success(success);
      onChanged();
    } catch (err) {
      toast.error('Action failed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="h-fit rounded-lg border border-amber-200 bg-amber-50/60 p-5">
      <div className="flex items-center gap-2 text-amber-900">
        <Database className="h-4 w-4" />
        <h2 className="text-sm font-semibold">Development mock API</h2>
      </div>
      <p className="mt-1 text-xs text-amber-900/80">
        Data lives only in this browser and is not real. Set <code className="rounded bg-white/70 px-1">VITE_API_MODE=api</code> to use the Express backend.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={Database} loading={busy === 'sample'} onClick={() => run('sample', mockControlService.loadSampleData, 'Sample dataset loaded')}>
          Load sample dataset
        </Button>
        {needsSetup === false && (
          <Button size="sm" variant="danger" icon={RotateCcw} onClick={() => setConfirmReset(true)}>
            Reset to empty
          </Button>
        )}
      </div>

      {needsSetup === false && (
        <div className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-900/70">Quick sign-in (mock accounts)</p>
          {loading && <Spinner label="Loading accounts…" className="mt-3" />}
          {!loading && accounts.length === 0 && <p className="mt-2 text-sm text-amber-900/80">No accounts yet.</p>}
          {ROLE_ORDER.map((role) => {
            const list = accounts.filter((a) => a.systemRole === role);
            if (!list.length) return null;
            return (
              <div key={role} className="mt-3">
                <p className="mb-1 text-xs text-slate-500">{ROLE_HEADINGS[role]}</p>
                <ul className="space-y-1">
                  {list.map((a) => (
                    <li key={a.id}>
                      <button
                        onClick={() => run(a.id, () => mockLogin(a.id))}
                        disabled={!!busy}
                        className="flex w-full items-center gap-2 rounded-md border border-transparent bg-white/70 px-2 py-1.5 text-left text-sm hover:border-amber-300 hover:bg-white disabled:opacity-60"
                      >
                        <Avatar name={a.name} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-slate-800">{a.name}</span>
                          <span className="block truncate text-xs text-slate-500">{a.designation}</span>
                        </span>
                        {busy === a.id && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="Reset mock database?"
        tone="danger"
        confirmLabel="Reset"
        busy={busy === 'reset'}
        message="All mock records in this browser will be deleted and the app will start from first-run setup."
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => run('reset', mockControlService.reset, 'Mock database cleared').then(() => setConfirmReset(false))}
      />
    </aside>
  );
}

export { MockBadge };
