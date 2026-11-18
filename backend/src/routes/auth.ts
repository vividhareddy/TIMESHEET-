import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { config } from '../config.js';
import { KekaSignInError, kekaAuthorizeUrl, kekaSsoReady, kekaVerifiedEmail } from '../keka.js';
import { withTransaction } from '../mongo.js';
import { currentUser, requireAuth, revokeToken, signToken } from '../auth.js';
import { EMAIL_RE, HttpError, assertValid, passwordProblem, str, uniqueViolation } from '../http.js';
import { EmployeeModel, employeeFromDoc, type EmployeeLean } from '../models/employee.js';
import { Organisation, SystemFlag } from '../models/organisation.js';

/** bcrypt work factor. 12 ≈ a few hundred ms per hash on current hardware. */
export const BCRYPT_ROUNDS = 12;

// ------------------------------------------------- failed-login throttling

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; first: number }>();

function throttleKey(ip: string | undefined, email: string) {
  return `${ip ?? ''}|${email}`;
}

function assertNotLockedOut(key: string): void {
  const entry = failures.get(key);
  if (!entry) return;
  const elapsed = Date.now() - entry.first;
  if (elapsed > LOCKOUT_MS) {
    failures.delete(key);
    return;
  }
  if (entry.count >= MAX_FAILURES) {
    const minutes = Math.ceil((LOCKOUT_MS - elapsed) / 60_000);
    throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

function recordFailure(key: string): void {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > LOCKOUT_MS) failures.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
}

// A real hash to compare against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', BCRYPT_ROUNDS);

// ------------------------------------------------------------------ setup

interface SetupInput {
  organisationName: string;
  name: string;
  email: string;
  password: string;
}

function validateSetup(body: unknown): SetupInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const input = {
    organisationName: str(b.organisationName),
    name: str(b.name),
    email: str(b.email).toLowerCase(),
    password: typeof b.password === 'string' ? b.password : '',
  };
  const errors: Record<string, string> = {};

  if (!input.organisationName) errors.organisationName = 'Organisation name is required.';
  else if (input.organisationName.length < 2 || input.organisationName.length > 150) errors.organisationName = 'Use between 2 and 150 characters.';

  if (!input.name) errors.name = 'Full name is required.';
  else if (input.name.length < 2 || input.name.length > 100) errors.name = 'Use between 2 and 100 characters.';

  if (!input.email) errors.email = 'Work email is required.';
  else if (input.email.length > 254 || !EMAIL_RE.test(input.email)) errors.email = 'Enter a valid email address.';

  const pw = passwordProblem(input.password);
  if (pw) errors.password = pw;

  assertValid(errors);
  return input;
}

// ------------------------------------------------------------------ routes

export const authRouter = Router();

/** GET /api/auth/setup-status — true until the organisation and first administrator exist. */
authRouter.get('/setup-status', async (_req, res) => {
  res.json({ needsSetup: !(await Organisation.exists({})), kekaSignIn: kekaSsoReady() });
});

// ------------------------------------------------------- Sign in with Keka

const KEKA_COOKIE = 'ts_keka_state';
const KEKA_COOKIE_PATH = '/api/auth/keka';
/** One-time codes handed to the frontend after a Keka sign-in, exchanged for the JWT within a minute. */
const kekaCodes = new Map<string, { token: string; expiresAt: string; employeeId: string; until: number }>();

