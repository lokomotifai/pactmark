-- Full aggregate records for grants, decision gates/challenges, approvals, and one-use claims.
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
  PRIMARY KEY (tenant_id,grant_id,authorization_key),
  UNIQUE (tenant_id,grant_id,use_number),
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
