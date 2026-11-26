-- Biometric attendance devices (ZKTeco and compatible terminals using the ADMS / "Cloud Server" push protocol).
-- Devices push punches to /iclock/*; each device is registered to one company by its serial number.
-- Only punch events (device user ID + time) are stored. Fingerprint and face templates never leave the device.

INSERT INTO feature_catalog (key, name, category, is_core, sort_order)
VALUES ('biometric', 'Biometric Device Integration', 'Time', false, 3)
ON CONFLICT (key) DO NOTHING;
INSERT INTO plan_entitlements (plan_id, feature_id, enabled)
SELECT p.id, f.id, true FROM plans p CROSS JOIN feature_catalog f
 WHERE f.key = 'biometric' AND p.code IN ('PROFESSIONAL', 'BUSINESS', 'ENTERPRISE')
ON CONFLICT (plan_id, feature_id) DO NOTHING;

-- The ID an employee is enrolled under on the company's devices (same ID on every device).
ALTER TABLE employees ADD COLUMN biometric_id text CHECK (biometric_id ~ '^[A-Za-z0-9]{1,24}$');
CREATE UNIQUE INDEX employees_biometric_id_uq ON employees(tenant_id, biometric_id) WHERE biometric_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE attendance_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id       uuid,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  serial_number   text NOT NULL CHECK (serial_number ~ '^[A-Za-z0-9_-]{4,64}$'),
  vendor          text NOT NULL DEFAULT 'ZKTECO',
  model           text,
  location        text,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  allowed_ips     text[] NOT NULL DEFAULT '{}',   -- empty = any address
  last_seen_at    timestamptz,
  last_ip         text,
  firmware        text,
  device_info     jsonb NOT NULL DEFAULT '{}',
  last_punch_at   timestamptz,
  punch_count     bigint NOT NULL DEFAULT 0,
  last_error      text,
  last_error_at   timestamptz,
  offline_alerted_at timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
-- A serial number belongs to exactly one company, platform-wide.
CREATE UNIQUE INDEX attendance_devices_serial_uq ON attendance_devices(upper(serial_number)) WHERE deleted_at IS NULL;

-- Raw punches as received (append-only). Re-sent records are de-duplicated.
CREATE TABLE device_punches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL,
  device_user_id text NOT NULL,
  punched_at    timestamptz NOT NULL,
  status_code   int,
  verify_mode   int,
  employee_id   uuid,
  result        text NOT NULL CHECK (result IN ('APPLIED','UNMAPPED','IGNORED','ERROR')),
  message       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, device_id) REFERENCES attendance_devices(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, device_id, device_user_id, punched_at)
);
CREATE INDEX device_punches_time_idx ON device_punches(tenant_id, punched_at DESC);
CREATE INDEX device_punches_unmapped_idx ON device_punches(tenant_id, device_user_id) WHERE result = 'UNMAPPED';

-- Communication and sync events per device, for troubleshooting.
CREATE TABLE device_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL,
  level       text NOT NULL CHECK (level IN ('INFO','WARN','ERROR')),
  event       text NOT NULL,
  message     text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, device_id) REFERENCES attendance_devices(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX device_logs_device_idx ON device_logs(tenant_id, device_id, created_at DESC);

CREATE TRIGGER attendance_devices_updated_at BEFORE UPDATE ON attendance_devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_devices','device_punches','device_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO hrms_app
                     USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hrms_system', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON attendance_devices TO hrms_app;
GRANT SELECT ON device_punches, device_logs TO hrms_app;
-- Punch history is evidence: the app may read it; only the device endpoint (system role) and retention job write/delete.

-- Lets a company check whether a serial number is free platform-wide without seeing other companies' devices.
CREATE FUNCTION serial_taken(sn text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT EXISTS (SELECT 1 FROM attendance_devices WHERE upper(serial_number) = upper(sn) AND deleted_at IS NULL) $$;
REVOKE ALL ON FUNCTION serial_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION serial_taken(text) TO hrms_app;
