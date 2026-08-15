import { digestCanonicalJson, KafError, type MigrationManager } from "@pactmark/core";
import type { PostgresClient, PostgresDatabase } from "./database.js";
import { withTransaction } from "./database.js";

export interface PostgresMigration {
  readonly version: string;
  readonly description: string;
  readonly reversibleSafe: boolean;
  readonly up: readonly string[];
  readonly down: readonly string[];
}

export const POSTGRES_INITIAL_SCHEMA_SQL = `
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
`;

export const POSTGRES_COMMAND_UOW_SCHEMA_SQL = `
ALTER TABLE pactmark_run_events DROP CONSTRAINT pactmark_run_events_event_id_key;
ALTER TABLE pactmark_run_events ADD CONSTRAINT pactmark_run_events_tenant_event_id_key
  UNIQUE (tenant_id,event_id);
ALTER TABLE pactmark_commands
  ADD COLUMN scope_json jsonb,
  ADD COLUMN request_digest text,
  ADD COLUMN command_record_json jsonb,
  ADD COLUMN value_json jsonb;
ALTER TABLE pactmark_commands
  ADD CONSTRAINT pactmark_commands_durable_fields CHECK
  ((scope_json IS NULL AND request_digest IS NULL AND
    command_record_json IS NULL AND value_json IS NULL) OR
   (scope_json IS NOT NULL AND request_digest IS NOT NULL AND
    command_record_json IS NOT NULL AND value_json IS NOT NULL));
ALTER TABLE pactmark_wakeups ADD COLUMN request_digest text;
CREATE TABLE pactmark_run_transitions (
  tenant_id text NOT NULL, run_id text NOT NULL, transition_digest text NOT NULL,
  transition_json jsonb NOT NULL, value_json jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,transition_digest)
);
`;

export const POSTGRES_PROTECTED_STORAGE_SCHEMA_SQL = `
CREATE TABLE pactmark_protection_key_counters (
  namespace_id text NOT NULL, key_id text NOT NULL,
  invocation_count bigint NOT NULL CHECK (invocation_count >= 0),
  invocation_ceiling bigint NOT NULL CHECK (invocation_ceiling > 0),
  PRIMARY KEY (key_id),
  CHECK (invocation_count <= invocation_ceiling)
);
CREATE TABLE pactmark_protection_nonces (
  namespace_id text NOT NULL, key_id text NOT NULL, nonce bytea NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (key_id,nonce),
  CHECK (octet_length(nonce) = 12),
  FOREIGN KEY (key_id) REFERENCES pactmark_protection_key_counters(key_id)
);
`;

export const POSTGRES_EFFECT_AUTHORIZATION_UOW_SCHEMA_SQL = `
ALTER TABLE pactmark_authorization_reservations
  DROP CONSTRAINT pactmark_authorization_reservations_state_check,
  ADD COLUMN run_id text,
  ADD COLUMN effect_key text,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN reservation_json jsonb,
  ADD CONSTRAINT pactmark_authorization_reservations_state_check
    CHECK (state IN ('reserved','consumed','expired','revoked')),
  ADD CONSTRAINT pactmark_authorization_reservations_runtime_fields CHECK
    ((run_id IS NULL AND expires_at IS NULL AND reservation_json IS NULL) OR
     (run_id IS NOT NULL AND expires_at IS NOT NULL AND reservation_json IS NOT NULL));
ALTER TABLE pactmark_effects
  ALTER COLUMN operation_key DROP NOT NULL,
  ADD COLUMN effect_key text,
  ADD COLUMN effect_digest text,
  ADD COLUMN authorization_reservation_id text,
  ADD COLUMN updated_at timestamptz,
  ADD CONSTRAINT pactmark_effects_runtime_fields CHECK
    ((effect_key IS NULL AND effect_digest IS NULL AND authorization_reservation_id IS NULL AND updated_at IS NULL) OR
     (effect_key IS NOT NULL AND effect_digest IS NOT NULL AND authorization_reservation_id IS NOT NULL AND updated_at IS NOT NULL));
CREATE UNIQUE INDEX pactmark_effect_key_unique
  ON pactmark_effects (tenant_id,run_id,effect_key) WHERE effect_key IS NOT NULL;
`;

