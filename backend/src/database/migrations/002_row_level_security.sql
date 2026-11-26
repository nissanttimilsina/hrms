-- ============================================================================
-- 002 Row-Level Security & grants
--
-- Database roles (created by infrastructure/docker/postgres/00-roles.sh):
--   hrms_owner   owns the schema, runs migrations. Never used at runtime.
--   hrms_app     runtime role for tenant requests. NOBYPASSRLS. Sees only rows
--                whose tenant_id = current_setting('app.tenant_id'), which the
--                API sets per transaction (SET LOCAL) from the verified session.
--   hrms_system  runtime role for platform admin, tenant resolution, auth
--                sessions and schedulers. BYPASSRLS. Used by a separate pool.
--
-- If app.tenant_id is unset, current_tenant_id() is NULL and every policy
-- evaluates to false: the app role FAILS CLOSED (sees and writes nothing).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_system') THEN
    RAISE EXCEPTION 'Roles hrms_app and hrms_system must exist. Run infrastructure/docker/postgres/00-roles.sh first.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

GRANT USAGE ON SCHEMA public TO hrms_app, hrms_system;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO hrms_app, hrms_system;

-- ---------------------------------------------------------------------------
-- Enable RLS on every tenant-owned table, with one isolation policy each.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_domains','tenant_settings','branches','departments','employees',
    'users','roles','role_permissions','user_roles','tenant_invitations',
    'subscriptions','subscription_items','subscription_events','subscription_usage',
    'audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO hrms_app
                     USING (tenant_id = current_tenant_id())
                     WITH CHECK (tenant_id = current_tenant_id())$p$, t);
  END LOOP;
END $$;

-- tenants: the app role may read only its own tenant row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants FOR SELECT TO hrms_app USING (id = current_tenant_id());

-- FORCE RLS also applies to the owner; give the owner (migrations / maintenance)
-- an explicit pass-through so data migrations keep working.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants','tenant_domains','tenant_settings','branches','departments','employees',
    'users','roles','role_permissions','user_roles','tenant_invitations',
    'subscriptions','subscription_items','subscription_events','subscription_usage',
    'audit_logs']
  LOOP
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Grants: hrms_app (least privilege)
-- ---------------------------------------------------------------------------
-- Global catalogues: read-only
GRANT SELECT ON permissions, feature_catalog, plans, plan_prices, plan_entitlements TO hrms_app;

-- Own tenant metadata: read-only (changes go through platform/billing services)
GRANT SELECT ON tenants, tenant_domains, subscriptions, subscription_items, subscription_events TO hrms_app;

-- Tenant-managed data
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant_settings, branches, departments, employees, users, roles,
  role_permissions, user_roles, tenant_invitations
TO hrms_app;
GRANT SELECT, INSERT, UPDATE ON subscription_usage TO hrms_app;

-- Audit log is append-only for the app
GRANT SELECT, INSERT ON audit_logs TO hrms_app;

-- No access at all: platform_*, auth_sessions (system role only)

-- ---------------------------------------------------------------------------
-- Grants: hrms_system (BYPASSRLS; platform + auth + schedulers)
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hrms_system;
REVOKE UPDATE, DELETE ON audit_logs FROM hrms_system;   -- append-only even for platform
GRANT SELECT, INSERT ON audit_logs TO hrms_system;
