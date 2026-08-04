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