export const POSTGRES_AUTHORITY_DECISION_AGGREGATES_SCHEMA_SQL = `
ALTER TABLE pactmark_capability_grants
  ADD COLUMN work_order_binding_digest text,
  ADD COLUMN canonical_digest text,
  ADD COLUMN grant_json jsonb,
  ADD CONSTRAINT pactmark_capability_grants_runtime_fields CHECK
    ((work_order_binding_digest IS NULL AND canonical_digest IS NULL AND grant_json IS NULL) OR
     (work_order_binding_digest IS NOT NULL AND canonical_digest IS NOT NULL AND grant_json IS NOT NULL));
CREATE TABLE pactmark_capability_grant_use_claims (
  tenant_id text NOT NULL, grant_id text NOT NULL, authorization_key text NOT NULL,
  use_number bigint NOT NULL CHECK (use_number > 0), claimed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,grant_id,authorization_key), UNIQUE (tenant_id,grant_id,use_number),
  FOREIGN KEY (tenant_id,grant_id) REFERENCES pactmark_capability_grants(tenant_id,grant_id)
);
CREATE TABLE pactmark_decision_gates (
  tenant_id text NOT NULL, run_id text NOT NULL, decision_id text NOT NULL,
  decision_gate_digest text NOT NULL, gate_json jsonb NOT NULL,
  created_at timestamptz NOT NULL, PRIMARY KEY (tenant_id,run_id,decision_id)
);
ALTER TABLE pactmark_decision_challenges
  ADD COLUMN canonical_digest text,
  ADD COLUMN challenge_json jsonb,
  ADD CONSTRAINT pactmark_decision_challenges_tenant_challenge_id_unique
    UNIQUE (tenant_id,challenge_id),
  ADD CONSTRAINT pactmark_decision_challenges_runtime_fields CHECK
    ((canonical_digest IS NULL AND challenge_json IS NULL) OR
     (canonical_digest IS NOT NULL AND challenge_json IS NOT NULL));
ALTER TABLE pactmark_approvals
  ADD COLUMN canonical_digest text,
  ADD COLUMN challenge_proof_digest text,
  ADD COLUMN maximum_uses bigint CHECK (maximum_uses = 1),
  ADD COLUMN approval_json jsonb,
  ADD CONSTRAINT pactmark_approvals_runtime_fields CHECK
    ((canonical_digest IS NULL AND challenge_proof_digest IS NULL AND maximum_uses IS NULL AND approval_json IS NULL) OR
     (canonical_digest IS NOT NULL AND challenge_proof_digest IS NOT NULL AND maximum_uses = 1 AND approval_json IS NOT NULL));
ALTER TABLE pactmark_approvals
  ADD CONSTRAINT pactmark_approvals_tenant_approval_id_unique UNIQUE (tenant_id,approval_id);
CREATE TABLE pactmark_approval_use_claims (
  tenant_id text NOT NULL, approval_id text NOT NULL, authorization_key text NOT NULL,
  claimed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,approval_id), UNIQUE (tenant_id,authorization_key),
  FOREIGN KEY (tenant_id,approval_id) REFERENCES pactmark_approvals(tenant_id,approval_id)
);
`;

export const POSTGRES_RESOURCE_RESERVATIONS_SCHEMA_SQL = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pactmark_circuit_breakers LIMIT 1)
    OR EXISTS (SELECT 1 FROM pactmark_quota_windows LIMIT 1)
    OR EXISTS (SELECT 1 FROM pactmark_model_call_reservations LIMIT 1)
    OR EXISTS (SELECT 1 FROM pactmark_admission_reservations LIMIT 1)
    OR EXISTS (SELECT 1 FROM pactmark_active_execution_reservations LIMIT 1)
  THEN
    RAISE EXCEPTION 'PACTMARK_MIGRATION_006_INCOMPATIBLE_POPULATED_SKELETON_TABLES'
      USING ERRCODE = '55000';
  END IF;
END $$;

DROP TABLE pactmark_circuit_breakers;
DROP TABLE pactmark_quota_windows;
DROP TABLE pactmark_model_call_reservations;
DROP TABLE pactmark_admission_reservations;
DROP TABLE pactmark_active_execution_reservations;

CREATE SEQUENCE pactmark_reservation_id_seq;

