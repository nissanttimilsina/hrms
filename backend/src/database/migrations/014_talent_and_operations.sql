-- Roadmap modules: assets, onboarding & offboarding, recruitment, HR helpdesk, training, goals & appraisals,
-- engagement (surveys and recognition), workforce planning and custom request workflows.
-- Each module is gated by its feature key (feature_catalog) through the permission's module.

ALTER TABLE files DROP CONSTRAINT files_owner_type_check;
ALTER TABLE files ADD CONSTRAINT files_owner_type_check
  CHECK (owner_type IN ('EMPLOYEE_DOCUMENT','EMPLOYEE_PHOTO','COMPANY_POLICY','LEAVE_ATTACHMENT','EXPENSE_RECEIPT',
                        'CANDIDATE_CV','HELPDESK_ATTACHMENT','TRAINING_CERTIFICATE','OTHER'));

-- ================================================================== assets
CREATE TABLE assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number               int NOT NULL,                                     -- shown as AST-12
  name                 text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  category             text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  asset_tag            text CHECK (length(asset_tag) <= 60),
  serial_no            text CHECK (length(serial_no) <= 80),
  brand_model          text CHECK (length(brand_model) <= 120),
  branch_id            uuid,
  purchase_date        date,
  purchase_cost        numeric(14,2) CHECK (purchase_cost >= 0),
  vendor               text CHECK (length(vendor) <= 120),
  warranty_until       date,
  condition            text NOT NULL DEFAULT 'GOOD' CHECK (condition IN ('NEW','GOOD','FAIR','POOR','DAMAGED')),
  status               text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','ASSIGNED','IN_REPAIR','RETIRED','LOST')),
  assigned_employee_id uuid,
  assigned_at          timestamptz,
  due_back_on          date,
  notes                text CHECK (length(notes) <= 1000),
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK ((status = 'ASSIGNED') = (assigned_employee_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, assigned_employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE UNIQUE INDEX assets_tag_uq ON assets(tenant_id, lower(asset_tag)) WHERE asset_tag IS NOT NULL;
CREATE INDEX assets_holder_idx ON assets(tenant_id, assigned_employee_id) WHERE assigned_employee_id IS NOT NULL;

-- Append-only history: created, assigned, returned, repair, retired, lost, issue reported, notes.
CREATE TABLE asset_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id     uuid NOT NULL,
  type         text NOT NULL CHECK (type IN ('CREATED','UPDATED','ASSIGNED','RETURNED','IN_REPAIR','AVAILABLE','RETIRED','LOST','ISSUE','NOTE')),
  employee_id  uuid,
  condition    text CHECK (condition IN ('NEW','GOOD','FAIR','POOR','DAMAGED')),
  note         text CHECK (length(note) <= 1000),
  author_id    uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX asset_events_asset_idx ON asset_events(tenant_id, asset_id, created_at);
CREATE INDEX asset_events_employee_idx ON asset_events(tenant_id, employee_id, created_at) WHERE employee_id IS NOT NULL;

-- ================================================================== onboarding & offboarding
CREATE TABLE checklist_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('ONBOARDING','OFFBOARDING')),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description text CHECK (length(description) <= 500),
  items       jsonb NOT NULL DEFAULT '[]',     -- [{title, description, owner: HR|MANAGER|EMPLOYEE|IT|FINANCE, dueDays}]
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE journeys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number             int NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('ONBOARDING','OFFBOARDING')),
  employee_id        uuid NOT NULL,
  template_id        uuid,
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','CANCELLED')),
  start_date         date NOT NULL,                 -- joining date, or the day notice was given
  -- offboarding
  exit_type          text CHECK (exit_type IN ('RESIGNATION','TERMINATION','RETIREMENT','CONTRACT_END','OTHER')),
  notice_date        date,
  last_working_day   date,
  exit_reason        text CHECK (length(exit_reason) <= 1000),
  rehire_eligible    boolean,
  exit_interview     jsonb,                          -- {reason, ratings{}, recommend, liked, improve, submittedAt}
  terminate_employee boolean NOT NULL DEFAULT true,  -- mark the employee as exited when the journey completes
  completed_at       timestamptz,
  completed_by       uuid,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (kind = 'ONBOARDING' OR (exit_type IS NOT NULL AND last_working_day IS NOT NULL)),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES checklist_templates(tenant_id, id)
);
CREATE UNIQUE INDEX journeys_one_open_uq ON journeys(tenant_id, employee_id, kind) WHERE status = 'OPEN';

