-- Generated from POSTGRES_INITIAL_SCHEMA_SQL. Keep version 001 immutable after release.
CREATE TABLE pactmark_run_events (
  tenant_id text NOT NULL, run_id text NOT NULL, sequence bigint NOT NULL,
  event_id text NOT NULL, event_json jsonb NOT NULL, canonical_digest text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, run_id, sequence), UNIQUE (event_id)
);
CREATE INDEX pactmark_run_events_stream_idx ON pactmark_run_events (tenant_id, run_id, sequence);

CREATE FUNCTION pactmark_reject_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pactmark immutable record cannot be updated' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER pactmark_run_events_immutable BEFORE UPDATE OR DELETE ON pactmark_run_events
FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();

CREATE TABLE pactmark_run_projections (
  tenant_id text NOT NULL, run_id text NOT NULL, last_sequence bigint NOT NULL,
  projection_json jsonb NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
);

CREATE TABLE pactmark_work_orders (
  tenant_id text NOT NULL, work_order_id text NOT NULL,
  work_order_kind text NOT NULL CHECK (work_order_kind IN ('agent','compensation')),
  work_order_binding_digest text NOT NULL, execution_definition_json jsonb NOT NULL,
  execution_definition_digest text NOT NULL,
  model_security_profile_digest text, model_resource_profile_digest text,
  model_adapter_registration_digest text, canonical_digest text NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('public','internal','confidential','restricted')),
  purpose_code text NOT NULL, expires_at timestamptz, protected_ref_json jsonb NOT NULL,
  protected_key_id text NOT NULL, protected_ref text NOT NULL,
  original_run_id text, original_effect_id text, original_effect_digest text,
  original_effect_result_digest text, original_effect_acknowledgement_digest text,
  compensation_strategy_digest text, compensation_tool_id text, compensation_tool_version text,
  compensation_tool_registration_digest text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (tenant_id, work_order_id),
  CHECK (work_order_kind <> 'agent' OR
    (model_security_profile_digest IS NOT NULL AND model_resource_profile_digest IS NOT NULL
     AND model_adapter_registration_digest IS NOT NULL AND original_run_id IS NULL
     AND original_effect_id IS NULL AND compensation_strategy_digest IS NULL)),
  CHECK (work_order_kind <> 'compensation' OR
    (original_run_id IS NOT NULL AND original_effect_id IS NOT NULL AND original_effect_digest IS NOT NULL
     AND original_effect_result_digest IS NOT NULL AND original_effect_acknowledgement_digest IS NOT NULL
     AND compensation_strategy_digest IS NOT NULL AND compensation_tool_id IS NOT NULL
     AND compensation_tool_version IS NOT NULL AND compensation_tool_registration_digest IS NOT NULL
     AND model_security_profile_digest IS NULL AND model_resource_profile_digest IS NULL
     AND model_adapter_registration_digest IS NULL))
);
CREATE TRIGGER pactmark_work_orders_immutable BEFORE UPDATE ON pactmark_work_orders
FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();
CREATE UNIQUE INDEX pactmark_compensation_intent_unique
  ON pactmark_work_orders (tenant_id, original_run_id, original_effect_id, compensation_strategy_digest)
  WHERE work_order_kind = 'compensation';
CREATE UNIQUE INDEX pactmark_work_orders_protected_ref_unique
  ON pactmark_work_orders (protected_key_id, protected_ref) WHERE protected_ref IS NOT NULL;

CREATE TABLE pactmark_input_submissions (
  tenant_id text NOT NULL, run_id text NOT NULL, request_id text NOT NULL,
  input_submission_record_id text NOT NULL, input_schema_digest text NOT NULL,
  value_digest text NOT NULL, canonical_digest text NOT NULL, purpose_code text NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('public','internal','confidential','restricted')),
  consuming_command_id text NOT NULL, expires_at timestamptz, record_json jsonb NOT NULL,
  protected_key_id text NOT NULL, protected_ref text NOT NULL,
  PRIMARY KEY (tenant_id, run_id, request_id)
);
CREATE UNIQUE INDEX pactmark_input_submission_id_unique
  ON pactmark_input_submissions (tenant_id, input_submission_record_id);
CREATE UNIQUE INDEX pactmark_input_protected_ref_unique
  ON pactmark_input_submissions (protected_key_id, protected_ref);
CREATE TRIGGER pactmark_input_submissions_immutable BEFORE UPDATE ON pactmark_input_submissions
FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();

