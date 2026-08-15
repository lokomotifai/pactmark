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