CREATE TABLE pactmark_admission_reservations (
  tenant_id text NOT NULL, reservation_id text NOT NULL,
  principal_type text NOT NULL, principal_id text NOT NULL, command_id text,
  category text NOT NULL, resource_key text NOT NULL, amount double precision NOT NULL CHECK (amount > 0),
  state text NOT NULL CHECK (state IN ('reserved','released','expired')),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 0),
  reserved_at timestamptz NOT NULL, lease_expires_at timestamptz NOT NULL, released_at timestamptz,
  request_digest text NOT NULL, reservation_json jsonb NOT NULL,
  PRIMARY KEY (tenant_id,reservation_id), CHECK ((state = 'released') = (released_at IS NOT NULL))
);
CREATE UNIQUE INDEX pactmark_admission_command_unique ON pactmark_admission_reservations
  (tenant_id,principal_type,principal_id,command_id,category,resource_key) WHERE command_id IS NOT NULL;
CREATE INDEX pactmark_admission_counter_idx ON pactmark_admission_reservations
  (tenant_id,principal_type,principal_id,category,resource_key,state,lease_expires_at);

CREATE TABLE pactmark_active_execution_reservations (
  tenant_id text NOT NULL, reservation_id text NOT NULL, run_id text NOT NULL, step_id text NOT NULL,
  boundary text NOT NULL, boundary_key text NOT NULL, lease_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 0), max_charge_ms bigint NOT NULL CHECK (max_charge_ms > 0),
  state text NOT NULL CHECK (state IN ('reserved','settled','closed_uncertain')),
  settled_charge_ms bigint, refunded_ms bigint, started_at timestamptz NOT NULL,
  settled_at timestamptz, expires_at timestamptz NOT NULL, canonical_digest text NOT NULL,
  reservation_json jsonb NOT NULL, PRIMARY KEY (tenant_id,reservation_id),
  UNIQUE (tenant_id,run_id,step_id,boundary,boundary_key),
  CHECK ((state = 'reserved' AND settled_charge_ms IS NULL AND refunded_ms IS NULL AND settled_at IS NULL)
    OR (state <> 'reserved' AND settled_charge_ms >= 0 AND refunded_ms >= 0 AND settled_at IS NOT NULL
      AND settled_charge_ms + refunded_ms = max_charge_ms)),
  CHECK (state <> 'closed_uncertain' OR (settled_charge_ms = max_charge_ms AND refunded_ms = 0))
);
CREATE INDEX pactmark_active_execution_expiry_idx ON pactmark_active_execution_reservations
  (state,expires_at,tenant_id);

CREATE TABLE pactmark_model_call_reservations (
  tenant_id text NOT NULL, run_id text NOT NULL, step_id text NOT NULL, attempt bigint NOT NULL CHECK (attempt > 0),
  reservation_id text NOT NULL, provider_key text NOT NULL, maximum_tokens bigint NOT NULL CHECK (maximum_tokens > 0),
  maximum_io_bytes bigint NOT NULL CHECK (maximum_io_bytes > 0), maximum_cost_minor bigint,
  currency text, state text NOT NULL CHECK (state IN ('accepted','dispatched','settled','uncertain','expired')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, canonical_digest text NOT NULL,
  reservation_json jsonb NOT NULL, PRIMARY KEY (tenant_id,run_id,step_id,attempt),
  UNIQUE (tenant_id,reservation_id), CHECK ((maximum_cost_minor IS NULL) = (currency IS NULL)),
  CHECK (maximum_cost_minor IS NULL OR maximum_cost_minor >= 0)
);
CREATE INDEX pactmark_model_call_quota_idx ON pactmark_model_call_reservations
  (tenant_id,provider_key,state,expires_at);

CREATE TABLE pactmark_quota_windows (
  tenant_id text NOT NULL, principal_type text NOT NULL, principal_id text NOT NULL,
  metric text NOT NULL, resource_key text NOT NULL, used double precision NOT NULL CHECK (used >= 0),
  limit_value double precision NOT NULL CHECK (limit_value > 0), updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,principal_type,principal_id,metric,resource_key)
);

