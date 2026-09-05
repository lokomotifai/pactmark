CREATE FUNCTION pactmark_require_run_work_order_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
  FROM pactmark_work_orders
  WHERE tenant_id=NEW.tenant_id
    AND work_order_id=NEW.work_order_id
    AND work_order_binding_digest=NEW.work_order_binding_digest
    AND execution_definition_digest=NEW.execution_definition_digest
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pactmark run WorkOrder parent binding is missing or changed'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pactmark_run_work_orders_require_parent
  BEFORE INSERT ON pactmark_run_work_orders
  FOR EACH ROW EXECUTE FUNCTION pactmark_require_run_work_order_parent();

ALTER TABLE pactmark_run_work_orders
  DROP CONSTRAINT pactmark_run_work_orders_tenant_id_work_order_id_fkey;

ALTER TABLE pactmark_wakeups
  DROP CONSTRAINT pactmark_wakeups_worker_binding_fk,
  ADD CONSTRAINT pactmark_wakeups_run_work_order_binding_fk
    FOREIGN KEY (tenant_id,run_id,work_order_id)
    REFERENCES pactmark_run_work_orders(tenant_id,run_id,work_order_id);
