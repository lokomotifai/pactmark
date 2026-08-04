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
  PRIMARY KEY (tenant_id,reservation_id),
  CHECK ((state = 'released') = (released_at IS NOT NULL))
);
CREATE UNIQUE INDEX pactmark_admission_command_unique
  ON pactmark_admission_reservations
  (tenant_id,principal_type,principal_id,command_id,category,resource_key)
  WHERE command_id IS NOT NULL;
CREATE INDEX pactmark_admission_counter_idx
  ON pactmark_admission_reservations
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
CREATE INDEX pactmark_active_execution_expiry_idx
  ON pactmark_active_execution_reservations (state,expires_at,tenant_id);

CREATE TABLE pactmark_model_call_reservations (
  tenant_id text NOT NULL, run_id text NOT NULL, step_id text NOT NULL, attempt bigint NOT NULL CHECK (attempt > 0),
  reservation_id text NOT NULL, provider_key text NOT NULL, maximum_tokens bigint NOT NULL CHECK (maximum_tokens > 0),
  maximum_io_bytes bigint NOT NULL CHECK (maximum_io_bytes > 0), maximum_cost_minor bigint,
  currency text, state text NOT NULL CHECK (state IN ('accepted','dispatched','settled','uncertain','expired')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, canonical_digest text NOT NULL,
  reservation_json jsonb NOT NULL, PRIMARY KEY (tenant_id,run_id,step_id,attempt),
  UNIQUE (tenant_id,reservation_id),
  CHECK ((maximum_cost_minor IS NULL) = (currency IS NULL)),
  CHECK (maximum_cost_minor IS NULL OR maximum_cost_minor >= 0)
);
CREATE INDEX pactmark_model_call_quota_idx
  ON pactmark_model_call_reservations (tenant_id,provider_key,state,expires_at);

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
  canonical_digest text NOT NULL, state_json jsonb NOT NULL,
  PRIMARY KEY (tenant_id,provider_key),
  CHECK ((probe_lease_id IS NULL) = (probe_fencing_token IS NULL)),
  CHECK (probe_fencing_token IS NULL OR probe_fencing_token >= 0),
  CHECK (state <> 'half_open' OR probe_lease_id IS NOT NULL)
);
