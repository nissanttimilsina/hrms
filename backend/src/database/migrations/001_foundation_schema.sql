-- ============================================================================
-- 001 Foundation schema
-- Platform, tenancy, auth sessions, RBAC, subscription engine, org basics, audit
--
-- Conventions
--  * UUID primary keys (gen_random_uuid()).
--  * Every tenant-owned table carries tenant_id and gets RLS in 002.
--  * Intra-tenant references use COMPOSITE foreign keys (tenant_id, x_id) ->
--    (tenant_id, id) so a row can never reference another tenant's row.
--  * Status/enum columns are TEXT + CHECK (easier to evolve than PG enums).
--  * Money: numeric(14,2). Timestamps: timestamptz (UTC).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shared trigger to maintain updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Platform (Lishnu Tech staff) — not tenant-scoped
-- ---------------------------------------------------------------------------
CREATE TABLE platform_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  full_name       text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INVITED','ACTIVE','DISABLED')),
  mfa_secret_enc  text,
  failed_logins   int  NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false
);

CREATE TABLE platform_permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE CHECK (key ~ '^[a-z_]+:[a-z_]+$'),
  description text
);

CREATE TABLE platform_role_permissions (
  role_id       uuid NOT NULL REFERENCES platform_roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES platform_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE platform_user_roles (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES platform_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$'),
  name             text NOT NULL,
  legal_name       text,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','ARCHIVED')),
  industry         text,
  country          char(2) NOT NULL DEFAULT 'NP',
  timezone         text NOT NULL DEFAULT 'Asia/Kathmandu',
  currency         char(3) NOT NULL DEFAULT 'NPR',
  locale           text NOT NULL DEFAULT 'en',
  calendar         text NOT NULL DEFAULT 'BS' CHECK (calendar IN ('BS','AD')),
  deployment_mode  text NOT NULL DEFAULT 'SHARED' CHECK (deployment_mode IN ('SHARED','DEDICATED')),
  dedicated_db_ref text,             -- secret-manager key, never a raw connection string
  suspended_reason text,
  archived_at      timestamptz,
  retention_until  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_domains (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hostname           citext NOT NULL UNIQUE,
  type               text NOT NULL CHECK (type IN ('SUBDOMAIN','CUSTOM')),
  is_primary         boolean NOT NULL DEFAULT false,
  verification_token text,
  verified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_domains_tenant_idx ON tenant_domains(tenant_id);
CREATE UNIQUE INDEX tenant_domains_one_primary ON tenant_domains(tenant_id) WHERE is_primary;

CREATE TABLE tenant_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

-- ---------------------------------------------------------------------------
-- Organization foundation (expanded in Phase 4)
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           text NOT NULL,
  name           text NOT NULL,
  address        text,
  is_head_office boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id  uuid,
  parent_id  uuid,
  code       text NOT NULL,
  name       text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES departments(tenant_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE employees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_code text NOT NULL,
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  work_email    citext,
  phone         text,
  branch_id     uuid,
  department_id uuid,
  manager_id    uuid,
  status        text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','PROBATION','ON_NOTICE','SUSPENDED','TERMINATED')),
  joined_on     date NOT NULL,
  exited_on     date,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_code),
  FOREIGN KEY (tenant_id, branch_id)     REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id)    REFERENCES employees(tenant_id, id),
  CHECK (manager_id IS NULL OR manager_id <> id),
  CHECK (exited_on IS NULL OR exited_on >= joined_on)
);
CREATE INDEX employees_tenant_status_idx ON employees(tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX employees_tenant_branch_idx ON employees(tenant_id, branch_id);
CREATE INDEX employees_tenant_dept_idx   ON employees(tenant_id, department_id);
CREATE INDEX employees_tenant_mgr_idx    ON employees(tenant_id, manager_id);

-- ---------------------------------------------------------------------------
-- Tenant users & RBAC
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email             citext NOT NULL,
  password_hash     text,
  full_name         text NOT NULL,
  status            text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED','ACTIVE','DISABLED')),
  employee_id       uuid,
  email_verified_at timestamptz,
  mfa_secret_enc    text,
  failed_logins     int NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);

-- Global permission catalogue. key = "<module>:<action>"
CREATE TABLE permissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL UNIQUE CHECK (key ~ '^[a-z_]+:[a-z_]+$'),
  module         text NOT NULL,
  action         text NOT NULL CHECK (action IN
                   ('view','create','edit','delete','approve','reject','export','import','configure','manage')),
  description    text,
  supports_scope boolean NOT NULL DEFAULT true
);
CREATE INDEX permissions_module_idx ON permissions(module);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL CHECK (key ~ '^[a-z0-9_]+$'),
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key)
);

CREATE TABLE role_permissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  scope         text NOT NULL DEFAULT 'OWN'
                CHECK (scope IN ('OWN','DIRECT_REPORTS','DEPARTMENT','BRANCH','SELECTED_BRANCHES','COMPANY')),
  branch_ids    uuid[] NOT NULL DEFAULT '{}',
  UNIQUE (role_id, permission_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE,
  CHECK (scope <> 'SELECTED_BRANCHES' OR cardinality(branch_ids) > 0)
);
CREATE INDEX role_permissions_tenant_role_idx ON role_permissions(tenant_id, role_id);

CREATE TABLE user_roles (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL,
  role_id   uuid NOT NULL,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_roles_tenant_role_idx ON user_roles(tenant_id, role_id);

CREATE TABLE tenant_invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         citext NOT NULL,
  role_id       uuid NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  invited_by_id uuid,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX tenant_invitations_email_idx ON tenant_invitations(tenant_id, email);

-- Refresh-token sessions for platform + tenant users (auth service only)
CREATE TABLE auth_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   text NOT NULL CHECK (subject_type IN ('PLATFORM','TENANT')),
  user_id        uuid NOT NULL,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,
  family_id      uuid NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoke_reason  text,
  replaced_by_id uuid,
  user_agent     text,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  CHECK ((subject_type = 'TENANT') = (tenant_id IS NOT NULL))
);
CREATE INDEX auth_sessions_user_idx   ON auth_sessions(subject_type, user_id);
CREATE INDEX auth_sessions_family_idx ON auth_sessions(family_id);

