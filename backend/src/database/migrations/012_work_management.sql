-- Work management: projects, tasks with an activity trail, daily work reports and manager reviews.
-- Available on every plan ("tasks" is a core feature).

INSERT INTO feature_catalog (key, name, category, is_core, sort_order)
VALUES ('tasks', 'Tasks & Daily Work Reports', 'Core HR', true, 5)
ON CONFLICT (key) DO UPDATE SET is_core = true;

-- ------------------------------------------------------------------ projects (optional grouping of tasks)
CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  code          text CHECK (code ~ '^[A-Z0-9-]{2,12}$'),
  description   text,
  color         text NOT NULL DEFAULT '#2453d6' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ON_HOLD','COMPLETED','ARCHIVED')),
  lead_employee_id uuid,
  starts_on     date,
  ends_on       date,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_employee_id) REFERENCES employees(tenant_id, id)
);
CREATE UNIQUE INDEX projects_code_uq ON projects(tenant_id, code) WHERE code IS NOT NULL AND deleted_at IS NULL;

-- ------------------------------------------------------------------ tasks
CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number          int NOT NULL,                              -- per-company sequence, shown as T-42
  project_id      uuid,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  description     text,
  assignee_id     uuid NOT NULL,                             -- employee doing the work
  created_by      uuid NOT NULL,                             -- user who created / assigned it
  priority        text NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status          text NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','IN_PROGRESS','BLOCKED','IN_REVIEW','DONE','CANCELLED')),
  progress        int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  requires_review boolean NOT NULL DEFAULT false,            -- assignee submits for review; reviewer marks done
  start_on        date,
  due_on          date,
  estimate_hours  numeric(6,2) CHECK (estimate_hours >= 0),
  logged_hours    numeric(8,2) NOT NULL DEFAULT 0 CHECK (logged_hours >= 0),  -- from daily reports
  tags            text[] NOT NULL DEFAULT '{}',
  blocked_reason  text,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (due_on IS NULL OR start_on IS NULL OR due_on >= start_on),
  FOREIGN KEY (tenant_id, assignee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id)
);
CREATE INDEX tasks_assignee_idx ON tasks(tenant_id, assignee_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_due_idx ON tasks(tenant_id, due_on) WHERE deleted_at IS NULL AND status NOT IN ('DONE','CANCELLED');
CREATE INDEX tasks_project_idx ON tasks(tenant_id, project_id) WHERE deleted_at IS NULL;

-- Activity trail: comments plus every status / progress / assignment change.
CREATE TABLE task_activity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id       uuid NOT NULL,
  author_id     uuid,                                        -- user; null = system
  kind          text NOT NULL CHECK (kind IN ('CREATED','COMMENT','STATUS','PROGRESS','ASSIGNED','EDITED','REPORT')),
  body          text,
  from_value    jsonb,
  to_value      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX task_activity_task_idx ON task_activity(tenant_id, task_id, created_at);

-- ------------------------------------------------------------------ daily work reports
CREATE TABLE work_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL,
  report_date     date NOT NULL,
  summary         text,                                      -- what was completed
  challenges      text,                                      -- blockers / problems faced
  plan_next       text,                                      -- plan for the next working day
  hours           numeric(5,2) NOT NULL DEFAULT 0 CHECK (hours BETWEEN 0 AND 24),
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','CHANGES_REQUESTED','APPROVED')),
  submitted_at    timestamptz,
  reviewer_id     uuid,                                      -- user who reviewed
  reviewed_at     timestamptz,
  rating          int CHECK (rating BETWEEN 1 AND 5),
  feedback        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, report_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX work_reports_status_idx ON work_reports(tenant_id, status, report_date);

-- What was worked on: a task (progress after today's work) or free-form work.
CREATE TABLE work_report_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id     uuid NOT NULL,
  task_id       uuid,
  description   text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  hours         numeric(5,2) NOT NULL DEFAULT 0 CHECK (hours BETWEEN 0 AND 24),
  progress      int CHECK (progress BETWEEN 0 AND 100),
  completed     boolean NOT NULL DEFAULT false,
  sort_order    int NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, report_id) REFERENCES work_reports(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id)
);
CREATE INDEX work_report_items_report_idx ON work_report_items(tenant_id, report_id);

-- ------------------------------------------------------------------ row-level security
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['projects','tasks','task_activity','work_reports','work_report_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO hrms_app
                     USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, tbl);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', tbl);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON projects, tasks, task_activity, work_reports TO hrms_app, hrms_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_report_items TO hrms_app, hrms_system;   -- replaced on each save
