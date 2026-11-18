import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { currentUser, requireAuth } from '../auth.js';
import { HttpError } from '../http.js';
import { EmployeeModel, type EmployeeLean } from '../models/employee.js';

/**
 * Single sign-on into the LMS ("My LMS" in the sidebar).
 *
 * POST /api/lms/launch returns the LMS address with a one-minute, single-use ticket signed with LMS_SSO_SECRET
 * (shared with lms/backend/.env). The LMS verifies the ticket at /api/auth/timesheet, creates or updates the
 * person's LMS account from these details, and starts its own session — so there is no second sign-in.
 */
export const lmsRouter = Router();

export const LMS_TICKET_ISSUER = 'timesheet-api';
export const LMS_TICKET_AUDIENCE = 'shimentox-lms';

lmsRouter.post('/launch', requireAuth, async (_req, res) => {
  if (!config.lms.ssoSecret) throw new HttpError(503, 'The LMS is not connected yet. Ask your administrator to set LMS_SSO_SECRET.');
  const user = currentUser(res);
  const manager = user.managerId
    ? await EmployeeModel.findById(user.managerId).select('name email status').lean<Pick<EmployeeLean, 'name' | 'email' | 'status'>>()
    : null;
  // Direct reports, so a manager's LMS team view links up even when they open the LMS before their team does.
  const reports = await EmployeeModel.find({ managerId: user.id, status: 'active' }).select('email').limit(500).lean<Pick<EmployeeLean, 'email'>[]>();
  const ticket = jwt.sign(
    {
      email: user.email,
      name: user.name,
      role: user.systemRole,
      employeeCode: user.employeeCode,
      designation: user.designation,
      department: user.department,
      joinDate: user.joinDate,
      managerEmail: manager?.status === 'active' ? manager.email : null,
      reportEmails: reports.map((r) => r.email),
    },
    config.lms.ssoSecret,
    { algorithm: 'HS256', issuer: LMS_TICKET_ISSUER, audience: LMS_TICKET_AUDIENCE, subject: user.id, jwtid: randomUUID(), expiresIn: 60 },
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url: `${config.lms.url}/api/auth/timesheet?${new URLSearchParams({ ticket })}` });
});