CREATE TABLE journey_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  journey_id   uuid NOT NULL,
  sort         int NOT NULL DEFAULT 0,
  title        text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  description  text CHECK (length(description) <= 1000),
  owner        text NOT NULL CHECK (owner IN ('HR','MANAGER','EMPLOYEE','IT','FINANCE')),
  due_date     date,
  done_at      timestamptz,
  done_by      uuid,
  note         text CHECK (length(note) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, journey_id) REFERENCES journeys(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX journey_tasks_journey_idx ON journey_tasks(tenant_id, journey_id, sort);

-- ================================================================== recruitment
CREATE TABLE job_openings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number               int NOT NULL,
  slug                 text NOT NULL CHECK (slug ~ '^[a-z0-9-]{3,90}$'),
  title                text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  department_id        uuid,
  branch_id            uuid,
  designation_id       uuid,
  employment_type      text NOT NULL DEFAULT 'PERMANENT',
  location             text CHECK (length(location) <= 120),
  positions            int NOT NULL DEFAULT 1 CHECK (positions BETWEEN 1 AND 500),
  description          text NOT NULL CHECK (length(description) BETWEEN 20 AND 8000),
  requirements         text CHECK (length(requirements) <= 4000),
  salary_min           numeric(14,2) CHECK (salary_min >= 0),
  salary_max           numeric(14,2) CHECK (salary_max >= 0),
  show_salary          boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','OPEN','ON_HOLD','CLOSED','FILLED')),
  published            boolean NOT NULL DEFAULT false,                  -- listed on the public careers page while OPEN
  closes_on            date,
  hiring_manager_id    uuid,                                            -- employee
  created_by           uuid NOT NULL,
  opened_at            timestamptz,
  closed_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, slug),
  CHECK (salary_max IS NULL OR salary_min IS NULL OR salary_max >= salary_min),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, designation_id) REFERENCES designations(tenant_id, id),
  FOREIGN KEY (tenant_id, hiring_manager_id) REFERENCES employees(tenant_id, id)
);

CREATE TABLE candidates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number           int NOT NULL,
  job_id           uuid NOT NULL,
  first_name       text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 80),
  last_name        text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 80),
  email            text NOT NULL CHECK (length(email) <= 254),
  phone            text CHECK (length(phone) <= 30),
  current_title    text CHECK (length(current_title) <= 120),
  experience_years numeric(4,1) CHECK (experience_years BETWEEN 0 AND 60),
  expected_salary  numeric(14,2) CHECK (expected_salary >= 0),
  notice_days      int CHECK (notice_days BETWEEN 0 AND 365),
  source           text NOT NULL DEFAULT 'CAREERS' CHECK (source IN ('CAREERS','REFERRAL','JOB_PORTAL','SOCIAL','WALK_IN','AGENCY','OTHER')),
  referred_by      uuid,                                                -- employee
  cover_note       text CHECK (length(cover_note) <= 3000),
  cv_file_id       uuid,
  stage            text NOT NULL DEFAULT 'APPLIED' CHECK (stage IN ('APPLIED','SCREENING','INTERVIEW','OFFER','HIRED','REJECTED','WITHDRAWN')),
  rating           int CHECK (rating BETWEEN 1 AND 5),
  offer            jsonb,                                               -- {salary, joiningDate, designation, expiresOn, sentAt, acceptedAt, declinedAt}
  reject_reason    text CHECK (length(reject_reason) <= 500),
  employee_id      uuid,                                                -- set when hired
  consent_at       timestamptz,                                         -- applicant agreed to the use of their data
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, job_id) REFERENCES job_openings(tenant_id, id),
  FOREIGN KEY (tenant_id, cv_file_id) REFERENCES files(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, referred_by) REFERENCES employees(tenant_id, id)
);
CREATE UNIQUE INDEX candidates_job_email_uq ON candidates(tenant_id, job_id, lower(email)) WHERE stage NOT IN ('REJECTED','WITHDRAWN');
CREATE INDEX candidates_job_idx ON candidates(tenant_id, job_id, stage);

