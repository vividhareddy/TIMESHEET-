import { useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, BarChart3, CheckCircle2, Clock3, Database, Eye, EyeOff, FlaskConical, Info, KeyRound, RotateCcw } from 'lucide-react';
import type { Role } from '@/types';
import { useSession } from '@/context/SessionContext';
import { useToast } from '@/context/ToastContext';
import { useApiQuery } from '@/hooks/useApiQuery';
import { API_BASE_URL, ApiError, IS_MOCK_MODE, authService, mockControlService } from '@/services';
import { Button } from '@/components/common/Button';
import { cn } from '@/utils/format';
import { Field, Input } from '@/components/forms/FormControls';
import { Alert, Avatar } from '@/components/common/Misc';
import { ErrorState, Spinner } from '@/components/common/StatusScreen';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

const ROLE_ORDER: Role[] = ['admin', 'manager', 'associate'];
const ROLE_HEADINGS: Record<Role, string> = { admin: 'Administrators', manager: 'Project managers', associate: 'Associates' };

/** Primary action on the sign-in page, in the app's brand blue. */
const PRIMARY_BUTTON_CLASS =
  'inline-flex h-[clamp(40px,6.4vh,52px)] w-full items-center justify-center gap-3 rounded-lg bg-brand-600 text-[15px] font-semibold text-white shadow-[0_8px_18px_-10px_rgba(39,76,131,0.8)] transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-200 disabled:cursor-wait disabled:opacity-70';
const SPINNER = <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />;

