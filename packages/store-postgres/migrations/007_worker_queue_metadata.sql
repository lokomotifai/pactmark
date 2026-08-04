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
