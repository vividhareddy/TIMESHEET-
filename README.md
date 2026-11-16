# Project Timesheet & Resource Management System

Project-based timesheets: employees are allocated to multiple client projects, record actual weekly hours, and submit one consolidated weekly timesheet whose project entries are approved by each project's manager.

> Attendance tracking, login/logout timestamps, check-in/check-out and break monitoring are intentionally **not** part of this application.

## Repository layout

```
.
├── frontend/   React + Vite + TypeScript + Tailwind UI   (own package.json / node_modules)
├── backend/    Node.js + Express + PostgreSQL API        (own package.json / node_modules)
├── .gitignore
└── README.md
```

The two applications are independent: each has its own dependencies and is installed and started from its own folder.

## Prerequisites

- Node.js 20+ and npm
- PostgreSQL running locally (default `localhost:5432`)

## Getting started

### 1. Backend (API on http://localhost:5000)

```bash
cd backend
cp .env.example .env      # first time only — then fill in PGPASSWORD, JWT_SECRET, etc.
npm install
npm run dev               # tsx watch — restarts on changes
```

`backend/.env` holds the database password and JWT secret. It is git-ignored and must never be committed. The database tables are created automatically on startup.

Check it is running:

- http://localhost:5000/api/health — API liveness
- http://localhost:5000/api/db-test — PostgreSQL connectivity

Production: `npm run build` then `npm start`.

### 2. Frontend (UI on http://localhost:5173)

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

The frontend reads its environment from files in `frontend/`:

| File | Purpose |
|---|---|
| `frontend/.env.example` | Template (committed) |
| `frontend/.env.development` | Used by `npm run dev` — points at `http://localhost:5000/api` |
| `frontend/.env.production` | Used by `npm run build` |

If `frontend/.env.development` is missing, copy `frontend/.env.example` to it.

Other scripts: `npm run build` (type-check + production bundle in `frontend/dist`), `npm run preview`, `npm run typecheck`.

### Frontend environment variables

| Variable | Values | Purpose |
|---|---|---|
| `VITE_API_MODE` | `api` (default) / `mock` | Real backend vs in-browser mock API |
| `VITE_API_BASE_URL` | e.g. `http://localhost:5000/api` | Express API base URL |

**Mock mode** (`VITE_API_MODE=mock`, development only) is clearly labelled in the UI ("Mock API — not real data"). It starts with an **empty** database stored in the browser. From the sign-in page (or Admin → Settings → Data source) a developer can explicitly load an illustrative sample dataset or reset to empty, and quick-sign-in as any mock account (sample accounts use the password `Password@123`; employees created in mock mode use the temporary password the admin sets in the employee form). None of this exists in API mode, and `src/mocks` is excluded from production builds.

## Architecture

```
React UI  →  services/ (typed API modules)  →  Axios  →  Node.js/Express API  →  PostgreSQL
                                                  ↑
                frontend dev only: src/mocks/ installed as the Axios adapter (VITE_API_MODE=mock)
```

- **No business data in components.** Employees, projects, allocations, calendars, holidays, timesheets, leave, overtime, settings and every business dropdown (departments, work locations, roles, statuses, leave durations, holiday types, overtime approvers) come from the API.
- **Server-owned rules.** Duplicate employee ID / email checks, allocation overlap and date rules, timesheet locking, submission validation, approval permissions (a PM can only review their own projects), leave-hour calculation and overtime flagging are API responsibilities. The mock server in `frontend/src/mocks/handlers` implements the same contract and is the reference for the Express implementation.
- **Server-side aggregation.** Dashboard figures and reports come from `/reports/*` endpoints.
- **Honest states.** Every screen has loading, empty, error (with retry) and success states. If the API is unreachable or answers with something other than JSON, the UI shows an error — it never falls back to sample values.
- **Empty database supported.** A fresh database shows first-run setup (create the first administrator), then an onboarding checklist: reference data → calendars → employees → projects → allocations.

## Stack

- **Frontend:** React 18 · TypeScript (strict) · Vite 5 · Tailwind CSS 3 · React Router 6 · Axios · Lucide icons
- **Backend:** Node.js · Express 5 · TypeScript · PostgreSQL (`pg`) · JWT auth · bcrypt

## Service modules (`frontend/src/services`)

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

Request/response types live in `frontend/src/types/api.ts`; domain models in `frontend/src/types/index.ts`. Errors are normalised to `ApiError { message, status, fieldErrors }` — forms display `fieldErrors` next to the relevant inputs (e.g. a 409 for a duplicate email).

**Row-level visibility the API must enforce** (see `frontend/src/mocks/handlers/scope.ts`): associates see only their own timesheets, allocations, leave and overtime; managers see their projects plus their team; administrators see everything.

## Folder structure

```
frontend/
  index.html · vite.config.ts · tailwind.config.js · postcss.config.js · tsconfig.json
  public/       static assets
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

backend/
  src/
    server.ts     Express app, routes, error handling
    config.ts     environment loading/validation (backend/.env)
    db.ts         PostgreSQL pool
    schema.ts     idempotent table creation on startup
    auth.ts       JWT middleware
    routes/       auth · employees · projects · calendars · organisation
    models/
```
