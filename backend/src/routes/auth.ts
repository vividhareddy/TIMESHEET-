import { Router } from 'express';
import bcrypt from 'bcrypt';
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
  res.json({ needsSetup: !(await Organisation.exists({})) });
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
