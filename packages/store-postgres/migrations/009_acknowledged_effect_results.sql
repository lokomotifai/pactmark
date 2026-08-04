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