function kekaStateCookie(value: string, maxAgeSeconds: number): string {
  const secure = config.publicUrls.api.startsWith('https://') ? '; Secure' : '';
  return `${KEKA_COOKIE}=${value}; Path=${KEKA_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function cookieValue(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

const backToLogin = (query: Record<string, string>) => `${config.publicUrls.app}/?${new URLSearchParams(query)}`;

/** GET /api/auth/keka/start — sends the browser to Keka's sign-in page. */
authRouter.get('/keka/start', (_req, res) => {
  if (!kekaSsoReady()) return res.redirect(302, backToLogin({ signin_error: 'keka-not-configured' }));
  const state = randomBytes(24).toString('base64url');
  res.setHeader('Set-Cookie', kekaStateCookie(state, 600));
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, kekaAuthorizeUrl(state, randomBytes(24).toString('base64url')));
});

/** GET /api/auth/keka/callback — Keka returns here; the matching active employee is signed in. */
authRouter.get('/keka/callback', async (req, res) => {
  res.setHeader('Set-Cookie', kekaStateCookie('', 0));
  res.setHeader('Cache-Control', 'no-store');
  const query = req.query as Record<string, unknown>;
  try {
    if (query.error) throw new KekaSignInError('keka-cancelled');
    const expected = cookieValue(req.headers.cookie, KEKA_COOKIE);
    const state = typeof query.state === 'string' ? query.state : '';
    const matches = !!expected && state.length === expected.length && timingSafeEqual(Buffer.from(state), Buffer.from(expected));
    if (!matches) throw new KekaSignInError('keka-expired');
    const email = await kekaVerifiedEmail(typeof query.code === 'string' ? query.code : '');
    // Keka confirms who the person is; the timesheet account (created by the administrator) decides what they can do.
    const row = await EmployeeModel.findOne({ email }).lean<EmployeeLean>();
    if (!row) throw new KekaSignInError('keka-not-employee');
    if (row.status !== 'active') throw new KekaSignInError('keka-inactive');
    await EmployeeModel.updateOne({ _id: row._id }, { $set: { lastLoginAt: new Date() } }, { timestamps: false });
    const { token, expiresAt } = signToken(row._id, false);
    const code = randomBytes(32).toString('base64url');
    const now = Date.now();
    for (const [key, entry] of kekaCodes) if (entry.until < now) kekaCodes.delete(key);
    kekaCodes.set(code, { token, expiresAt, employeeId: row._id, until: now + 60_000 });
    res.redirect(302, backToLogin({ keka_code: code }));
  } catch (err) {
    const code = err instanceof KekaSignInError ? err.code : 'keka-failed';
    if (!(err instanceof KekaSignInError)) console.error('[auth] Keka sign-in failed:', err);
    res.redirect(302, backToLogin({ signin_error: code }));
  }
});

/** POST /api/auth/keka/exchange — { code } → { token, expiresAt, user }. Each code works once, for one minute. */
authRouter.post('/keka/exchange', async (req, res) => {
  const code = str(req.body?.code);
  const entry = code ? kekaCodes.get(code) : undefined;
  if (code) kekaCodes.delete(code);
  if (!entry || entry.until < Date.now()) throw new HttpError(401, 'Your Keka sign-in has expired. Please sign in again.');
  const row = await EmployeeModel.findById(entry.employeeId).lean<EmployeeLean>();
  if (!row) throw new HttpError(401, 'Your Keka sign-in has expired. Please sign in again.');
  if (row.status !== 'active') throw new HttpError(403, 'Your account is inactive. Contact your administrator.');
  res.json({ token: entry.token, expiresAt: entry.expiresAt, user: employeeFromDoc(row) });
});

/**
 * POST /api/auth/setup — creates the organisation and its first administrator, then signs them in.
 * Only works while the database has no organisation: this is the single way an administrator is
 * created without an existing administrator, so nobody can register themselves as Admin later.
 */
authRouter.post('/setup', async (req, res) => {
  const input = validateSetup(req.body);
  // Hash before opening the transaction so it is not held open during the slow bcrypt step.
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  try {
    const { organisation, admin } = await withTransaction(async (session) => {
      if (await Organisation.exists({}).session(session)) throw new HttpError(409, 'Setup has already been completed. Please sign in.');
      // The fixed-id marker makes two concurrent first-run submissions conflict, so only one can commit.
      await SystemFlag.create([{ _id: 'setup' }], { session });
      const [org] = await Organisation.create([{ name: input.organisationName }], { session });
      const [emp] = await EmployeeModel.create(
        [{
          organisationId: org!._id, employeeCode: 'EMP0001', name: input.name, email: input.email, passwordHash,
          designation: 'Administrator', systemRole: 'admin', lastLoginAt: new Date(),
        }],
        { session },
      );
      return { organisation: { id: org!._id, name: org!.name }, admin: emp!.toObject() as unknown as EmployeeLean };
    });
    console.log(`[auth] Organisation "${organisation.name}" created with administrator ${admin.email}.`);
    const { token, expiresAt } = signToken(admin._id, false);
    res.status(201).json({ token, expiresAt, user: employeeFromDoc(admin), organisation });
  } catch (err) {
    const index = uniqueViolation(err);
    if (index === null) throw err;
    if (index === 'employees_email_key') throw new HttpError(409, 'An account with this email already exists.', { email: 'This email is already registered.' });
    if (index === 'organisations_name_key') throw new HttpError(409, 'This organisation is already registered.', { organisationName: 'This organisation is already registered.' });
    // The setup marker (or the first employee code) already exists: another setup request won.
    throw new HttpError(409, 'Setup has already been completed. Please sign in.');
  }
});

/** POST /api/auth/login — { email, password, rememberMe? } → { token, expiresAt, user } */
authRouter.post('/login', async (req, res) => {
  const email = str(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const rememberMe = req.body?.rememberMe === true;

  const errors: Record<string, string> = {};
  if (!email) errors.email = 'Work email is required.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (!password) errors.password = 'Password is required.';
  assertValid(errors);

  const key = throttleKey(req.ip, email);
  assertNotLockedOut(key);

  // Emails are stored lower-case, so this exact match is case-insensitive.
  const row = await EmployeeModel.findOne({ email }).lean<EmployeeLean>();
  const valid = await bcrypt.compare(password, row?.passwordHash ?? DUMMY_HASH);
  if (!row || !valid) {
    recordFailure(key);
    throw new HttpError(401, 'Invalid email or password.');
  }
  failures.delete(key);
  // Only revealed after the correct password, so it does not leak which accounts exist.
  if (row.status !== 'active') throw new HttpError(403, 'Your account is inactive. Contact your administrator.');

  await EmployeeModel.updateOne({ _id: row._id }, { $set: { lastLoginAt: new Date() } }, { timestamps: false });
  const { token, expiresAt } = signToken(row._id, rememberMe);
  res.json({ token, expiresAt, user: employeeFromDoc(row) });
});

/** GET /api/auth/me — the signed-in employee. */
authRouter.get('/me', requireAuth, (_req, res) => {
  const { organisationId: _org, ...user } = currentUser(res);
  res.json(user);
});

/** POST /api/auth/logout — revokes the current token. */
authRouter.post('/logout', async (req, res) => {
  await revokeToken(req);
  res.status(204).end();
});
