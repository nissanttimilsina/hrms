-- ============================================================================
-- 005 Core HRMS: designations, employee profile & history, shifts, attendance,
--     leave, holidays, announcements, notifications, files
-- ============================================================================

CREATE TABLE designations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  level      int,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  start_time      time NOT NULL,
  end_time        time NOT NULL,              -- may be < start_time for night shifts
  break_minutes   int NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 600),
  grace_minutes   int NOT NULL DEFAULT 10 CHECK (grace_minutes BETWEEN 0 AND 240),
  weekly_offs     text[] NOT NULL DEFAULT '{SAT}',
  is_default      boolean NOT NULL DEFAULT false,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE UNIQUE INDEX shifts_one_default ON shifts(tenant_id) WHERE is_default AND deleted_at IS NULL;

ALTER TABLE employees
  ADD COLUMN designation_id   uuid,
  ADD COLUMN shift_id         uuid,
  ADD COLUMN employment_type  text NOT NULL DEFAULT 'PERMANENT'
             CHECK (employment_type IN ('PERMANENT','PROBATION','CONTRACT','PART_TIME','INTERN','DAILY_WAGE')),
  ADD COLUMN date_of_birth    date,
  ADD COLUMN gender           text CHECK (gender IS NULL OR gender IN ('FEMALE','MALE','OTHER','UNDISCLOSED')),
  ADD COLUMN marital_status   text CHECK (marital_status IS NULL OR marital_status IN ('SINGLE','MARRIED','OTHER')),
  ADD COLUMN personal_email   citext,
  ADD COLUMN pan              text CHECK (pan IS NULL OR pan ~ '^[0-9]{9}$'),
  ADD COLUMN ssf_id           text,
  ADD COLUMN citizenship_no   text,
  ADD COLUMN address          jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN emergency_contacts jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN bank             jsonb NOT NULL DEFAULT '{}',      -- { bankName, branch, accountName, accountNumberEnc, last4 }
  ADD COLUMN contract_end_on  date,
  ADD COLUMN probation_end_on date,
  ADD COLUMN photo_file_id    uuid,
  ADD COLUMN custom_fields    jsonb NOT NULL DEFAULT '{}',
  ADD FOREIGN KEY (tenant_id, designation_id) REFERENCES designations(tenant_id, id),
  ADD FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts(tenant_id, id);

-- Append-only employment history (never overwritten)
CREATE TABLE employee_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL,
  type           text NOT NULL CHECK (type IN ('JOINED','TRANSFER','PROMOTION','DESIGNATION_CHANGE','STATUS_CHANGE','CONTRACT_RENEWAL','TERMINATION','REHIRE','PROFILE_UPDATE')),
  effective_on   date NOT NULL,
  from_value     jsonb NOT NULL DEFAULT '{}',
  to_value       jsonb NOT NULL DEFAULT '{}',
  note           text,
  actor_id       uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX employee_history_emp_idx ON employee_history(tenant_id, employee_id, effective_on DESC);

-- Private file storage metadata (bytes live in S3-compatible storage or local disk)
CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_type   text NOT NULL CHECK (owner_type IN ('EMPLOYEE_DOCUMENT','EMPLOYEE_PHOTO','COMPANY_POLICY','LEAVE_ATTACHMENT','OTHER')),
  owner_id     uuid,
  storage_key  text NOT NULL UNIQUE,          -- tenants/<tenant_id>/<uuid>
  filename     text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  sha256       text NOT NULL,
  category     text,
  expires_on   date,
  uploaded_by  uuid,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX files_owner_idx ON files(tenant_id, owner_type, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX files_expiry_idx ON files(tenant_id, expires_on) WHERE deleted_at IS NULL AND expires_on IS NOT NULL;

-- ---------------------------------------------------------------- attendance
CREATE TABLE attendance_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL,
  work_date        date NOT NULL,                -- business date in tenant timezone
  clock_in         timestamptz,
  clock_out        timestamptz,
  in_meta          jsonb NOT NULL DEFAULT '{}',  -- { source, ip, lat, lng, accuracy, distanceM }
  out_meta         jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'PRESENT'
                   CHECK (status IN ('PRESENT','LATE','HALF_DAY','ABSENT','ON_LEAVE','HOLIDAY','WEEKLY_OFF')),
  late_minutes     int NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_minutes    int NOT NULL DEFAULT 0 CHECK (early_minutes >= 0),
  worked_minutes   int NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  overtime_minutes int NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  source           text NOT NULL DEFAULT 'WEB' CHECK (source IN ('WEB','MOBILE','MANUAL','DEVICE','CORRECTION','SYSTEM')),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  CHECK (clock_out IS NULL OR clock_in IS NULL OR clock_out >= clock_in)
);
CREATE INDEX attendance_date_idx ON attendance_records(tenant_id, work_date);