CREATE TABLE pactmark_context_snapshots (
  tenant_id text NOT NULL, run_id text NOT NULL, snapshot_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0), canonical_digest text NOT NULL,
  purpose_code text NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('public','internal','confidential','restricted')),
  expires_at timestamptz, snapshot_json jsonb NOT NULL, protected_key_id text NOT NULL,
  protected_ref text NOT NULL, PRIMARY KEY (tenant_id, run_id, snapshot_id)
);
CREATE INDEX pactmark_context_latest_idx
  ON pactmark_context_snapshots (tenant_id, run_id, sequence DESC, snapshot_id DESC);
CREATE UNIQUE INDEX pactmark_context_protected_ref_unique
  ON pactmark_context_snapshots (protected_key_id, protected_ref);
CREATE TRIGGER pactmark_context_snapshots_immutable BEFORE UPDATE ON pactmark_context_snapshots
FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();

CREATE TABLE pactmark_artifacts (
  tenant_id text NOT NULL, artifact_id text NOT NULL, canonical_digest text NOT NULL,
  content_digest text NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('public','internal','confidential','restricted')),
  purpose_code text NOT NULL, expires_at timestamptz, artifact_json jsonb NOT NULL,
  content bytea, protected_ref_json jsonb, protected_key_id text, protected_ref text,
  PRIMARY KEY (tenant_id, artifact_id), CHECK ((content IS NULL) <> (protected_ref_json IS NULL)),
  CHECK (content IS NULL OR octet_length(content) <= 1048576),
  CHECK ((protected_ref_json IS NULL) = (protected_key_id IS NULL)),
  CHECK ((protected_ref_json IS NULL) = (protected_ref IS NULL))
);
CREATE UNIQUE INDEX pactmark_artifacts_protected_ref_unique
  ON pactmark_artifacts (protected_key_id, protected_ref) WHERE protected_ref IS NOT NULL;
CREATE TRIGGER pactmark_artifacts_immutable BEFORE UPDATE ON pactmark_artifacts
FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();

CREATE TABLE pactmark_run_leases (
  tenant_id text NOT NULL, run_id text NOT NULL, lease_id text NOT NULL, holder_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 0), acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, state text NOT NULL CHECK (state IN ('active','released','expired')),
  PRIMARY KEY (tenant_id, run_id)
);

CREATE TABLE pactmark_wakeups (
  tenant_id text NOT NULL, run_id text NOT NULL, wakeup_id text NOT NULL,
  deduplication_key text NOT NULL, delegation_json jsonb NOT NULL, available_at timestamptz NOT NULL,
  claimed_by text, claimed_until timestamptz, claim_fencing_token bigint NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('pending','claimed','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (tenant_id,wakeup_id),
  UNIQUE (tenant_id,deduplication_key)
);
CREATE INDEX pactmark_wakeups_poll_idx ON pactmark_wakeups (state,available_at,tenant_id,wakeup_id);

CREATE TABLE pactmark_decision_challenges (
  tenant_id text NOT NULL, run_id text NOT NULL, challenge_id text NOT NULL,
  binding_digest text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  consuming_command_id text, PRIMARY KEY (tenant_id,run_id,challenge_id),
  CHECK ((consumed_at IS NULL) = (consuming_command_id IS NULL))
);
CREATE UNIQUE INDEX pactmark_decision_challenge_consumption
  ON pactmark_decision_challenges (tenant_id,consuming_command_id) WHERE consuming_command_id IS NOT NULL;

CREATE TABLE pactmark_decisions (
  tenant_id text NOT NULL, run_id text NOT NULL, decision_id text NOT NULL,
  challenge_id text NOT NULL, canonical_digest text NOT NULL, decision_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id,decision_id), UNIQUE (tenant_id,run_id,challenge_id)
);
CREATE TRIGGER pactmark_decisions_immutable BEFORE UPDATE ON pactmark_decisions
FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();

CREATE TABLE pactmark_approvals (
  tenant_id text NOT NULL, run_id text NOT NULL, approval_id text NOT NULL,
  decision_id text NOT NULL, binding_digest text NOT NULL, expires_at timestamptz NOT NULL,
  used_at timestamptz, use_claim_id text, PRIMARY KEY (tenant_id,run_id,approval_id),
  UNIQUE (tenant_id,run_id,decision_id), UNIQUE (tenant_id,use_claim_id)
);

