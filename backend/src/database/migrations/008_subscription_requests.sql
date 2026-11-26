-- Subscription requests reviewed by the Super Admin, and per-company feature switches.

-- A company asks for a plan (or Enterprise / extra modules). The Super Admin approves or rejects it.
CREATE TABLE subscription_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('PLAN_CHANGE','ENTERPRISE','FEATURES')),
  plan_id        uuid REFERENCES plans(id),
  billing_cycle  text CHECK (billing_cycle IN ('MONTHLY','ANNUAL')),
  employee_count int CHECK (employee_count > 0),
  features       text[] NOT NULL DEFAULT '{}',
  message        text CHECK (length(message) <= 2000),
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_by   uuid,
  decided_by     uuid REFERENCES platform_users(id),
  decided_at     timestamptz,
  decision_note  text,
  decision       jsonb NOT NULL DEFAULT '{}',   -- what was applied: plan, cycle, mode, amount, limits, features
  invoice_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id),
  CHECK (kind <> 'PLAN_CHANGE' OR plan_id IS NOT NULL),
  CHECK (kind <> 'FEATURES' OR cardinality(features) > 0),
  CHECK ((status = 'PENDING') = (decided_at IS NULL) OR status = 'CANCELLED')
);
-- One open request per company at a time.
CREATE UNIQUE INDEX subscription_requests_one_pending ON subscription_requests(tenant_id) WHERE status = 'PENDING';
CREATE INDEX subscription_requests_status_idx ON subscription_requests(status, created_at);
CREATE TRIGGER subscription_requests_updated_at BEFORE UPDATE ON subscription_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Super Admin switches individual features on (beyond the plan) or off (despite the plan) for one company.
CREATE TABLE tenant_feature_overrides (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES feature_catalog(key),
  enabled     boolean NOT NULL,
  reason      text,
  updated_by  uuid REFERENCES platform_users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription_requests','tenant_feature_overrides'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO hrms_app
                     USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hrms_system', t);
  END LOOP;
END $$;
-- Companies may read their requests; creating and deciding go through the system role (validated in code).
GRANT SELECT ON subscription_requests, tenant_feature_overrides TO hrms_app;
