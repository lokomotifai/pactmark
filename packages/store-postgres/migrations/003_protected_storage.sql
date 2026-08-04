-- Generated from POSTGRES_PROTECTED_STORAGE_SCHEMA_SQL. Keep version 003 immutable after release.
CREATE TABLE pactmark_protection_key_counters (
  namespace_id text NOT NULL, key_id text NOT NULL,
  invocation_count bigint NOT NULL CHECK (invocation_count >= 0),
  invocation_ceiling bigint NOT NULL CHECK (invocation_ceiling > 0),
  PRIMARY KEY (key_id),
  CHECK (invocation_count <= invocation_ceiling)
);
CREATE TABLE pactmark_protection_nonces (
  namespace_id text NOT NULL, key_id text NOT NULL, nonce bytea NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (key_id,nonce),
  CHECK (octet_length(nonce) = 12),
  FOREIGN KEY (key_id) REFERENCES pactmark_protection_key_counters(key_id)
);
