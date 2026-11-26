-- ============================================================================
-- 004 Commercial engine: platform settings, CRM, CMS, billing, payments, support
-- ============================================================================

CREATE TABLE platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- CRM
CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL CHECK (source IN ('CONTACT','DEMO','ENTERPRISE_QUOTE','CALLBACK','SIGNUP','MANUAL','REFERRAL')),
  status          text NOT NULL DEFAULT 'NEW'
                  CHECK (status IN ('NEW','CONTACTED','QUALIFIED','DEMO_SCHEDULED','PROPOSAL','WON','LOST')),
  name            text NOT NULL,
  company         text,
  email           citext NOT NULL,
  phone           text,
  industry        text,
  employee_count  int CHECK (employee_count IS NULL OR employee_count >= 0),
  branch_count    int CHECK (branch_count IS NULL OR branch_count >= 0),
  modules         text[] NOT NULL DEFAULT '{}',
  interested_plan text,
  message         text,
  preferred_at    timestamptz,             -- demo/callback slot requested by visitor
  demo_at         timestamptz,             -- confirmed by sales
  follow_up_at    timestamptz,
  assigned_to     uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  estimated_value numeric(14,2),
  lost_reason     text,
  converted_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  utm             jsonb NOT NULL DEFAULT '{}',
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'LOST' OR lost_reason IS NOT NULL)
);
CREATE INDEX leads_status_idx ON leads(status, created_at DESC);
CREATE INDEX leads_assigned_idx ON leads(assigned_to, follow_up_at);
CREATE INDEX leads_email_idx ON leads(email);

CREATE TABLE lead_activities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('NOTE','CALL','EMAIL','MEETING','STATUS_CHANGE','QUOTE','SYSTEM')),
  body       text NOT NULL,
  meta       jsonb NOT NULL DEFAULT '{}',
  actor_id   uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_activities_lead_idx ON lead_activities(lead_id, created_at DESC);

CREATE TABLE newsletter_subscribers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  unsubscribed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- CMS
-- One flexible table for marketing content managed by the Super Admin.
CREATE TABLE cms_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('PAGE','BLOG_POST','TESTIMONIAL','FAQ','CUSTOMER_LOGO','ANNOUNCEMENT','FEATURE','INDUSTRY','CHANGELOG','SETTING')),
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  locale      text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ne')),
  title       text NOT NULL,
  summary     text,
  body        text,                         -- markdown (rendered safely on the client)
  data        jsonb NOT NULL DEFAULT '{}',   -- type-specific structured fields
  seo         jsonb NOT NULL DEFAULT '{}',   -- { title, description, image }
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  publish_at  timestamptz,                   -- scheduled publication
  sort_order  int NOT NULL DEFAULT 0,
  author_id   uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, slug, locale)
);
CREATE INDEX cms_public_idx ON cms_entries(type, locale, status, publish_at, sort_order);

-- ---------------------------------------------------------------- billing
CREATE TABLE coupons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            citext NOT NULL UNIQUE CHECK (code ~* '^[A-Z0-9_-]{3,30}$'),
  description     text,
  percent_off     numeric(5,2) CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off <= 100)),
  amount_off      numeric(14,2) CHECK (amount_off IS NULL OR amount_off > 0),
  plan_codes      text[] NOT NULL DEFAULT '{}',          -- empty = all plans
  billing_cycles  text[] NOT NULL DEFAULT '{}',
  valid_from      timestamptz,
  valid_until     timestamptz,
  max_redemptions int CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redemptions     int NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((percent_off IS NULL) <> (amount_off IS NULL))
);

CREATE SEQUENCE invoice_number_seq START 1001;

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subscription_id uuid,
  number          text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('DRAFT','OPEN','PAID','VOID','REFUNDED')),
  kind            text NOT NULL DEFAULT 'SUBSCRIPTION' CHECK (kind IN ('SUBSCRIPTION','UPGRADE','RENEWAL','ADDON','CREDIT_NOTE','MANUAL')),
  currency        char(3) NOT NULL DEFAULT 'NPR',
  subtotal        numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  discount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax_rate        numeric(5,2) NOT NULL DEFAULT 0,
  tax             numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total           numeric(14,2) NOT NULL CHECK (total >= 0),
  coupon_code     text,
  -- what the payment buys (applied atomically when paid)
  target_plan_id  uuid REFERENCES plans(id),
  target_cycle    text CHECK (target_cycle IS NULL OR target_cycle IN ('MONTHLY','ANNUAL')),
  period_start    timestamptz,
  period_end      timestamptz,
  bill_to         jsonb NOT NULL DEFAULT '{}',   -- snapshot: name, PAN, address, email
  issued_at       timestamptz NOT NULL DEFAULT now(),
  due_at          timestamptz NOT NULL,
  paid_at         timestamptz,
  voided_at       timestamptz,
  void_reason     text,
  related_invoice_id uuid REFERENCES invoices(id),   -- credit notes
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions(tenant_id, id),
  CHECK (total = subtotal - discount + tax)
);
CREATE INDEX invoices_tenant_idx ON invoices(tenant_id, issued_at DESC);
CREATE INDEX invoices_status_idx ON invoices(status, due_at);

