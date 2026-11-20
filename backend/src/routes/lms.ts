import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
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

/**
 * GET /api/lms/courses — the LMS course catalogue, for the assistant ("how many courses", "technical courses").
 * Read-only from the LMS's own collections in the shared MongoDB database (prefix LMS_COLLECTION_PREFIX, default
 * "lms_"). Only published courses open to every employee are listed; department-only courses are left out, so the
 * assistant never shows a course the person could not open. No progress or personal data is returned.
 */
export interface CatalogCourse {
  id: string;
  title: string;
  category: string;
  description: string;
  difficulty: string;
  durationMinutes: number;
  lessonCount: number;
}

lmsRouter.get('/courses', requireAuth, async (_req, res) => {
  const db = mongoose.connection.db;
  if (!db) throw new HttpError(503, 'The database is unavailable. Please try again shortly.');
  const prefix = process.env.LMS_COLLECTION_PREFIX || 'lms_';
  const rows = await db
    .collection(`${prefix}courses`)
    .find(
      { status: 'published', $or: [{ visibility: { $ne: 'department' } }, { department_id: { $in: [null, ''] } }] },
      { projection: { _id: 0, id: 1, title: 1, category: 1, description: 1, difficulty: 1, duration_minutes: 1 } },
    )
    .toArray();
  const ids = rows.map((r) => String(r.id));
  const lessonCounts = ids.length
    ? await db
        .collection(`${prefix}course_lessons`)
        .aggregate<{ _id: string; n: number }>([{ $match: { course_id: { $in: ids } } }, { $group: { _id: '$course_id', n: { $sum: 1 } } }])
        .toArray()
    : [];
  const lessons = new Map(lessonCounts.map((c) => [c._id, c.n]));
  const courses: CatalogCourse[] = rows
    .map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      category: String(r.category ?? 'Other'),
      description: String(r.description ?? ''),
      difficulty: String(r.difficulty ?? ''),
      durationMinutes: Number(r.duration_minutes) || 0,
      lessonCount: lessons.get(String(r.id)) ?? 0,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ total: courses.length, courses });
});
