-- Working calendars, attendance-rule support, salary advances/loans and typed payroll adjustments.

-- Branch default schedule (employee shift > branch default > company default shift > company policy).
ALTER TABLE branches ADD COLUMN default_shift_id uuid;
ALTER TABLE branches ADD FOREIGN KEY (tenant_id, default_shift_id) REFERENCES shifts(tenant_id, id);

-- Different hours on specific weekdays, e.g. {"FRI": {"start": "10:00", "end": "15:00", "breakMinutes": 0}}.
ALTER TABLE shifts ADD COLUMN day_hours jsonb NOT NULL DEFAULT '{}';

-- A calendar entry is either a holiday or a special working day (e.g. a Saturday made into a working day).
ALTER TABLE holidays ADD COLUMN kind text NOT NULL DEFAULT 'HOLIDAY' CHECK (kind IN ('HOLIDAY','WORKING_DAY'));

-- Salary advances and loans, recovered in monthly instalments through payroll.
CREATE TABLE employee_loans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id        uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('ADVANCE','LOAN')),
  title              text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  principal          numeric(14,2) NOT NULL CHECK (principal > 0),
  installment_amount numeric(14,2) NOT NULL CHECK (installment_amount > 0),
  start_period       text NOT NULL CHECK (start_period ~ '^\d{4}-\d{2}$'),   -- first BS payroll month of recovery
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED','CANCELLED')),
  note               text,
  created_by         uuid,
  closed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  CHECK (installment_amount <= principal)
);
CREATE INDEX employee_loans_emp_idx ON employee_loans(tenant_id, employee_id, status);
CREATE TRIGGER employee_loans_updated_at BEFORE UPDATE ON employee_loans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Typed one-off pay items: bonus, incentive, leave encashment, arrears, reimbursement, other.
ALTER TABLE payroll_adjustments ADD COLUMN code text NOT NULL DEFAULT 'OTHER'
  CHECK (code IN ('BONUS','INCENTIVE','LEAVE_ENCASHMENT','ARREARS','REIMBURSEMENT','FINE','OTHER'));

DO $$
BEGIN
  EXECUTE 'ALTER TABLE employee_loans ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE employee_loans FORCE ROW LEVEL SECURITY';
  EXECUTE $p$CREATE POLICY tenant_isolation ON employee_loans FOR ALL TO hrms_app
             USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$;
  EXECUTE 'CREATE POLICY owner_all ON employee_loans FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)';
END $$;
GRANT SELECT, INSERT, UPDATE ON employee_loans TO hrms_app, hrms_system;   -- never deleted: cancel instead