CREATE TABLE pactmark_circuit_breakers (
  tenant_id text NOT NULL, provider_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('closed','open','half_open')),
  failure_count bigint NOT NULL CHECK (failure_count >= 0), opened_at timestamptz,
  probe_lease_id text, probe_fencing_token bigint, updated_at timestamptz NOT NULL,
  canonical_digest text NOT NULL, state_json jsonb NOT NULL, PRIMARY KEY (tenant_id,provider_key),
  CHECK ((probe_lease_id IS NULL) = (probe_fencing_token IS NULL)),
  CHECK (probe_fencing_token IS NULL OR probe_fencing_token >= 0),
  CHECK (state <> 'half_open' OR probe_lease_id IS NOT NULL)
);
`;

export const POSTGRES_WORKER_QUEUE_METADATA_SCHEMA_SQL = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pactmark_wakeups LIMIT 1) THEN
    RAISE EXCEPTION 'PACTMARK_MIGRATION_007_INCOMPATIBLE_UNBOUND_WAKEUPS'
      USING ERRCODE = '55000';
  END IF;
END $$;

ALTER TABLE pactmark_work_orders
  ADD COLUMN principal_type text,
  ADD COLUMN principal_id text,
  ADD COLUMN purpose_registry_version text,
  ADD COLUMN resource_scope_ceiling_json jsonb,
  ADD CONSTRAINT pactmark_work_orders_worker_metadata CHECK
    ((principal_type IS NULL AND principal_id IS NULL AND purpose_registry_version IS NULL
      AND resource_scope_ceiling_json IS NULL)
     OR
     (principal_type IS NOT NULL AND principal_id IS NOT NULL
      AND purpose_registry_version IS NOT NULL
      AND jsonb_typeof(resource_scope_ceiling_json) = 'array'));

CREATE TABLE pactmark_run_work_orders (
  tenant_id text NOT NULL, run_id text NOT NULL, work_order_id text NOT NULL,
  work_order_binding_digest text NOT NULL, execution_definition_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,work_order_id)
    REFERENCES pactmark_work_orders(tenant_id,work_order_id)
);
CREATE TRIGGER pactmark_run_work_orders_immutable
  BEFORE UPDATE OR DELETE ON pactmark_run_work_orders
  FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();

ALTER TABLE pactmark_wakeups
  ALTER COLUMN request_digest SET NOT NULL,
  ADD COLUMN work_order_id text NOT NULL,
  ADD COLUMN claim_lease_id text,
  ADD COLUMN claim_attempts bigint NOT NULL DEFAULT 0 CHECK (claim_attempts >= 0),
  ADD COLUMN claim_result_status text CHECK (claim_result_status IN ('completed','parked','failed')),
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN release_reason_code text,
  ADD CONSTRAINT pactmark_wakeups_worker_binding_fk
    FOREIGN KEY (tenant_id,work_order_id)
    REFERENCES pactmark_work_orders(tenant_id,work_order_id),
  ADD CONSTRAINT pactmark_wakeups_worker_state CHECK (
    (state = 'pending' AND claimed_by IS NULL AND claimed_until IS NULL AND claim_lease_id IS NULL
      AND claim_result_status IS NULL AND completed_at IS NULL)
    OR
    (state = 'claimed' AND claimed_by IS NOT NULL AND claimed_until IS NOT NULL
      AND claim_lease_id IS NOT NULL AND claim_fencing_token > 0
      AND claim_result_status IS NULL AND completed_at IS NULL)
    OR
    (state = 'completed' AND claimed_by IS NOT NULL AND claimed_until IS NOT NULL
      AND claim_lease_id IS NOT NULL AND claim_fencing_token > 0
      AND claim_result_status IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (state = 'cancelled' AND completed_at IS NOT NULL)
  );
CREATE INDEX pactmark_wakeups_claim_expiry_idx
  ON pactmark_wakeups (state,claimed_until,tenant_id,wakeup_id);
`;

export const POSTGRES_EVIDENCE_RECORDS_SCHEMA_SQL = `
CREATE TABLE pactmark_evidence_records (
  tenant_id text NOT NULL, evidence_record_id text NOT NULL, run_id text NOT NULL,
  evidence_digest text NOT NULL, canonical_digest text NOT NULL, record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,evidence_record_id), UNIQUE (tenant_id,evidence_digest)
);
CREATE TRIGGER pactmark_evidence_records_immutable
  BEFORE UPDATE OR DELETE ON pactmark_evidence_records
  FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();

CREATE TABLE pactmark_verification_records (
  tenant_id text NOT NULL, run_id text NOT NULL, verification_id text NOT NULL,
  verification_digest text NOT NULL, canonical_digest text NOT NULL, record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id,verification_id), UNIQUE (tenant_id,verification_digest)
);
CREATE TRIGGER pactmark_verification_records_immutable
  BEFORE UPDATE OR DELETE ON pactmark_verification_records
  FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();

CREATE TABLE pactmark_pattern_records (
  tenant_id text NOT NULL, pattern_id text NOT NULL, pattern_version text NOT NULL,
  pattern_digest text NOT NULL, canonical_digest text NOT NULL, record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,pattern_id,pattern_version), UNIQUE (tenant_id,pattern_digest)
);
CREATE TRIGGER pactmark_pattern_records_immutable
  BEFORE UPDATE OR DELETE ON pactmark_pattern_records
  FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();
`;

