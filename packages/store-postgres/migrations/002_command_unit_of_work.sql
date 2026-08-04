-- Durable aggregate command transaction support.
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
