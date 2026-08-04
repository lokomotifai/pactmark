-- Durable authorization reservations and effect-ledger state for the aggregate UOW.
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
