-- ============================================================================
-- 006 Payroll: versioned statutory rules, salary components & structures,
--     payroll runs (maker-checker), items/payslips, adjustments
-- ============================================================================

-- Platform-maintained statutory rules (tax slabs, SSF/PF rates, deduction limits), versioned by fiscal year.
CREATE TABLE tax_rule_sets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country      char(2) NOT NULL DEFAULT 'NP',
  fiscal_year  text NOT NULL,                       -- '2083/84'
  effective_from date NOT NULL,
  effective_to   date NOT NULL,
  rules        jsonb NOT NULL,
  source_note  text,                               -- citation of the Finance Act / circular
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country, fiscal_year),
  CHECK (effective_to > effective_from)
);

CREATE TABLE salary_components (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,20}$'),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('EARNING','DEDUCTION')),
  taxable     boolean NOT NULL DEFAULT true,
  prorated    boolean NOT NULL DEFAULT true,     -- reduced for unpaid days
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- Salary is versioned: a revision inserts a new row with a later effective date. Rows are never updated.
CREATE TABLE employee_salaries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL,
  effective_from date NOT NULL,
  basic          numeric(14,2) NOT NULL CHECK (basic >= 0),
  components     jsonb NOT NULL DEFAULT '[]',     -- [{ code, amount }]
  ssf_enrolled   boolean NOT NULL DEFAULT true,
  pf_percent     numeric(5,2) NOT NULL DEFAULT 0 CHECK (pf_percent BETWEEN 0 AND 20),
  cit_monthly    numeric(14,2) NOT NULL DEFAULT 0 CHECK (cit_monthly >= 0),
  tax_profile    jsonb NOT NULL DEFAULT '{}',     -- { lifeInsurance, healthInsurance, femaleRebate }
  reason         text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  UNIQUE (tenant_id, employee_id, effective_from)
);

CREATE TABLE payroll_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period        text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),     -- BS year-month, e.g. 2083-08 (Mangsir)
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  fiscal_year   text NOT NULL,
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CALCULATED','SUBMITTED','APPROVED','PAID','VOID')),
  rule_set_id   uuid REFERENCES tax_rule_sets(id),
  totals        jsonb NOT NULL DEFAULT '{}',
  anomalies     int NOT NULL DEFAULT 0,
  created_by    uuid NOT NULL,
  calculated_at timestamptz,
  submitted_by  uuid,
  submitted_at  timestamptz,
  approved_by   uuid,
  approved_at   timestamptz,
  published_at  timestamptz,
  paid_at       timestamptz,
  payment_ref   text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (period_end >= period_start),
  CHECK (approved_by IS NULL OR approved_by <> submitted_by)          -- maker ≠ checker
);
CREATE UNIQUE INDEX payroll_runs_one_per_period ON payroll_runs(tenant_id, period) WHERE status <> 'VOID';

CREATE TABLE payroll_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL,
  employee_id   uuid NOT NULL,
  lines         jsonb NOT NULL,                  -- [{ code, name, kind, amount, taxable }]
  attendance    jsonb NOT NULL,                  -- payable-day inputs used
  tax_detail    jsonb NOT NULL,                  -- full working of the tax calculation (auditable)
  snapshot      jsonb NOT NULL,                  -- salary row + employee bank/PAN at calculation time
  gross         numeric(14,2) NOT NULL,
  deductions    numeric(14,2) NOT NULL,
  tax           numeric(14,2) NOT NULL,
  ssf_employee  numeric(14,2) NOT NULL DEFAULT 0,
  ssf_employer  numeric(14,2) NOT NULL DEFAULT 0,
  net           numeric(14,2) NOT NULL,
  anomalies     jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, employee_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);

CREATE TABLE payroll_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  period       text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  kind         text NOT NULL CHECK (kind IN ('EARNING','DEDUCTION')),
  description  text NOT NULL,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  taxable      boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX payroll_adjustments_idx ON payroll_adjustments(tenant_id, period);