CREATE TABLE attendance_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  work_date     date NOT NULL,
  clock_in      timestamptz,
  clock_out     timestamptz,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_by  uuid NOT NULL,
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  CHECK (clock_in IS NOT NULL OR clock_out IS NOT NULL)
);
CREATE INDEX attendance_corrections_idx ON attendance_corrections(tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------- leave
CREATE TABLE holidays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date        date NOT NULL,
  name        text NOT NULL,
  is_optional boolean NOT NULL DEFAULT false,
  branch_ids  uuid[] NOT NULL DEFAULT '{}',   -- empty = all branches
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, date, name)
);

CREATE TABLE leave_types (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,20}$'),
  name               text NOT NULL,
  is_paid            boolean NOT NULL DEFAULT true,
  annual_quota       numeric(5,1) NOT NULL DEFAULT 0 CHECK (annual_quota >= 0),
  accrual            text NOT NULL DEFAULT 'YEARLY' CHECK (accrual IN ('YEARLY','MONTHLY','NONE')),
  carry_forward_max  numeric(5,1) NOT NULL DEFAULT 0 CHECK (carry_forward_max >= 0),
  encashable         boolean NOT NULL DEFAULT false,
  allow_half_day     boolean NOT NULL DEFAULT true,
  allow_negative     boolean NOT NULL DEFAULT false,
  max_consecutive_days int CHECK (max_consecutive_days IS NULL OR max_consecutive_days > 0),
  min_notice_days    int NOT NULL DEFAULT 0 CHECK (min_notice_days >= 0),
  approval_levels    int NOT NULL DEFAULT 1 CHECK (approval_levels BETWEEN 1 AND 3),
  applies_to_gender  text CHECK (applies_to_gender IS NULL OR applies_to_gender IN ('FEMALE','MALE')),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- Ledger: balance = sum(days) per employee/type/leave_year. Never updated, only appended.
CREATE TABLE leave_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  leave_year    text NOT NULL,                         -- e.g. '2083/84' (Nepal fiscal year)
  kind          text NOT NULL CHECK (kind IN ('ALLOCATION','ACCRUAL','CARRY_FORWARD','USAGE','REVERSAL','ADJUSTMENT','ENCASHMENT','EXPIRY')),
  days          numeric(6,1) NOT NULL,                 -- +credit / -debit
  request_id    uuid,
  note          text,
  actor_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id)
);
CREATE INDEX leave_tx_balance_idx ON leave_transactions(tenant_id, employee_id, leave_type_id, leave_year);
CREATE UNIQUE INDEX leave_tx_one_allocation ON leave_transactions(tenant_id, employee_id, leave_type_id, leave_year, kind) WHERE kind IN ('ALLOCATION','CARRY_FORWARD');

CREATE TABLE leave_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  half_day      text CHECK (half_day IS NULL OR half_day IN ('FIRST_HALF','SECOND_HALF')),
  days          numeric(5,1) NOT NULL CHECK (days > 0),
  leave_year    text NOT NULL,
  reason        text,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  current_level int NOT NULL DEFAULT 1,
  required_levels int NOT NULL DEFAULT 1,
  requested_by  uuid NOT NULL,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id),
  CHECK (end_date >= start_date),
  CHECK (half_day IS NULL OR start_date = end_date)
);
CREATE INDEX leave_requests_emp_idx ON leave_requests(tenant_id, employee_id, start_date);
CREATE INDEX leave_requests_status_idx ON leave_requests(tenant_id, status);

CREATE TABLE leave_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id  uuid NOT NULL,
  level       int NOT NULL,
  decision    text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  approver_id uuid NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, request_id) REFERENCES leave_requests(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (request_id, level)
);

-- ---------------------------------------------------------------- communication
CREATE TABLE announcements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text NOT NULL,
  branch_ids   uuid[] NOT NULL DEFAULT '{}',
  pinned       boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  author_id    uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_idx ON announcements(tenant_id, published_at DESC);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX notifications_user_idx ON notifications(tenant_id, user_id, read_at, created_at DESC);

-- ---------------------------------------------------------------- triggers, RLS, grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['designations','shifts','attendance_records','leave_types','leave_requests'] LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['designations','shifts','employee_history','files','attendance_records','attendance_corrections',
                           'holidays','leave_types','leave_transactions','leave_requests','leave_approvals','announcements','notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO hrms_app
                     USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hrms_app, hrms_system', t);
  END LOOP;
END $$;

-- Ledgers and histories are append-only for the application.
REVOKE UPDATE, DELETE ON employee_history, leave_transactions, leave_approvals FROM hrms_app, hrms_system;