CREATE TABLE candidate_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  candidate_id  uuid NOT NULL,
  type          text NOT NULL CHECK (type IN ('APPLIED','STAGE','NOTE','INTERVIEW','FEEDBACK','OFFER','HIRED','EMAIL')),
  data          jsonb NOT NULL DEFAULT '{}',
  author_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX candidate_events_idx ON candidate_events(tenant_id, candidate_id, created_at);

CREATE TABLE interviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  candidate_id     uuid NOT NULL,
  round            text NOT NULL CHECK (length(round) BETWEEN 2 AND 80),
  scheduled_at     timestamptz NOT NULL,
  duration_minutes int NOT NULL DEFAULT 45 CHECK (duration_minutes BETWEEN 10 AND 480),
  mode             text NOT NULL DEFAULT 'IN_PERSON' CHECK (mode IN ('IN_PERSON','PHONE','VIDEO')),
  location         text CHECK (length(location) <= 300),                 -- address or meeting link
  interviewer_ids  uuid[] NOT NULL DEFAULT '{}',                         -- users
  status           text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','DONE','CANCELLED')),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX interviews_when_idx ON interviews(tenant_id, scheduled_at);

CREATE TABLE interview_feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interview_id   uuid NOT NULL,
  author_id      uuid NOT NULL,
  rating         int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  recommendation text NOT NULL CHECK (recommendation IN ('STRONG_YES','YES','NO','STRONG_NO')),
  scores         jsonb NOT NULL DEFAULT '{}',                           -- {skills: 4, communication: 3, ...}
  notes          text CHECK (length(notes) <= 3000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interview_id, author_id),
  FOREIGN KEY (tenant_id, interview_id) REFERENCES interviews(tenant_id, id) ON DELETE CASCADE
);

-- ================================================================== HR helpdesk
CREATE TABLE hr_tickets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number             int NOT NULL,
  employee_id        uuid NOT NULL,
  requester_id       uuid NOT NULL,                                     -- user
  category           text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  subject            text NOT NULL CHECK (length(subject) BETWEEN 3 AND 160),
  priority           text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','WAITING','RESOLVED','CLOSED')),
  confidential       boolean NOT NULL DEFAULT false,
  assignee_id        uuid,                                              -- user
  due_at             timestamptz,                                       -- target resolution time from the category
  first_response_at  timestamptz,
  resolved_at        timestamptz,
  closed_at          timestamptz,
  satisfaction       int CHECK (satisfaction BETWEEN 1 AND 5),
  satisfaction_note  text CHECK (length(satisfaction_note) <= 500),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX hr_tickets_status_idx ON hr_tickets(tenant_id, status, created_at DESC);
CREATE INDEX hr_tickets_employee_idx ON hr_tickets(tenant_id, employee_id, created_at DESC);

CREATE TABLE hr_ticket_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id          uuid NOT NULL,
  author_id          uuid NOT NULL,
  body               text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  internal           boolean NOT NULL DEFAULT false,                    -- HR-only note, never shown to the employee
  attachment_file_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES hr_tickets(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, attachment_file_id) REFERENCES files(tenant_id, id)
);
CREATE INDEX hr_ticket_messages_idx ON hr_ticket_messages(tenant_id, ticket_id, created_at);

