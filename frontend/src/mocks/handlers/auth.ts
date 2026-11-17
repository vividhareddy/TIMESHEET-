import type { Employee } from '@/types';
import type { AuthResponse, MockAccount, SetupRequest, SetupStatusResponse } from '@/types/api';
import { todayISO } from '@/utils/date';
import { HttpError, badRequest, conflict, newId, required, route } from '../http';
import { emptyDatabase, mockDb } from '../db';
import { buildSampleDatabase } from '../fixtures/demoDataset';
import { db } from './scope';

const tokenFor = (user: Employee): AuthResponse => ({ token: `mock-token.${user.id}`, user });

export const authRoutes = [
  route('GET', '/auth/setup-status', (): SetupStatusResponse => ({ needsSetup: db().employees.length === 0 }), { auth: false }),

  route(
    'POST',
    '/auth/setup',
    (req) => {
      const body = req.body as SetupRequest & { country?: 'US' | 'IN' };
      if (db().employees.length > 0) throw conflict('Setup has already been completed. Please sign in.');
      required(body as unknown as Record<string, unknown>, { organisationName: 'Organisation name', name: 'Name', email: 'Email', password: 'Password' });
      if (!/^\S+@\S+\.\S+$/.test(body.email)) throw badRequest('Invalid email.', { email: 'Enter a valid email address.' });
      if (body.password.length < 8) throw badRequest('Password too short.', { password: 'Use at least 8 characters.' });
      const admin: Employee = {
        id: newId('emp'),
        employeeCode: 'EMP0001',
        name: body.name.trim(),
        email: body.email.trim().toLowerCase(),
        phone: '',
        department: '',
        designation: 'Administrator',
        workLocation: '',
        country: body.country ?? 'US',
        calendarId: '',
        managerId: null,
        systemRole: 'admin',
        status: 'active',
        weeklyCapacity: db().settings.defaultWeeklyTarget,
        joinDate: todayISO(),
        overtimeEligibility: 'inherit',
      };
      db().employees.push(admin);
      db().credentials[admin.id] = body.password;
      db().settings.organisationName = body.organisationName.trim();
      return tokenFor(admin);
    },
    { auth: false },
  ),

  route(
    'POST',
    '/auth/login',
    (req) => {
      required(req.body, { email: 'Email', password: 'Password' });
      const user = db().employees.find((e) => e.email.toLowerCase() === String(req.body.email).trim().toLowerCase());
      if (!user || db().credentials[user.id] !== req.body.password) throw new HttpError(401, 'Invalid email or password.');
      if (user.status !== 'active') throw new HttpError(403, 'This account is inactive. Contact your administrator.');
      return tokenFor(user);
    },
    { auth: false },
  ),

  route('GET', '/auth/me', (req) => req.user),
  route('POST', '/auth/logout', () => undefined, { auth: false }),

  // ------------------------------------------------ mock-mode conveniences
  route(
    'GET',
    '/auth/mock-accounts',
    (): MockAccount[] =>
      db()
        .employees.filter((e) => e.status === 'active')
        .map((e) => ({ id: e.id, name: e.name, designation: e.designation, systemRole: e.systemRole })),
    { auth: false },
  ),
  route(
    'POST',
    '/auth/mock-login',
    (req) => {
      const user = db().employees.find((e) => e.id === req.body?.userId && e.status === 'active');
      if (!user) throw new HttpError(404, 'Account not found.');
      return tokenFor(user);
    },
    { auth: false },
  ),
  route('POST', '/__mock/reset', () => mockDb.replace(emptyDatabase()), { auth: false }),
  route('POST', '/__mock/sample-data', () => mockDb.replace(buildSampleDatabase()), { auth: false }),
];
