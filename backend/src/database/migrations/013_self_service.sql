-- Employee self-service, stage 1: expense claims and HR letter requests.
-- Expense claims use the existing "expenses" feature (Professional plan and above).
-- Letter requests belong to Employee Self-Service ("ess"), a core feature on every plan.

-- Receipts are private files like employee documents.
ALTER TABLE files DROP CONSTRAINT files_owner_type_check;
ALTER TABLE files ADD CONSTRAINT files_owner_type_check
  CHECK (owner_type IN ('EMPLOYEE_DOCUMENT','EMPLOYEE_PHOTO','COMPANY_POLICY','LEAVE_ATTACHMENT','EXPENSE_RECEIPT','OTHER'));

-- ------------------------------------------------------------------ expense claims
-- Flow: SUBMITTED → (manager) MANAGER_APPROVED → (finance) APPROVED → SCHEDULED (added to a payroll month) → PAID
--       or APPROVED → PAID directly (cash / bank transfer). REJECTED and CANCELLED are final.
CREATE TABLE expense_claims (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number              int NOT NULL,                                  -- per-company sequence, shown as EXP-12
  employee_id         uuid NOT NULL,
  category            text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  title               text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
  expense_date        date NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  merchant            text CHECK (length(merchant) <= 120),
  description         text CHECK (length(description) <= 1000),
  receipt_file_id     uuid,
  status              text NOT NULL DEFAULT 'SUBMITTED'
                      CHECK (status IN ('SUBMITTED','MANAGER_APPROVED','APPROVED','REJECTED','CANCELLED','SCHEDULED','PAID')),
  manager_user_id     uuid,                                          -- expected first approver (null = goes straight to finance)
  manager_decided_by  uuid,
  manager_decided_at  timestamptz,
  manager_note        text,
  approved_by         uuid,
  approved_at         timestamptz,
  approved_amount     numeric(14,2) CHECK (approved_amount > 0),
  finance_note        text,
  rejected_by         uuid,
  rejected_at         timestamptz,
  reject_reason       text,
  payout_method       text CHECK (payout_method IN ('PAYROLL','DIRECT')),
  payroll_period      text CHECK (payroll_period ~ '^\d{4}-\d{2}$'),
  payroll_adjustment_id uuid,
  paid_at             timestamptz,
  payment_ref         text CHECK (length(payment_ref) <= 120),
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (approved_amount IS NULL OR approved_amount <= amount),
  CHECK (status <> 'SCHEDULED' OR (payout_method = 'PAYROLL' AND payroll_period IS NOT NULL)),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_file_id) REFERENCES files(tenant_id, id)
);
CREATE INDEX expense_claims_employee_idx ON expense_claims(tenant_id, employee_id, created_at DESC);
CREATE INDEX expense_claims_status_idx ON expense_claims(tenant_id, status, created_at DESC);
CREATE INDEX expense_claims_period_idx ON expense_claims(tenant_id, payroll_period) WHERE status = 'SCHEDULED';

-- ------------------------------------------------------------------ letter requests
CREATE TABLE letter_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number          int NOT NULL,
  employee_id     uuid NOT NULL,
  type            text NOT NULL CHECK (type IN ('EMPLOYMENT','SALARY','EXPERIENCE','BANK','NOC')),
  purpose         text NOT NULL CHECK (length(purpose) BETWEEN 3 AND 300),
  addressed_to    text CHECK (length(addressed_to) <= 300),
  details         text CHECK (length(details) <= 1000),             -- extra information from the employee
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ISSUED','REJECTED','CANCELLED')),
  requested_by    uuid NOT NULL,
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text,
  reference       text,                                             -- printed reference number, e.g. LTR/2083/0007
  verify_code     text UNIQUE CHECK (verify_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  content         jsonb,                                            -- frozen data the PDF is rendered from
  issued_at       timestamptz,
  revoked_at      timestamptz,
  revoke_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (status <> 'ISSUED' OR (reference IS NOT NULL AND verify_code IS NOT NULL AND content IS NOT NULL)),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX letter_requests_employee_idx ON letter_requests(tenant_id, employee_id, created_at DESC);
CREATE INDEX letter_requests_status_idx ON letter_requests(tenant_id, status, created_at DESC);

-- ------------------------------------------------------------------ row-level security
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['expense_claims','letter_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO hrms_app
                     USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, tbl);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', tbl);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON expense_claims, letter_requests TO hrms_app, hrms_system;