-- ================================================================== training
CREATE TABLE training_courses (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title                    text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
  category                 text NOT NULL DEFAULT 'General' CHECK (length(category) BETWEEN 1 AND 60),
  description              text CHECK (length(description) <= 4000),
  delivery                 text NOT NULL DEFAULT 'IN_PERSON' CHECK (delivery IN ('IN_PERSON','ONLINE','EXTERNAL','ON_THE_JOB')),
  provider                 text CHECK (length(provider) <= 120),
  duration_hours           numeric(6,1) CHECK (duration_hours > 0),
  cost_per_person          numeric(14,2) CHECK (cost_per_person >= 0),
  certificate_valid_months int CHECK (certificate_valid_months BETWEEN 1 AND 120),
  mandatory                boolean NOT NULL DEFAULT false,
  self_enroll              boolean NOT NULL DEFAULT true,                -- employees may request it
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE training_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  course_id   uuid NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  location    text CHECK (length(location) <= 300),
  trainer     text CHECK (length(trainer) <= 120),
  capacity    int CHECK (capacity BETWEEN 1 AND 1000),
  status      text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','COMPLETED','CANCELLED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, course_id) REFERENCES training_courses(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX training_sessions_idx ON training_sessions(tenant_id, starts_at);

CREATE TABLE training_enrollments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  course_id              uuid NOT NULL,
  session_id             uuid,
  employee_id            uuid NOT NULL,
  status                 text NOT NULL DEFAULT 'ENROLLED'
                         CHECK (status IN ('REQUESTED','ENROLLED','COMPLETED','NO_SHOW','CANCELLED','REJECTED')),
  requested_by           uuid NOT NULL,
  request_note           text CHECK (length(request_note) <= 500),
  decided_by             uuid,
  decision_note          text CHECK (length(decision_note) <= 500),
  completed_on           date,
  score                  numeric(5,1) CHECK (score BETWEEN 0 AND 100),
  certificate_expires_on date,
  certificate_file_id    uuid,
  feedback_rating        int CHECK (feedback_rating BETWEEN 1 AND 5),
  feedback_comment       text CHECK (length(feedback_comment) <= 1000),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES training_courses(tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, certificate_file_id) REFERENCES files(tenant_id, id)
);
CREATE UNIQUE INDEX training_enrollments_active_uq ON training_enrollments(tenant_id, course_id, employee_id)
  WHERE status IN ('REQUESTED','ENROLLED');
CREATE INDEX training_enrollments_employee_idx ON training_enrollments(tenant_id, employee_id, created_at DESC);

-- ================================================================== goals & appraisals
CREATE TABLE appraisal_cycles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(name) BETWEEN 3 AND 120),
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  self_review_due     date,
  manager_review_due  date,
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','CLOSED')),
  competencies        jsonb NOT NULL DEFAULT '[]',                     -- [{key, name, description}]
  goal_weight         int NOT NULL DEFAULT 60 CHECK (goal_weight BETWEEN 0 AND 100),   -- % of the overall rating from goals
  peer_feedback       boolean NOT NULL DEFAULT true,
  created_by          uuid NOT NULL,
  launched_at         timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (period_end >= period_start)
);

CREATE TABLE goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  cycle_id     uuid,
  title        text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description  text CHECK (length(description) <= 2000),
  measure      text CHECK (length(measure) <= 200),                     -- how success is measured, e.g. "Monthly sales (NPR)"
  target       text CHECK (length(target) <= 120),
  actual       text CHECK (length(actual) <= 120),
  weight       int NOT NULL DEFAULT 0 CHECK (weight BETWEEN 0 AND 100),
  progress     int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  due_date     date,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ACHIEVED','PARTLY_ACHIEVED','MISSED','DROPPED')),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES appraisal_cycles(tenant_id, id)
);
CREATE INDEX goals_employee_idx ON goals(tenant_id, employee_id, created_at DESC);

CREATE TABLE appraisals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cycle_id            uuid NOT NULL,
  employee_id         uuid NOT NULL,
  reviewer_id         uuid,                                            -- employee who reviews (the manager at launch)
  status              text NOT NULL DEFAULT 'SELF_REVIEW'
                      CHECK (status IN ('SELF_REVIEW','MANAGER_REVIEW','HR_REVIEW','COMPLETED','ACKNOWLEDGED')),
  self_review         jsonb,                                           -- {goals:{id:{rating,comment}}, competencies:{key:{rating,comment}}, summary}
  manager_review      jsonb,                                           -- same + {strengths, improvements, recommendation}
  goal_score          numeric(3,2),
  competency_score    numeric(3,2),
  calculated_rating   numeric(3,2),
  final_rating        numeric(3,2),
  calibration_note    text CHECK (length(calibration_note) <= 1000),
  recommendation      text CHECK (recommendation IN ('NONE','INCREMENT','PROMOTION','PIP','TRAINING','EXTEND_PROBATION','CONFIRM')),
  work_score          int,                                             -- day-to-day performance score (tasks, reports) at review time
  self_submitted_at   timestamptz,
  manager_submitted_at timestamptz,
  finalized_at        timestamptz,
  finalized_by        uuid,
  acknowledged_at     timestamptz,
  employee_comment    text CHECK (length(employee_comment) <= 2000),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (cycle_id, employee_id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES appraisal_cycles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX appraisals_employee_idx ON appraisals(tenant_id, employee_id);

-- 360° input: the reviewer asks colleagues for feedback.
CREATE TABLE appraisal_feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appraisal_id   uuid NOT NULL,
  from_employee_id uuid NOT NULL,
  requested_by   uuid NOT NULL,
  rating         int CHECK (rating BETWEEN 1 AND 5),
  strengths      text CHECK (length(strengths) <= 2000),
  improvements   text CHECK (length(improvements) <= 2000),
  submitted_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appraisal_id, from_employee_id),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES appraisals(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, from_employee_id) REFERENCES employees(tenant_id, id)
);