export const POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL = `
CREATE UNIQUE INDEX pactmark_run_work_orders_effect_result_binding_unique
  ON pactmark_run_work_orders (tenant_id,run_id,work_order_id);

CREATE TABLE pactmark_acknowledged_effect_results (
  tenant_id text NOT NULL, run_id text NOT NULL, effect_id text NOT NULL,
  effect_digest text NOT NULL, result_digest text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  work_order_id text NOT NULL, work_order_binding_digest text NOT NULL,
  execution_definition_digest text NOT NULL,
  tool_id text NOT NULL, tool_version text NOT NULL, tool_registration_digest text NOT NULL,
  strategy text NOT NULL CHECK (strategy IN ('native','transactional','reconcilable','none')),
  strategy_registration_digest text NOT NULL, result_schema_digest text NOT NULL,
  purpose_code text NOT NULL, purpose_registry_version text NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('public','internal','confidential','restricted')),
  canonical_digest text NOT NULL, record_json jsonb NOT NULL,
  protected_key_id text NOT NULL, protected_ref text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,run_id,effect_id),
  UNIQUE (tenant_id,effect_digest),
  UNIQUE (tenant_id,protected_key_id,protected_ref),
  FOREIGN KEY (tenant_id,run_id,work_order_id)
    REFERENCES pactmark_run_work_orders(tenant_id,run_id,work_order_id),
  FOREIGN KEY (tenant_id,run_id,effect_id)
    REFERENCES pactmark_effects(tenant_id,run_id,effect_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER pactmark_acknowledged_effect_results_immutable
  BEFORE UPDATE OR DELETE ON pactmark_acknowledged_effect_results
  FOR EACH ROW EXECUTE FUNCTION pactmark_reject_immutable_update();
`;

export const POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL = `
DROP INDEX IF EXISTS pactmark_work_orders_protected_ref_unique;
DROP INDEX IF EXISTS pactmark_input_protected_ref_unique;
DROP INDEX IF EXISTS pactmark_context_protected_ref_unique;
DROP INDEX IF EXISTS pactmark_artifacts_protected_ref_unique;

DO $migration$
DECLARE protected_ref_constraint text;
BEGIN
  SELECT constraint_name INTO protected_ref_constraint
  FROM information_schema.constraint_column_usage
  WHERE table_schema=current_schema()
    AND table_name='pactmark_acknowledged_effect_results'
    AND column_name='protected_ref'
    AND constraint_name <> 'pactmark_acknowledged_effect_results_pkey'
  ORDER BY constraint_name
  LIMIT 1;
  IF protected_ref_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE pactmark_acknowledged_effect_results DROP CONSTRAINT %I',
      protected_ref_constraint
    );
  END IF;
END $migration$;

ALTER TABLE pactmark_work_orders
  ADD COLUMN max_active_execution_ms bigint
    CHECK (max_active_execution_ms IS NULL OR max_active_execution_ms > 0),
  ADD CONSTRAINT pactmark_work_orders_protected_digest_present
  CHECK (length(protected_ref_json->>'ciphertextDigest') > 0);
ALTER TABLE pactmark_input_submissions
  ADD CONSTRAINT pactmark_input_protected_digest_present
  CHECK (length(record_json#>>'{protectedValue,ciphertextDigest}') > 0);
ALTER TABLE pactmark_context_snapshots
  ADD CONSTRAINT pactmark_context_protected_digest_present
  CHECK (length(snapshot_json#>>'{protectedValue,ciphertextDigest}') > 0);
ALTER TABLE pactmark_artifacts
  ADD CONSTRAINT pactmark_artifacts_protected_digest_present
  CHECK (
    protected_ref_json IS NULL
    OR length(protected_ref_json->>'ciphertextDigest') > 0
  );
ALTER TABLE pactmark_acknowledged_effect_results
  ADD CONSTRAINT pactmark_acknowledged_effect_results_protected_digest_present
  CHECK (length(record_json#>>'{protectedValue,ciphertextDigest}') > 0);

CREATE UNIQUE INDEX pactmark_work_orders_protected_ref_unique
  ON pactmark_work_orders (
    tenant_id,
    protected_key_id,
    (protected_ref_json->>'ciphertextDigest')
  );
CREATE UNIQUE INDEX pactmark_input_protected_ref_unique
  ON pactmark_input_submissions (
    tenant_id,
    protected_key_id,
    (record_json#>>'{protectedValue,ciphertextDigest}')
  );
CREATE UNIQUE INDEX pactmark_context_protected_ref_unique
  ON pactmark_context_snapshots (
    tenant_id,
    protected_key_id,
    (snapshot_json#>>'{protectedValue,ciphertextDigest}')
  );
CREATE UNIQUE INDEX pactmark_artifacts_protected_ref_unique
  ON pactmark_artifacts (
    tenant_id,
    protected_key_id,
    (protected_ref_json->>'ciphertextDigest')
  ) WHERE protected_ref_json IS NOT NULL;
CREATE UNIQUE INDEX pactmark_acknowledged_effect_results_protected_ref_unique
  ON pactmark_acknowledged_effect_results (
    tenant_id,
    protected_key_id,
    (record_json#>>'{protectedValue,ciphertextDigest}')
  );
`;

