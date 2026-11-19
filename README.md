# Project Timesheet & Resource Management System

Project-based timesheets: employees are allocated to multiple client projects, record actual weekly hours, and submit one consolidated weekly timesheet whose project entries are approved by each project's manager.

> Attendance tracking, login/logout timestamps, check-in/check-out and break monitoring are intentionally **not** part of this application.

## Repository layout

```
.
├── frontend/   React + Vite + TypeScript + Tailwind UI   (own package.json / node_modules)
├── backend/    Node.js + Express + MongoDB API           (own package.json / node_modules)
├── lms/        ShimentoX LMS: Python server + static UI, stored in the same MongoDB database
├── .gitignore
└── README.md
```

Each part has its own dependencies and is started from its own folder. The timesheet and the LMS share one MongoDB database and one sign-in (see [LMS and single sign-on](#lms-and-single-sign-on)).

## Prerequisites

- Node.js 20+ and npm
- Python 3 with `pymongo` (for the LMS)
- A MongoDB database (Atlas)

## Getting started

The whole application runs on **one port, http://localhost:5032**, from one command:

| Address | What |
|---|---|
| http://localhost:5032/ | Timesheet UI (React, served by Express — Vite middleware in dev, `frontend/dist` in production) |
| http://localhost:5032/api/ | Timesheet API |
| http://localhost:5032/lms/ | ShimentoX LMS (proxied to the Python server) |

Prerequisites: Node.js 20+, and Python 3 with `pymongo` (`pip install pymongo`) for the LMS.

```bash
cd frontend && npm install && cd ..   # first time only
cd backend
cp .env.example .env      # first time only — then fill in MONGODB_URI, JWT_SECRET, LMS_SSO_SECRET, etc.
npm install               # first time only
npm run dev               # tsx watch — restarts on changes; also starts the LMS
```

`backend/.env` holds the database connection string and secrets. It is git-ignored and must never be committed.

The Express server starts the Python LMS itself, listening on loopback only (`127.0.0.1:5007`, set with `LMS_INTERNAL_PORT`), and forwards `/lms/*` to it with the `/lms` prefix removed. Browsers never use that port. The LMS is told its prefix through `LMS_BASE_PATH=/lms` and trusts the forwarded client address (`LMS_TRUST_PROXY=1`) only from loopback. Related `backend/.env` settings: `LMS_PYTHON` (interpreter, default `python`), and `LMS_AUTOSTART=0` to start the LMS yourself instead (`cd lms && LMS_BASE_PATH=/lms LMS_TRUST_PROXY=1 python backend/server.py`). If the LMS is already running on the internal port (for example after `tsx watch` restarts the API), it is reused; after changing LMS Python code, stop that `python.exe` so it is started again.

Check it is running:

- http://localhost:5032/api/health — API liveness
- http://localhost:5032/api/db-test — MongoDB connectivity
- http://localhost:5032/lms/api/session — LMS reachable through the proxy

Production: build the frontend (`cd frontend && npm run build`), then in `backend/` run `npm run build` and `NODE_ENV=production npm start`.

`lms/backend/.env` holds the single sign-on secret (see below). The LMS reads `MONGODB_URI` / `MONGODB_DB_NAME` from `backend/.env` unless `LMS_MONGODB_URI` / `LMS_MONGODB_DB` are set, and creates its collections (prefixed `lms_`) and course catalogue on first start.

The frontend reads its environment from files in `frontend/`:

| File | Purpose |
|---|---|
| `frontend/.env.example` | Template (committed) |
| `frontend/.env.development` | Used in development — points at `/api` (same server and port) |
| `frontend/.env.production` | Used by `npm run build` |

If `frontend/.env.development` is missing, copy `frontend/.env.example` to it.

Other scripts: `npm run build` (type-check + production bundle in `frontend/dist`), `npm run preview`, `npm run typecheck`.

### Frontend environment variables

| Variable | Values | Purpose |
|---|---|---|
| `VITE_API_MODE` | `api` (default) / `mock` | Real backend vs in-browser mock API |
| `VITE_API_BASE_URL` | `/api` (default) | Express API base URL |

**Mock mode** (`VITE_API_MODE=mock`, development only) is clearly labelled in the UI ("Mock API — not real data"). It starts with an **empty** database stored in the browser. From the sign-in page (or Admin → Settings → Data source) a developer can explicitly load an illustrative sample dataset or reset to empty, and quick-sign-in as any mock account (sample accounts use the password `Password@123`; employees created in mock mode use the temporary password the admin sets in the employee form). None of this exists in API mode, and `src/mocks` is excluded from production builds.

## LMS and single sign-on

The timesheet login is the only login. **My LMS** in the sidebar (every role) opens the LMS in a new tab, already signed in:

1. The frontend calls `POST /api/lms/launch`. The API returns the LMS address with a ticket: an HS256 JWT signed with `LMS_SSO_SECRET`, valid for one minute and usable once, carrying the employee's email, name, role, designation, department, joining date, manager's email and direct reports' emails.
2. The LMS verifies it at `GET /lms/api/auth/timesheet`, creates or updates the LMS account (admin → Admin, manager → Manager, associate → Employee; LMS-only HR/Trainer roles are kept), links the manager and direct reports, and starts its own session. Learning history is never touched.
3. Opening the LMS directly while signed out sends the browser to the timesheet sign-in. `http://localhost:5032/lms/?local=1` still shows the LMS's own sign-in form for LMS-only accounts.

`LMS_SSO_SECRET` must have the same value (at least 32 characters) in `backend/.env` and `lms/backend/.env`. `LMS_URL` (timesheet, `http://localhost:5032/lms`) and `TIMESHEET_URL` (LMS, `http://localhost:5032`) point the two at each other. `LMS_PUBLIC_BASE_URL` in `lms/backend/.env` is the origin only (`http://localhost:5032`); `/lms` is added automatically.

### Sign in with Keka account

The timesheet login page has **Sign in with Keka account** (the same Keka OpenID Connect sign-in the LMS used). Keka verifies the person, and the API signs in the active timesheet employee with the same work email. Accounts are still created by the administrator; a Keka user without a timesheet account is refused. Fill in the `KEKA_*` settings in `backend/.env` (see `backend/.env.example`) and register `<API_PUBLIC_URL>/api/auth/keka/callback` with Keka as the redirect address. Until then the button explains that Keka sign-in is not set up. The LMS's **Sync from Keka** (Users & Teams) keeps working with the `KEKA_API_*` settings in `lms/backend/.env`.

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
