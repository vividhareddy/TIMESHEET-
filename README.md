# Project Timesheet & Resource Management System — Frontend

React frontend for project-based timesheets: employees are allocated to multiple client projects, record actual weekly hours, and submit one consolidated weekly timesheet whose project entries are approved by each project's manager.

> Attendance tracking, login/logout timestamps, check-in/check-out and break monitoring are intentionally **not** part of this application.

## Architecture

```
React UI  →  services/ (typed API modules)  →  Axios  →  Node.js/Express API  →  PostgreSQL
                                                  ↑
                         dev only: src/mocks/ installed as the Axios adapter (VITE_API_MODE=mock)
```

- **No business data in components.** Employees, projects, allocations, calendars, holidays, timesheets, leave, overtime, settings and every business dropdown (departments, work locations, roles, statuses, leave durations, holiday types, overtime approvers) come from the API.
- **Server-owned rules.** Duplicate employee ID / email checks, allocation overlap and date rules, timesheet locking, submission validation, approval permissions (a PM can only review their own projects), leave-hour calculation and overtime flagging are API responsibilities. The mock server in `src/mocks/handlers` implements the same contract and is the reference for the Express implementation.
- **Server-side aggregation.** Dashboard figures and reports come from `/reports/*` endpoints.
- **Honest states.** Every screen has loading, empty, error (with retry) and success states. If the API is unreachable or answers with something other than JSON, the UI shows an error — it never falls back to sample values.
- **Empty database supported.** A fresh database shows first-run setup (create the first administrator), then an onboarding checklist: reference data → calendars → employees → projects → allocations.

## Stack

React 18 · TypeScript (strict) · Vite 5 · Tailwind CSS 3 · React Router 6 · Axios · Lucide icons

## Running

```bash
npm install
npm run dev      # development — mock API (see .env.development)
npm run build    # production — real API only; src/mocks is excluded from the bundle
```

### Modes

| Variable | Values | Purpose |
|---|---|---|
| `VITE_API_MODE` | `api` (default in production) / `mock` (default in development) | Real backend vs in-browser mock API |
| `VITE_API_BASE_URL` | e.g. `http://localhost:5000/api` | Express API base URL |

**Mock mode** is clearly labelled in the UI ("Mock API — not real data"). It starts with an **empty** database stored in the browser. From the sign-in page (or Admin → Settings → Data source) a developer can explicitly load an illustrative sample dataset or reset to empty, and quick-sign-in as any mock account (sample accounts use the password `Password@123`; employees created in mock mode use the temporary password the admin sets in the employee form). None of this exists in API mode.

## Service modules (`src/services`)

| Module | Endpoints |
|---|---|
| `authService` | `GET /auth/setup-status`, `POST /auth/setup`, `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` |
| `employeeService` | `GET/POST /employees`, `GET/PUT /employees/:id`, `PATCH /employees/:id/status` |
| `projectService` | `GET/POST /projects`, `PUT /projects/:id`, `PATCH /projects/:id/status` |
| `allocationService` | `GET/POST /allocations`, `PUT/DELETE /allocations/:id` |
| `timesheetService` | `GET /timesheets`, `GET /timesheets/:id`, `PUT /timesheets/me/draft`, `POST /timesheets/me/submit` |
| `approvalService` | `GET /approvals`, `POST /approvals/review`, `POST /approvals/modify`, `POST /timesheets/:id/reopen` |
| `calendarService` | `GET/POST /calendars`, `PUT /calendars/:id`, `POST/PUT/DELETE /calendars/:id/holidays[/:holidayId]` |
| `leaveService` | `GET/POST /leave-requests`, `POST /leave-requests/:id/review`, `DELETE /leave-requests/:id` |
| `overtimeService` | `GET/POST /overtime-requests`, `POST /overtime-requests/:id/review`, `GET/PUT /policies/overtime` |
| `reportService` | `GET /reports/dashboard/{admin,manager,associate}`, `GET /reports/hours` |
| `lookupService` | `GET /lookups`, departments & work-location CRUD, `GET/PUT /settings` |

Request/response types live in `src/types/api.ts`; domain models in `src/types/index.ts`. Errors are normalised to `ApiError { message, status, fieldErrors }` — forms display `fieldErrors` next to the relevant inputs (e.g. a 409 for a duplicate email).

**Row-level visibility the API must enforce** (see `src/mocks/handlers/scope.ts`): associates see only their own timesheets, allocations, leave and overtime; managers see their projects plus their team; administrators see everything.

## Folder structure

```
src/
  components/   common · sidebar · tables · forms · timesheet · calendar · allocation · reports
  constants/    presentation-only constants (colour palette)
  context/      SessionContext (auth) · AppDataContext (API-backed cache + actions) · ToastContext
  hooks/        useApiQuery · useLookups / useReferenceData · useTableState · useAsyncAction · useNotifications · useTeam
  layouts/      AppLayout
  mocks/        DEV ONLY — mock server, handlers, empty/sample fixtures
  pages/        admin/ · manager/ · associate/ · LoginPage · NotFoundPage
  routes/       AppRoutes (session gate, role guards) · navigation
  services/     apiClient + one module per resource
  types/        domain models · API contracts
  utils/        date, formatting and pure timesheet calculations (shared with the server logic)
```