CREATE TABLE invoice_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_id  uuid NOT NULL,
  description text NOT NULL,
  quantity    numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount numeric(14,2) NOT NULL,
  amount      numeric(14,2) NOT NULL,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_id    uuid NOT NULL,
  provider      text NOT NULL CHECK (provider IN ('ESEWA','KHALTI','BANK_TRANSFER','MANUAL')),
  status        text NOT NULL DEFAULT 'INITIATED'
                CHECK (status IN ('INITIATED','PENDING_VERIFICATION','SUCCEEDED','FAILED','CANCELLED','REFUNDED')),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  currency      char(3) NOT NULL DEFAULT 'NPR',
  reference     text NOT NULL UNIQUE,         -- our transaction uuid sent to the provider
  provider_ref  text,                          -- eSewa ref / Khalti pidx / bank reference
  provider_data jsonb NOT NULL DEFAULT '{}',   -- raw verification responses (audit)
  proof_note    text,                          -- bank transfer: payer-supplied details
  failure_reason text,
  verified_by   uuid REFERENCES platform_users(id),
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);
CREATE INDEX payments_status_idx ON payments(status, created_at DESC);
CREATE INDEX payments_invoice_idx ON payments(tenant_id, invoice_id);
CREATE UNIQUE INDEX payments_provider_ref_uniq ON payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- ---------------------------------------------------------------- support
CREATE TABLE support_tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  subject       text NOT NULL,
  category      text NOT NULL DEFAULT 'GENERAL' CHECK (category IN ('GENERAL','BILLING','TECHNICAL','FEATURE_REQUEST','BUG','ACCOUNT')),
  priority      text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_ON_CUSTOMER','RESOLVED','CLOSED')),
  created_by    uuid NOT NULL,
  assigned_to   uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  first_response_due_at timestamptz,
  first_responded_at    timestamptz,
  resolved_at   timestamptz,
  satisfaction  int CHECK (satisfaction BETWEEN 1 AND 5),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX support_tickets_status_idx ON support_tickets(status, priority, created_at);

CREATE TABLE support_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id   uuid NOT NULL,
  author_type text NOT NULL CHECK (author_type IN ('TENANT_USER','PLATFORM_USER')),
  author_id   uuid NOT NULL,
  body        text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,   -- staff-only note, never shown to tenant
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES support_tickets(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX support_messages_ticket_idx ON support_messages(tenant_id, ticket_id, created_at);

-- ---------------------------------------------------------------- triggers, RLS, grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','cms_entries','invoices','payments','support_tickets'] LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['invoices','invoice_items','payments','support_tickets','support_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO hrms_app
                     USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Internal staff notes are invisible to tenants even inside their own tickets.
DROP POLICY tenant_isolation ON support_messages;
CREATE POLICY tenant_isolation ON support_messages FOR ALL TO hrms_app
  USING (tenant_id = current_tenant_id() AND NOT is_internal)
  WITH CHECK (tenant_id = current_tenant_id() AND NOT is_internal AND author_type = 'TENANT_USER');

GRANT SELECT ON invoices, invoice_items, payments TO hrms_app;   -- money moves only via system role
GRANT SELECT, INSERT, UPDATE ON support_tickets TO hrms_app;
GRANT SELECT, INSERT ON support_messages TO hrms_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_settings, leads, lead_activities, newsletter_subscribers,
  cms_entries, coupons, invoices, invoice_items, payments, support_tickets, support_messages TO hrms_system;
GRANT USAGE, SELECT ON SEQUENCE invoice_number_seq TO hrms_system;
-- Financial records are never deleted: void/credit-note instead.
REVOKE DELETE ON invoices, invoice_items, payments FROM hrms_system;