-- ---------------------------------------------------------------------------
-- Subscription engine
-- ---------------------------------------------------------------------------
CREATE TABLE feature_catalog (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE CHECK (key ~ '^[a-z_]+$'),
  name        text NOT NULL,
  category    text NOT NULL,
  description text,
  is_core     boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]+$'),
  name           text NOT NULL,
  description    text,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  is_public      boolean NOT NULL DEFAULT true,
  is_custom      boolean NOT NULL DEFAULT false,
  contact_sales  boolean NOT NULL DEFAULT false,
  sort_order     int NOT NULL DEFAULT 0,
  trial_days     int NOT NULL DEFAULT 14 CHECK (trial_days >= 0),
  grace_days     int NOT NULL DEFAULT 7  CHECK (grace_days >= 0),
  max_employees  int CHECK (max_employees  IS NULL OR max_employees  >= 0),  -- NULL = unlimited
  max_branches   int CHECK (max_branches   IS NULL OR max_branches   >= 0),
  max_users      int CHECK (max_users      IS NULL OR max_users      >= 0),
  max_storage_mb int CHECK (max_storage_mb IS NULL OR max_storage_mb >= 0),
  highlights     jsonb NOT NULL DEFAULT '[]',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Versioned prices: never UPDATE an amount; close the old row and insert a new one.
CREATE TABLE plan_prices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id        uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  billing_cycle  text NOT NULL CHECK (billing_cycle IN ('MONTHLY','ANNUAL')),
  currency       char(3) NOT NULL DEFAULT 'NPR',
  amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX plan_prices_lookup_idx ON plan_prices(plan_id, billing_cycle, currency, effective_from DESC);
CREATE UNIQUE INDEX plan_prices_one_open ON plan_prices(plan_id, billing_cycle, currency) WHERE effective_to IS NULL;

CREATE TABLE plan_entitlements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_id uuid NOT NULL REFERENCES feature_catalog(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT true,
  config     jsonb NOT NULL DEFAULT '{}',
  UNIQUE (plan_id, feature_id)
);

CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id                uuid NOT NULL REFERENCES plans(id),
  previous_plan_id       uuid REFERENCES plans(id),
  pending_plan_id        uuid REFERENCES plans(id),  -- downgrade at renewal
  status                 text NOT NULL CHECK (status IN
                           ('TRIAL','ACTIVE','PAST_DUE','GRACE_PERIOD','SUSPENDED','CANCELLED','EXPIRED')),
  billing_cycle          text NOT NULL CHECK (billing_cycle IN ('MONTHLY','ANNUAL')),
  currency               char(3) NOT NULL DEFAULT 'NPR',
  amount                 numeric(14,2) NOT NULL CHECK (amount >= 0),
  discount_amount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount             numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  payment_status         text NOT NULL DEFAULT 'PENDING'
                           CHECK (payment_status IN ('NOT_REQUIRED','PENDING','PAID','FAILED','REFUNDED')),
  auto_renew             boolean NOT NULL DEFAULT true,
  starts_at              timestamptz NOT NULL,
  trial_ends_at          timestamptz,
  current_period_end     timestamptz NOT NULL,
  grace_ends_at          timestamptz,
  cancelled_at           timestamptz,
  max_employees_override int CHECK (max_employees_override IS NULL OR max_employees_override >= 0),
  max_branches_override  int CHECK (max_branches_override  IS NULL OR max_branches_override  >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (current_period_end > starts_at)
);
-- Exactly one "live" subscription per tenant
CREATE UNIQUE INDEX subscriptions_one_live_per_tenant
  ON subscriptions(tenant_id) WHERE status NOT IN ('CANCELLED','EXPIRED');
CREATE INDEX subscriptions_status_end_idx ON subscriptions(status, current_period_end);

CREATE TABLE subscription_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL,
  type            text NOT NULL CHECK (type IN
                    ('ADDON_MODULE','EXTRA_EMPLOYEES','EXTRA_BRANCHES','EXTRA_STORAGE_MB','EXTRA_USERS')),
  feature_key     text REFERENCES feature_catalog(key),
  quantity        int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount     numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_amount >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions(tenant_id, id) ON DELETE CASCADE,
  CHECK ((type = 'ADDON_MODULE') = (feature_key IS NOT NULL))
);
CREATE INDEX subscription_items_sub_idx ON subscription_items(tenant_id, subscription_id);

CREATE TABLE subscription_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL,
  type            text NOT NULL,
  from_status     text,
  to_status       text,
  payload         jsonb NOT NULL DEFAULT '{}',
  actor_type      text NOT NULL CHECK (actor_type IN ('PLATFORM_USER','TENANT_USER','SYSTEM')),
  actor_id        uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX subscription_events_sub_idx ON subscription_events(tenant_id, subscription_id, created_at);

CREATE TABLE subscription_usage (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric     text NOT NULL,
  value      bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, metric)
);

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,  -- NULL = platform-level
  actor_type  text NOT NULL CHECK (actor_type IN ('PLATFORM_USER','TENANT_USER','SYSTEM')),
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  ip          text,
  user_agent  text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_time_idx ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx       ON audit_logs(actor_type, actor_id);

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_users','tenants','tenant_settings','branches','departments',
                           'employees','users','roles','plans','subscriptions','subscription_usage']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