export function LoginPage() {
  const setup = useApiQuery(() => authService.setupStatus(), []);
  const accounts = useApiQuery(() => authService.mockAccounts(), [setup.data?.needsSetup]);
  const reloadAll = () => {
    setup.reload();
    accounts.reload();
  };

  return (
    <div className="grid min-h-screen bg-slate-50 lg:h-screen lg:grid-cols-[1.1fr_1fr] lg:overflow-hidden">
      <BrandPanel />

      <main className="no-scrollbar flex min-w-0 flex-col items-center bg-white px-6 py-10 sm:px-10 lg:overflow-y-auto lg:py-[clamp(12px,3vh,48px)]">
        <div className="my-auto w-full max-w-[450px]">
          <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-brand-600">Welcome to TimeTrack Pro{IS_MOCK_MODE && <MockBadge />}</p>
          <h1 className="mt-[clamp(6px,1.5vh,16px)] text-[34px] font-extrabold leading-tight tracking-tight text-slate-900 sm:text-[38px] lg:text-[clamp(26px,4.6vh,38px)]">
            Good to have you here.
          </h1>
          <p className="mt-[clamp(2px,0.8vh,8px)] text-[15px] text-slate-500">Sign in to keep your week on track.</p>

          <div className="mt-[clamp(14px,3vh,32px)]">
            {setup.error ? (
              <ErrorState title="Cannot reach the server" message={setup.error} onRetry={setup.reload} compact />
            ) : !setup.data ? (
              <Spinner label="Connecting…" className="py-6" />
            ) : (
              <EntryTabs needsSetup={setup.data.needsSetup} onAlreadySetUp={setup.reload} />
            )}
          </div>

          <p className="mt-[clamp(12px,3vh,40px)] text-center text-xs text-slate-500">Need an account? Contact your administrator.</p>

          {IS_MOCK_MODE && (
            <div className="mt-8">
              <MockPanel needsSetup={setup.data?.needsSetup} accounts={accounts.data ?? []} loading={accounts.loading} onChanged={reloadAll} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** Left half: the app's navy sidebar colour, the TimeTrack Pro mark and a few timesheet-themed illustration cards. */
function BrandPanel() {
  return (
    <section className="relative flex flex-col overflow-hidden bg-sidebar px-6 py-8 text-white sm:px-10 lg:min-h-0 lg:justify-between lg:px-16 lg:py-12">
      <span className="pointer-events-none absolute -bottom-48 -right-56 h-[620px] w-[620px] rounded-full border border-white/[0.06]" aria-hidden />
      <span className="pointer-events-none absolute -left-32 -top-40 h-[420px] w-[420px] rounded-full bg-brand-600/10 blur-3xl" aria-hidden />

      <div className="relative flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-600 text-white shadow-pop">
          <Clock3 className="h-6 w-6" />
        </span>
        <div className="leading-tight">
          <p className="text-lg font-semibold text-white">TimeTrack Pro</p>
          <p className="text-xs text-sidebar-muted">Project timesheets &amp; resource management</p>
        </div>
      </div>

      <div className="relative mt-8 lg:mt-0">
        <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-brand-200">Plan today. Deliver tomorrow.</p>
        <h2 className="mt-4 max-w-[520px] text-3xl font-bold leading-[1.12] tracking-tight sm:text-4xl lg:text-[clamp(34px,5vh,48px)]">Make every hour count.</h2>
        <p className="mt-4 max-w-[420px] text-[15px] leading-relaxed text-slate-300">
          Log your project hours, track every approval and see exactly where your week went.
        </p>
        <TimesheetIllustration />
      </div>

      <p className="relative hidden text-xs text-sidebar-muted lg:block">Allocate people. Record hours. Route approvals.</p>
    </section>
  );
}

const DEMO_ROWS = [
  { name: 'Kore.ai', color: '#3b6db3', hours: [4, 4, 4, 4, 4] },
  { name: 'Zelis', color: '#0f8a7a', hours: [2, 2, 2, 2, 4] },
  { name: 'Uber', color: '#7a5bb8', hours: [2, 2, 2, 2, 0] },
];
const DEMO_WEEKS = [
  { logged: 36, allocated: 40 },
  { logged: 40, allocated: 40 },
  { logged: 32, allocated: 40 },
  { logged: 38, allocated: 40 },
  { logged: 40, allocated: 40 },
  { logged: 40, allocated: 40 },
];

/** Illustration only: a weekly timesheet, an approval notice and a weekly-hours chart, in the app's own card style. */
function TimesheetIllustration() {
  const cardBase = 'login-float absolute overflow-hidden rounded-xl bg-white text-slate-700 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.55)] ring-1 ring-black/5';
  return (
    <div
      className="relative mx-auto mt-8 hidden h-[clamp(230px,38vh,330px)] w-full max-w-[520px] text-[clamp(9px,1.35vh,12px)] lg:block"
      role="img"
      aria-label="Illustration: a weekly timesheet with 40 hours across three projects, an approval notice and a weekly hours chart"
    >
      {/* Weekly timesheet */}
      <div className={cn(cardBase, 'left-0 top-[4%] z-[2] w-[63%]')} style={{ ['--tilt' as string]: '-3deg' }}>
        <div className="border-b border-slate-100 px-3.5 py-2.5">
          <p className="font-semibold text-slate-900">My Timesheet</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[0.85em] text-slate-500">
            Week of 16 – 22 Nov
            <span className="rounded-full bg-brand-50 px-1.5 py-px font-semibold text-brand-700 ring-1 ring-brand-100">Submitted</span>
          </p>
        </div>
        <table className="w-full tabular-nums">
          <thead>
            <tr className="text-[0.85em] text-slate-400">
              <th className="px-3.5 py-1.5 text-left font-medium">Project</th>
              {['M', 'T', 'W', 'T', 'F'].map((d, i) => (
                <th key={i} className="w-[9%] py-1.5 text-center font-medium">{d}</th>
              ))}
              <th className="px-3.5 py-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_ROWS.map((r) => (
              <tr key={r.name} className="border-t border-slate-100">
                <td className="px-3.5 py-1.5">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: r.color }} />
                  {r.name}
                </td>
                {r.hours.map((h, i) => (
                  <td key={i} className={cn('py-1.5 text-center', h ? 'text-slate-700' : 'text-slate-300')}>{h || '–'}</td>
                ))}
                <td className="px-3.5 py-1.5 text-right font-semibold text-slate-900">{r.hours.reduce((a, b) => a + b, 0)}h</td>
              </tr>
            ))}
            <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-900">
              <td className="px-3.5 py-1.5">Total</td>
              {[0, 1, 2, 3, 4].map((i) => (
                <td key={i} className="py-1.5 text-center">{DEMO_ROWS.reduce((a, r) => a + r.hours[i]!, 0)}</td>
              ))}
              <td className="px-3.5 py-1.5 text-right text-brand-700">40h</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Approval notice */}
      <div className={cn(cardBase, 'right-0 top-0 z-[3] flex w-[39%] items-start gap-2.5 px-3.5 py-3')} style={{ ['--tilt' as string]: '4deg', animationDelay: '-2s' }}>
        <CheckCircle2 className="mt-0.5 h-[1.6em] w-[1.6em] shrink-0 text-emerald-600" />
        <div>
          <p className="font-semibold text-slate-900">Hours approved</p>
          <p className="text-[0.9em] text-slate-500">Kore.ai · 20h this week</p>
        </div>
      </div>

      {/* Weekly hours chart */}
      <div className={cn(cardBase, 'bottom-[2%] right-0 z-[1] w-[39%] px-3.5 py-3')} style={{ ['--tilt' as string]: '-2deg', animationDelay: '-4s' }}>
        <div className="flex items-center gap-1.5 font-semibold text-slate-900">
          <BarChart3 className="h-[1.3em] w-[1.3em] text-brand-600" /> Weekly hours
        </div>
        <div className="mt-2 flex h-[clamp(40px,7vh,64px)] items-end justify-between gap-1.5">
          {DEMO_WEEKS.map((w, i) => (
            <div key={i} className="flex h-full flex-1 items-end gap-[2px]">
              <span className="w-1/2 rounded-t-sm bg-slate-200" style={{ height: `${(w.allocated / 40) * 100}%` }} />
              <span className="w-1/2 rounded-t-sm bg-brand-500" style={{ height: `${(w.logged / 40) * 100}%` }} />
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[0.85em] text-slate-500">Logged vs allocated</p>
      </div>
    </div>
  );
}

function MockBadge() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 align-middle text-[11px] font-semibold normal-case tracking-normal text-amber-800" title="Requests are served by the in-browser development mock API">
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
      active === t ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'
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

/** Larger label + field used by the sign-in form (the app's shared form controls are compact). */
function LoginField({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-[clamp(4px,0.9vh,8px)] block text-sm font-semibold text-slate-800">
        {label}
      </label>
      {children}
      {error && <p className="mt-1.5 text-xs text-rose-600">{error}</p>}
    </div>
  );
}

function LoginInput({ invalid, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        'block h-[clamp(40px,6.2vh,52px)] w-full rounded-lg border bg-white px-4 text-[15px] text-slate-900 placeholder:text-slate-400 transition-shadow focus:outline-none focus:ring-4',
        invalid ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-100' : 'border-slate-200 focus:border-brand-500 focus:ring-brand-100',
        className,
      )}
    />
  );
}

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
    <form onSubmit={submit} className="flex flex-col gap-[clamp(10px,2.1vh,20px)]" noValidate>
      {notice && !error && <Alert tone="info" icon={Info}>{notice}</Alert>}
      {error && (
        <Alert tone={error.tone} icon={AlertCircle} title={error.title}>
          {error.message}
        </Alert>
      )}

      <LoginField id="login-email" label="Work email" error={fieldErrors.email}>
        <LoginInput
          id="login-email"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          invalid={!!fieldErrors.email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
          }}
          placeholder="you@shimento.com"
        />
      </LoginField>

      <LoginField id="login-password" label="Password" error={fieldErrors.password}>
        <div className="relative">
          <LoginInput
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            invalid={!!fieldErrors.password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
            }}
            placeholder="Enter your password"
            className="pr-14"
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            title={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
        </div>
      </LoginField>

      <div className="flex items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
          />
          Keep me signed in
        </label>
        <button type="button" onClick={() => setShowForgot((s) => !s)} className="text-sm font-semibold text-brand-600 hover:text-brand-700 hover:underline">
          Forgot password?
        </button>
      </div>

      {showForgot && (
        <Alert tone="info" icon={KeyRound} title="Reset your password">
          Passwords are reset by your organisation's administrator. Ask them to set a new temporary password for you under <span className="font-medium">Employees → Edit</span>, then sign in with it.
        </Alert>
      )}

      <button type="submit" disabled={busy || kekaBusy} className={PRIMARY_BUTTON_CLASS}>
        {busy ? SPINNER : null}
        Sign In
        {!busy && <ArrowRight className="h-5 w-5" />}
      </button>

      {!IS_MOCK_MODE && (
        <>
          <div className="flex items-center gap-4 text-xs font-medium uppercase tracking-widest text-slate-400" role="separator">
            <span className="h-px flex-1 bg-slate-200" />or<span className="h-px flex-1 bg-slate-200" />
          </div>
          <a
            href={`${API_BASE_URL}/auth/keka/start`}
            onClick={() => setKekaBusy(true)}
            aria-disabled={kekaBusy}
            className="flex h-[clamp(40px,6.4vh,52px)] w-full items-center justify-center gap-3 rounded-lg border border-slate-200 bg-white text-base font-semibold text-slate-800 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100 aria-disabled:pointer-events-none aria-disabled:opacity-60"
          >
            {kekaBusy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" aria-hidden /> : <KeyRound className="h-5 w-5" />}
            Sign in with Keka account
          </a>
          <p className="rounded-lg border border-brand-100 bg-brand-50 px-4 py-[clamp(8px,1.4vh,14px)] text-[13px] leading-relaxed text-slate-600">
            Use the same email and password you use for Keka. The same sign-in also opens your LMS.
          </p>
        </>
      )}
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
      <div>
        <h2 className="text-lg font-bold text-slate-900">Set up your organisation</h2>
        <p className="mt-1 text-sm text-slate-500">The database is empty. Create the first administrator account to get started — you will then add calendars, employees and projects.</p>
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
      <button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
        {busy && SPINNER}
        Create administrator account
        {!busy && <ArrowRight className="h-5 w-5" />}
      </button>
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
