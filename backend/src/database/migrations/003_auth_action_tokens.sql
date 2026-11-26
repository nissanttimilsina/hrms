-- One-time tokens for password reset and email verification (system role only).
CREATE TABLE auth_action_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('PLATFORM','TENANT')),
  user_id      uuid NOT NULL,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('PASSWORD_RESET','EMAIL_VERIFY')),
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_type = 'TENANT') = (tenant_id IS NOT NULL))
);
CREATE INDEX auth_action_tokens_user_idx ON auth_action_tokens(subject_type, user_id, purpose);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_action_tokens TO hrms_system;