-- ================================================================== engagement
CREATE TABLE surveys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
  description  text CHECK (length(description) <= 1000),
  anonymous    boolean NOT NULL DEFAULT true,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','OPEN','CLOSED')),
  closes_on    date,
  audience     jsonb NOT NULL DEFAULT '{}',                            -- {departmentIds?: [], branchIds?: []}; empty = everyone
  questions    jsonb NOT NULL DEFAULT '[]',                            -- [{id, type: RATING|ENPS|CHOICE|TEXT, text, options?, required}]
  min_group    int NOT NULL DEFAULT 3 CHECK (min_group BETWEEN 1 AND 20),
  created_by   uuid NOT NULL,
  opened_at    timestamptz,
  closed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Who was asked and whether they answered; kept apart from the answers so anonymous answers stay anonymous.
CREATE TABLE survey_participants (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  survey_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  responded    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (survey_id, employee_id),
  FOREIGN KEY (tenant_id, survey_id) REFERENCES surveys(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);

CREATE TABLE survey_responses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  survey_id      uuid NOT NULL,
  employee_id    uuid,                                                -- null when the survey is anonymous
  department_id  uuid,                                                -- for group results (only shown above min_group)
  answers        jsonb NOT NULL,
  submitted_on   date NOT NULL,                                       -- date only, so timing cannot identify people
  FOREIGN KEY (tenant_id, survey_id) REFERENCES surveys(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX survey_responses_idx ON survey_responses(tenant_id, survey_id);

CREATE TABLE kudos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_employee_id  uuid NOT NULL,
  to_employee_id    uuid NOT NULL,
  value             text NOT NULL CHECK (value IN ('TEAMWORK','CUSTOMER_FIRST','OWNERSHIP','INNOVATION','HELPFUL','LEADERSHIP','EXTRA_MILE')),
  message           text NOT NULL CHECK (length(message) BETWEEN 5 AND 500),
  hidden_at         timestamptz,
  hidden_by         uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (from_employee_id <> to_employee_id),
  FOREIGN KEY (tenant_id, from_employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, to_employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX kudos_idx ON kudos(tenant_id, created_at DESC);

-- ================================================================== workforce planning
CREATE TABLE headcount_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 3 AND 120),
  fiscal_year  text NOT NULL CHECK (fiscal_year ~ '^\d{4}/\d{2}$'),
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','ARCHIVED')),
  notes        text CHECK (length(notes) <= 2000),
  approved_by  uuid,
  approved_at  timestamptz,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE headcount_plan_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id          uuid NOT NULL,
  department_id    uuid,
  designation_id   uuid,
  branch_id        uuid,
  planned          int NOT NULL CHECK (planned BETWEEN 0 AND 100000),
  monthly_cost     numeric(14,2) CHECK (monthly_cost >= 0),            -- budgeted gross per head per month
  needed_by        date,
  note             text CHECK (length(note) <= 500),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES headcount_plans(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id),
  FOREIGN KEY (tenant_id, designation_id) REFERENCES designations(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE UNIQUE INDEX headcount_plan_lines_uq ON headcount_plan_lines(plan_id,
  coalesce(department_id, '00000000-0000-0000-0000-000000000000'), coalesce(designation_id, '00000000-0000-0000-0000-000000000000'),
  coalesce(branch_id, '00000000-0000-0000-0000-000000000000'));

-- ================================================================== custom request workflows
CREATE TABLE workflow_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 3 AND 80),
  description  text CHECK (length(description) <= 500),
  icon         text NOT NULL DEFAULT 'FileText',
  fields       jsonb NOT NULL DEFAULT '[]',     -- [{key, label, type: TEXT|TEXTAREA|NUMBER|AMOUNT|DATE|SELECT|CHECKBOX, required, options?, hint?}]
  steps        jsonb NOT NULL DEFAULT '[]',     -- [{name, approver: MANAGER|MANAGERS_MANAGER|DEPARTMENT_HEAD|ROLE|USER, roleKey?, userId?}]
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE workflow_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        int NOT NULL,
  definition_id uuid NOT NULL,
  snapshot      jsonb NOT NULL,                  -- name, fields and steps as they were when submitted
  employee_id   uuid NOT NULL,
  requester_id  uuid NOT NULL,
  data          jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  current_step  int NOT NULL DEFAULT 0,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, definition_id) REFERENCES workflow_definitions(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX workflow_requests_employee_idx ON workflow_requests(tenant_id, employee_id, created_at DESC);

CREATE TABLE workflow_request_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id    uuid NOT NULL,
  step_index    int NOT NULL,
  name          text NOT NULL,
  approver_ids  uuid[] NOT NULL DEFAULT '{}',    -- users who may decide this step
  status        text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','PENDING','APPROVED','REJECTED','SKIPPED')),
  decided_by    uuid,
  decided_at    timestamptz,
  note          text CHECK (length(note) <= 1000),
  UNIQUE (request_id, step_index),
  FOREIGN KEY (tenant_id, request_id) REFERENCES workflow_requests(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX workflow_request_steps_approver_idx ON workflow_request_steps USING gin (approver_ids) WHERE status = 'PENDING';

-- ================================================================== row-level security and grants
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['assets','asset_events','checklist_templates','journeys','journey_tasks','job_openings','candidates',
    'candidate_events','interviews','interview_feedback','hr_tickets','hr_ticket_messages','training_courses','training_sessions',
    'training_enrollments','appraisal_cycles','goals','appraisals','appraisal_feedback','surveys','survey_participants',
    'survey_responses','kudos','headcount_plans','headcount_plan_lines','workflow_definitions','workflow_requests',
    'workflow_request_steps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO hrms_app
                     USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())$p$, tbl);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hrms_app, hrms_system', tbl);
  END LOOP;
END $$;
-- Rows that may be removed by users: plan lines, template-free edits, kudos stays (hidden instead), goals stay (dropped instead).
GRANT DELETE ON headcount_plan_lines, journey_tasks, interview_feedback, survey_participants TO hrms_app, hrms_system;

-- ================================================================== plans and grants for existing companies
-- The Business plan promises upcoming modules as they launch: give it engagement and workforce planning.
INSERT INTO plan_entitlements (plan_id, feature_id, enabled)
SELECT p.id, f.id, true FROM plans p JOIN feature_catalog f ON f.key IN ('engagement', 'workforce_planning')
 WHERE p.code = 'BUSINESS'
ON CONFLICT (plan_id, feature_id) DO NOTHING;

-- Self-service grants on resources that already existed (new resources are backfilled by the seed).
INSERT INTO role_permissions (tenant_id, role_id, permission_id, scope)
SELECT r.tenant_id, r.id, p.id, g.scope
  FROM (VALUES
    ('employee', 'assets:view', 'OWN'), ('employee', 'training:view', 'OWN'), ('employee', 'training:create', 'OWN'),
    ('team_leader', 'assets:view', 'DIRECT_REPORTS'), ('team_leader', 'training:view', 'DIRECT_REPORTS'), ('team_leader', 'training:create', 'DIRECT_REPORTS'), ('team_leader', 'training:approve', 'DIRECT_REPORTS'),
    ('department_manager', 'assets:view', 'DEPARTMENT'), ('department_manager', 'training:view', 'DEPARTMENT'), ('department_manager', 'training:create', 'DEPARTMENT'), ('department_manager', 'training:approve', 'DEPARTMENT'),
    ('branch_manager', 'assets:view', 'BRANCH'), ('branch_manager', 'training:view', 'BRANCH'), ('branch_manager', 'training:create', 'BRANCH'), ('branch_manager', 'training:approve', 'BRANCH'),
    ('hr_officer', 'assets:view', 'COMPANY'), ('hr_officer', 'training:view', 'COMPANY'), ('hr_officer', 'training:create', 'COMPANY'), ('hr_officer', 'training:edit', 'COMPANY')
  ) AS g(role_key, perm_key, scope)
  JOIN roles r ON r.key = g.role_key AND r.is_system
  JOIN permissions p ON p.key = g.perm_key
ON CONFLICT (role_id, permission_id) DO NOTHING;
