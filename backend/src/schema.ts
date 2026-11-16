import { pool } from './db.js';

/**
 * Creates the tables this API needs if they do not exist yet.
 * Idempotent: safe to run on every start; existing business data is never dropped.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS organisations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(150) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organisations_name_key ON organisations (lower(name));
-- Organisation-wide settings and overtime policy (defaults are applied in code when a key is missing).
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS settings        jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS overtime_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS calendars (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             varchar(100) NOT NULL,
  country          char(2) NOT NULL CHECK (country IN ('US', 'IN')),
  timezone         varchar(64) NOT NULL,
  working_days     smallint[] NOT NULL,
  hours_per_day    numeric(4,2) NOT NULL CHECK (hours_per_day > 0 AND hours_per_day <= 12),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendars_name_key ON calendars (organisation_id, lower(name));

CREATE TABLE IF NOT EXISTS holidays (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id  uuid NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  date         date NOT NULL,
  name         varchar(100) NOT NULL,
  type         varchar(10) NOT NULL CHECK (type IN ('public', 'company')),
  UNIQUE (calendar_id, date)
);

CREATE TABLE IF NOT EXISTS departments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             varchar(100) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS departments_name_key ON departments (organisation_id, lower(name));

CREATE TABLE IF NOT EXISTS work_locations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name                 varchar(100) NOT NULL,
  country              char(2) NOT NULL CHECK (country IN ('US', 'IN')),
  default_calendar_id  uuid NULL REFERENCES calendars(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS work_locations_name_key ON work_locations (organisation_id, lower(name));

CREATE TABLE IF NOT EXISTS employees (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  employee_code    varchar(20) NOT NULL UNIQUE,
  name             varchar(100) NOT NULL,
  email            varchar(254) NOT NULL,
  password_hash    varchar(100) NOT NULL,
  phone            varchar(30)  NOT NULL DEFAULT '',
  department       varchar(100) NOT NULL DEFAULT '',
  designation      varchar(100) NOT NULL DEFAULT '',
  work_location    varchar(100) NOT NULL DEFAULT '',
  country          char(2)      NOT NULL DEFAULT 'US' CHECK (country IN ('US', 'IN')),
  calendar_id      uuid NULL,
  manager_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  system_role      varchar(20)  NOT NULL CHECK (system_role IN ('admin', 'manager', 'associate')),
  status           varchar(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  weekly_capacity  numeric(5,2) NOT NULL DEFAULT 40 CHECK (weekly_capacity >= 0),
  join_date        date NOT NULL DEFAULT CURRENT_DATE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_email_key ON employees (lower(email));
ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_login_at timestamptz NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_calendar_fk') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_calendar_fk FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  code             varchar(20)  NOT NULL,
  name             varchar(150) NOT NULL,
  client           varchar(150) NOT NULL,
  description      text         NOT NULL DEFAULT '',
  manager_id       uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  status           varchar(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'completed', 'inactive')),
  billable         boolean      NOT NULL DEFAULT true,
  color            char(7)      NOT NULL CHECK (color ~* '^#[0-9a-f]{6}$'),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT projects_dates_check CHECK (end_date >= start_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_code_key ON projects (organisation_id, upper(code));
CREATE UNIQUE INDEX IF NOT EXISTS projects_name_key ON projects (organisation_id, lower(name));
CREATE INDEX IF NOT EXISTS projects_manager_idx ON projects (manager_id);

-- Signed-out JWTs (by token id) until they would have expired anyway.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti         uuid PRIMARY KEY,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS revoked_tokens_expiry_idx ON revoked_tokens (expires_at);

-- Replaced by JWT authentication; only ever held short-lived opaque tokens.
DROP TABLE IF EXISTS sessions;
`;

export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