CREATE TABLE pactmark_capability_grants (
  tenant_id text NOT NULL, grant_id text NOT NULL, issuer_id text NOT NULL, principal_id text NOT NULL,
  work_order_id text NOT NULL, execution_definition_digest text NOT NULL, tool_digest text NOT NULL,
  resource_digest text NOT NULL, purpose_code text NOT NULL, expires_at timestamptz NOT NULL,
  remaining_uses bigint NOT NULL CHECK (remaining_uses >= 0), revoked_at timestamptz,
  PRIMARY KEY (tenant_id,grant_id)
);

CREATE TABLE pactmark_secret_refs (
  tenant_id text NOT NULL, secret_ref_id text NOT NULL, binding_digest text NOT NULL,
  revoked_at timestamptz, metadata_json jsonb NOT NULL,
  PRIMARY KEY (tenant_id,secret_ref_id)
);

CREATE TABLE pactmark_authorization_reservations (
  tenant_id text NOT NULL, reservation_id text NOT NULL, authorization_key text NOT NULL,
  binding_digest text NOT NULL, state text NOT NULL CHECK (state IN ('reserved','committed','released')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (tenant_id,reservation_id),
  UNIQUE (tenant_id,authorization_key)
);
CREATE TABLE pactmark_authorization_use_claims (
  tenant_id text NOT NULL, reservation_id text NOT NULL, claim_kind text NOT NULL,
  claim_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,claim_kind,claim_id),
  FOREIGN KEY (tenant_id,reservation_id) REFERENCES pactmark_authorization_reservations(tenant_id,reservation_id)
);

CREATE TABLE pactmark_effects (
  tenant_id text NOT NULL, run_id text NOT NULL, effect_id text NOT NULL, operation_key text NOT NULL,
  binding_digest text NOT NULL, state text NOT NULL, effect_json jsonb NOT NULL,
  PRIMARY KEY (tenant_id,run_id,effect_id), UNIQUE (tenant_id,operation_key)
);

CREATE TABLE pactmark_commands (
  tenant_id text NOT NULL, command_scope text NOT NULL, idempotency_key text NOT NULL,
  canonical_digest text NOT NULL, state text NOT NULL, result_ref_json jsonb,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,command_scope,idempotency_key)
);

CREATE TABLE pactmark_active_execution_reservations (
  tenant_id text NOT NULL, reservation_id text NOT NULL, run_id text NOT NULL,
  fencing_token bigint NOT NULL, maximum_debit bigint NOT NULL CHECK (maximum_debit >= 0),
  settled_debit bigint CHECK (settled_debit >= 0), state text NOT NULL,
  expires_at timestamptz NOT NULL, PRIMARY KEY (tenant_id,reservation_id),
  UNIQUE (tenant_id,run_id,reservation_id)
);
CREATE TABLE pactmark_admission_reservations (
  tenant_id text NOT NULL, reservation_id text NOT NULL, command_key text NOT NULL,
  counter_kind text NOT NULL, amount bigint NOT NULL CHECK (amount > 0),
  lease_expires_at timestamptz NOT NULL, released_at timestamptz,
  PRIMARY KEY (tenant_id,reservation_id), UNIQUE (tenant_id,command_key,counter_kind)
);
CREATE TABLE pactmark_model_call_reservations (
  tenant_id text NOT NULL, run_id text NOT NULL, step_id text NOT NULL, attempt bigint NOT NULL,
  provider_id text NOT NULL, maximum_tokens bigint NOT NULL CHECK (maximum_tokens >= 0),
  maximum_cost numeric NOT NULL CHECK (maximum_cost >= 0), settled_tokens bigint,
  settled_cost numeric, state text NOT NULL,
  PRIMARY KEY (tenant_id,run_id,step_id,attempt)
);
CREATE TABLE pactmark_quota_windows (
  tenant_id text NOT NULL, quota_kind text NOT NULL, window_start timestamptz NOT NULL,
  used bigint NOT NULL CHECK (used >= 0), limit_value bigint NOT NULL CHECK (limit_value >= 0),
  PRIMARY KEY (tenant_id,quota_kind,window_start)
);
CREATE TABLE pactmark_circuit_breakers (
  tenant_id text NOT NULL, provider_id text NOT NULL, state text NOT NULL,
  failure_count bigint NOT NULL CHECK (failure_count >= 0), opened_until timestamptz,
  PRIMARY KEY (tenant_id,provider_id)
);