-- ---------------------------------------------------------------- guards
-- Approved/paid payroll is immutable: items cannot change once the run is approved.
CREATE OR REPLACE FUNCTION payroll_items_locked() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM payroll_runs WHERE id = COALESCE(OLD.run_id, NEW.run_id);
  IF st IN ('APPROVED','PAID') THEN
    RAISE EXCEPTION 'Payroll run is % and cannot be modified; use an adjustment in a later period', st;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_items_lock BEFORE INSERT OR UPDATE OR DELETE ON payroll_items FOR EACH ROW EXECUTE FUNCTION payroll_items_locked();

CREATE OR REPLACE FUNCTION payroll_runs_transitions() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('APPROVED','PAID') AND NEW.status NOT IN ('APPROVED','PAID') THEN
    RAISE EXCEPTION 'An approved payroll run cannot be reopened';
  END IF;
  IF OLD.status = 'PAID' AND (NEW.totals IS DISTINCT FROM OLD.totals) THEN
    RAISE EXCEPTION 'A paid payroll run cannot be changed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_runs_guard BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION payroll_runs_transitions();
CREATE TRIGGER payroll_runs_updated_at BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['salary_components','employee_salaries','payroll_runs','payroll_items','payroll_adjustments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO hrms_app
                     USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hrms_app, hrms_system', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON employee_salaries FROM hrms_app, hrms_system;   -- history is append-only
GRANT SELECT ON tax_rule_sets TO hrms_app;
GRANT SELECT, INSERT, UPDATE ON tax_rule_sets TO hrms_system;

-- ---------------------------------------------------------------- statutory defaults
-- Sources: Finance Act 2082 (FY 2082/83) and Finance Act 2083 (FY 2083/84, budget of 29 May 2026).
-- Lishnu Tech must re-verify each year; Super Admin can add new versions without code changes.
INSERT INTO tax_rule_sets (fiscal_year, effective_from, effective_to, source_note, rules) VALUES
('2082/83', '2025-07-17', '2026-07-16', 'Finance Act 2082: separate single/married schedules, top rate 39%.',
 '{"slabs":{"SINGLE":[{"upTo":500000,"rate":1,"sst":true},{"upTo":700000,"rate":10},{"upTo":1000000,"rate":20},{"upTo":2000000,"rate":30},{"upTo":5000000,"rate":36},{"upTo":null,"rate":39}],
              "MARRIED":[{"upTo":600000,"rate":1,"sst":true},{"upTo":800000,"rate":10},{"upTo":1100000,"rate":20},{"upTo":2000000,"rate":30},{"upTo":5000000,"rate":36},{"upTo":null,"rate":39}]},
   "sstWaivedForSsf":true,"femaleRebatePercent":10,"retirementDeduction":{"maxAmount":500000,"maxFraction":0.3333},
   "ssf":{"employeePercent":11,"employerPercent":20},"insurance":{"lifeMax":40000,"healthMax":20000},"overtimeMultiplier":1.5}'),
('2083/84', '2026-07-17', '2027-07-16', 'Finance Act 2083: unified schedule for individuals and couples, 1% band to Rs 10 lakh, top rate 29%.',
 '{"slabs":{"SINGLE":[{"upTo":1000000,"rate":1,"sst":true},{"upTo":1500000,"rate":10},{"upTo":2500000,"rate":20},{"upTo":4000000,"rate":27},{"upTo":null,"rate":29}],
              "MARRIED":[{"upTo":1000000,"rate":1,"sst":true},{"upTo":1500000,"rate":10},{"upTo":2500000,"rate":20},{"upTo":4000000,"rate":27},{"upTo":null,"rate":29}]},
   "sstWaivedForSsf":true,"femaleRebatePercent":10,"retirementDeduction":{"maxAmount":500000,"maxFraction":0.3333},
   "ssf":{"employeePercent":11,"employerPercent":20},"insurance":{"lifeMax":40000,"healthMax":20000},"overtimeMultiplier":1.5}');