export const POSTGRES_TENANT_ROW_LEVEL_SECURITY_SCHEMA_SQL = `
DO $migration$
DECLARE tenant_table record;
BEGIN
  FOR tenant_table IN
    SELECT DISTINCT table_schema, table_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND column_name = 'tenant_id'
      AND table_name LIKE 'pactmark_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      tenant_table.table_schema,
      tenant_table.table_name
    );
    EXECUTE format(
      'CREATE POLICY pactmark_tenant_isolation ON %I.%I
       USING (tenant_id = NULLIF(current_setting(''pactmark.tenant_id'', true), ''''))
       WITH CHECK (tenant_id = NULLIF(current_setting(''pactmark.tenant_id'', true), ''''))',
      tenant_table.table_schema,
      tenant_table.table_name
    );
  END LOOP;
END $migration$;
`;

export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = Object.freeze([
  Object.freeze({
    version: "001",
    description: "tenant-scoped event, projection, record, artifact, and lease stores",
    reversibleSafe: false,
    up: [POSTGRES_INITIAL_SCHEMA_SQL],
    down: [
      `DROP TABLE IF EXISTS pactmark_circuit_breakers, pactmark_quota_windows,
       pactmark_model_call_reservations, pactmark_admission_reservations,
       pactmark_active_execution_reservations,
       pactmark_commands, pactmark_effects, pactmark_authorization_use_claims,
       pactmark_authorization_reservations, pactmark_secret_refs, pactmark_capability_grants,
       pactmark_approvals, pactmark_decisions, pactmark_decision_challenges, pactmark_wakeups,
       pactmark_run_leases, pactmark_artifacts,
       pactmark_context_snapshots, pactmark_input_submissions, pactmark_work_orders,
       pactmark_run_projections, pactmark_run_events;
       DROP FUNCTION IF EXISTS pactmark_reject_immutable_update();`,
    ],
  }),
  Object.freeze({
    version: "002",
    description: "durable aggregate command transactions and transition fencing",
    reversibleSafe: false,
    up: [POSTGRES_COMMAND_UOW_SCHEMA_SQL],
    down: [
      `DROP TABLE IF EXISTS pactmark_run_transitions;
       ALTER TABLE pactmark_wakeups DROP COLUMN IF EXISTS request_digest;
       ALTER TABLE pactmark_commands DROP CONSTRAINT IF EXISTS pactmark_commands_durable_fields,
         DROP COLUMN IF EXISTS scope_json, DROP COLUMN IF EXISTS request_digest,
         DROP COLUMN IF EXISTS command_record_json, DROP COLUMN IF EXISTS value_json;
       ALTER TABLE pactmark_run_events DROP CONSTRAINT IF EXISTS pactmark_run_events_tenant_event_id_key;
      ALTER TABLE pactmark_run_events ADD CONSTRAINT pactmark_run_events_event_id_key UNIQUE (event_id);`,
    ],
  }),
  Object.freeze({
    version: "003",
    description: "protected storage nonce uniqueness and per-key invocation ceilings",
    reversibleSafe: true,
    up: [POSTGRES_PROTECTED_STORAGE_SCHEMA_SQL],
    down: [
      `DROP TABLE IF EXISTS pactmark_protection_nonces;
       DROP TABLE IF EXISTS pactmark_protection_key_counters;`,
    ],
  }),
  Object.freeze({
    version: "004",
    description: "durable effect ledger and authorization reservation aggregate writes",
    reversibleSafe: false,
    up: [POSTGRES_EFFECT_AUTHORIZATION_UOW_SCHEMA_SQL],
    down: [
      `DROP INDEX IF EXISTS pactmark_effect_key_unique;
       ALTER TABLE pactmark_effects DROP CONSTRAINT IF EXISTS pactmark_effects_runtime_fields,
         DROP COLUMN IF EXISTS effect_key, DROP COLUMN IF EXISTS effect_digest,
         DROP COLUMN IF EXISTS authorization_reservation_id, DROP COLUMN IF EXISTS updated_at;
       ALTER TABLE pactmark_effects ALTER COLUMN operation_key SET NOT NULL;
       ALTER TABLE pactmark_authorization_reservations
         DROP CONSTRAINT IF EXISTS pactmark_authorization_reservations_runtime_fields,
         DROP CONSTRAINT IF EXISTS pactmark_authorization_reservations_state_check,
         DROP COLUMN IF EXISTS run_id, DROP COLUMN IF EXISTS effect_key,
         DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS reservation_json,
         ADD CONSTRAINT pactmark_authorization_reservations_state_check
           CHECK (state IN ('reserved','committed','released'));`,
    ],
  }),
  Object.freeze({
    version: "005",
    description: "atomic grant, decision challenge, approval, and use-claim aggregates",
    reversibleSafe: false,
    up: [POSTGRES_AUTHORITY_DECISION_AGGREGATES_SCHEMA_SQL],
    down: [
      `DROP TABLE IF EXISTS pactmark_approval_use_claims;
       ALTER TABLE pactmark_approvals DROP CONSTRAINT IF EXISTS pactmark_approvals_runtime_fields,
         DROP CONSTRAINT IF EXISTS pactmark_approvals_tenant_approval_id_unique,
         DROP COLUMN IF EXISTS canonical_digest, DROP COLUMN IF EXISTS challenge_proof_digest,
         DROP COLUMN IF EXISTS maximum_uses, DROP COLUMN IF EXISTS approval_json;
       ALTER TABLE pactmark_decision_challenges
         DROP CONSTRAINT IF EXISTS pactmark_decision_challenges_runtime_fields,
         DROP CONSTRAINT IF EXISTS pactmark_decision_challenges_tenant_challenge_id_unique,
         DROP COLUMN IF EXISTS canonical_digest, DROP COLUMN IF EXISTS challenge_json;
       DROP TABLE IF EXISTS pactmark_decision_gates;
       DROP TABLE IF EXISTS pactmark_capability_grant_use_claims;
       ALTER TABLE pactmark_capability_grants
         DROP CONSTRAINT IF EXISTS pactmark_capability_grants_runtime_fields,
         DROP COLUMN IF EXISTS work_order_binding_digest,
         DROP COLUMN IF EXISTS canonical_digest, DROP COLUMN IF EXISTS grant_json;`,
    ],
  }),
  Object.freeze({
    version: "006",
    description: "admission, quota, model, active execution, and circuit CAS records",
    reversibleSafe: false,
    up: [POSTGRES_RESOURCE_RESERVATIONS_SCHEMA_SQL],
    down: [],
  }),
  Object.freeze({
    version: "007",
    description: "immutable worker authority metadata and fenced wakeup claims",
    reversibleSafe: false,
    up: [POSTGRES_WORKER_QUEUE_METADATA_SCHEMA_SQL],
    down: [],
  }),
  Object.freeze({
    version: "008",
    description: "tenant-scoped immutable evidence, verification, and pattern records",
    reversibleSafe: false,
    up: [POSTGRES_EVIDENCE_RECORDS_SCHEMA_SQL],
    down: [],
  }),
  Object.freeze({
    version: "009",
    description: "protected immutable acknowledged effect results",
    reversibleSafe: false,
    up: [POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL],
    down: [],
  }),
  Object.freeze({
    version: "010",
    description: "protected reference digests and authoritative active execution budget metadata",
    reversibleSafe: false,
    up: [POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL],
    down: [],
  }),
  Object.freeze({
    version: "011",
    description: "tenant row-level security policies for non-owner runtime roles",
    reversibleSafe: true,
    up: [POSTGRES_TENANT_ROW_LEVEL_SECURITY_SCHEMA_SQL],
    down: [
      `DO $migration$
       DECLARE tenant_table record;
       BEGIN
         FOR tenant_table IN
           SELECT DISTINCT table_schema, table_name
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND column_name = 'tenant_id'
             AND table_name LIKE 'pactmark_%'
         LOOP
           EXECUTE format(
             'DROP POLICY IF EXISTS pactmark_tenant_isolation ON %I.%I',
             tenant_table.table_schema,
             tenant_table.table_name
           );
           EXECUTE format(
             'ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY',
             tenant_table.table_schema,
             tenant_table.table_name
           );
         END LOOP;
       END $migration$;`,
    ],
  }),
]);

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS pactmark_schema_migrations (
  version text PRIMARY KEY, description text NOT NULL, migration_digest text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
)`;

export class PostgresMigrationManager implements MigrationManager {
  constructor(
    readonly database: PostgresDatabase,
    readonly migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS,
  ) {
    const versions = migrations.map(({ version }) => version);
    if (
      new Set(versions).size !== versions.length ||
      versions.some((version, index) => index > 0 && version <= (versions[index - 1] ?? ""))
    ) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "migrations", issue: "versions_not_strictly_increasing" },
      });
    }
  }

  async status(): Promise<Readonly<{ currentVersion: string; pending: readonly string[] }>> {
    await this.database.query(BOOTSTRAP);
    const applied = await this.database.query<{ version: string; migration_digest: string }>(
      "SELECT version,migration_digest FROM pactmark_schema_migrations ORDER BY version",
    );
    validateAppliedMigrations(applied.rows, this.migrations);
    const versions = new Set(applied.rows.map((row) => row.version));
    const pending = this.migrations
      .filter((migration) => !versions.has(migration.version))
      .map((migration) => migration.version);
    return { currentVersion: applied.rows.at(-1)?.version ?? "000", pending };
  }

  async migrate(targetVersion?: string): Promise<void> {
    const knownTarget = targetVersion ?? this.migrations.at(-1)?.version ?? "000";
    if (knownTarget !== "000" && !this.migrations.some(({ version }) => version === knownTarget)) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "targetVersion", issue: "unknown" },
      });
    }
    await this.database.query(BOOTSTRAP);
    await withTransaction(this.database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pactmark:migrations'))");
      const applied = await client.query<{ version: string; migration_digest: string }>(
        "SELECT version,migration_digest FROM pactmark_schema_migrations ORDER BY version FOR UPDATE",
      );
      validateAppliedMigrations(applied.rows, this.migrations);
      const currentVersion = applied.rows.at(-1)?.version ?? "000";
      if (knownTarget < currentVersion) {
        throw new KafError("KAF_SCHEMA_INVALID", {
          details: { path: "targetVersion", issue: "unsafe_downgrade_not_supported" },
        });
      }
      const versions = new Set(applied.rows.map((row) => row.version));
      for (const migration of this.migrations) {
        if (migration.version > knownTarget) break;
        if (versions.has(migration.version)) continue;
        await applyMigration(client, migration);
      }
    });
  }
}

async function applyMigration(client: PostgresClient, migration: PostgresMigration): Promise<void> {
  try {
    for (const statement of migration.up) await client.query(statement);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("PACTMARK_MIGRATION_006_INCOMPATIBLE_POPULATED_SKELETON_TABLES") ||
        error.message.includes("PACTMARK_MIGRATION_007_INCOMPATIBLE_UNBOUND_WAKEUPS"))
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: {
          reason: error.message.includes("MIGRATION_007")
            ? "migration_007_incompatible_unbound_wakeups"
            : "migration_006_incompatible_populated_skeleton_tables",
          version: migration.version,
        },
      });
    }
    throw error;
  }
  await client.query(
    "INSERT INTO pactmark_schema_migrations (version, description, migration_digest) VALUES ($1, $2, $3)",
    [migration.version, migration.description, migrationDigest(migration)],
  );
}

function validateAppliedMigrations(
  applied: readonly Readonly<{ version: string; migration_digest: string }>[],
  migrations: readonly PostgresMigration[],
): void {
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = known.get(row.version);
    if (migration === undefined) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "schema_migrations", issue: "unknown_applied_version" },
      });
    }
    if (row.migration_digest !== migrationDigest(migration)) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "applied_migration_digest_changed", version: row.version },
      });
    }
  }
}

function migrationDigest(migration: PostgresMigration): string {
  return digestCanonicalJson({
    version: migration.version,
    description: migration.description,
    reversibleSafe: migration.reversibleSafe,
    up: migration.up,
    down: migration.down,
  });
}
