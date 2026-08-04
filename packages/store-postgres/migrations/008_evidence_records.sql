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
