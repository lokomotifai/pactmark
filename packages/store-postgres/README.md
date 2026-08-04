# `@pactmark/store-postgres`

Durable, tenant-scoped PostgreSQL storage adapters for Pactmark. This package implements event and rebuildable projection storage, immutable accepted WorkOrders, protected input/context records, bounded artifacts, fenced run leases, and explicit migrations.

`PostgresRunCommandUnitOfWork` commits the supported aggregate slice—full-scope
idempotent `CommandRecord`, protected accepted WorkOrder, event/projection,
deduplicated durable wakeup, grants and approvals, admission reservations,
active-execution and model-call reservations, authorization reservation, effect
ledger, and transition fencing—on one `withTransaction` client. Protected input submission
uses that same client. It advertises `atomicCommandAndWakeup: true`. Generic
callback results must be JSON values so they can be replayed after process loss.
The exported `PostgresEffectLedger` reads the same tenant-scoped rows used by
the runtime. Reservation/effect bindings, unique effect/operation keys, effect
digests, and state transitions fail closed before commit. Admission and model
quota limits have an explicit `tenant` or `principal` scope. PostgreSQL advisory
transaction locks serialize each applicable tenant/resource counter, while
same-command replay returns the exact prior reservation and changed replay fails
closed. Circuit-breaker updates use compare-and-set with fenced half-open probes.

Migration `006` replaces the unreleased `001` reservation skeletons. It upgrades
empty skeleton tables. If any old skeleton contains rows, migration stops before
the first drop with the stable incompatibility reason
`migration_006_incompatible_populated_skeleton_tables`; operators must explicitly
reconcile that legacy state instead of losing it silently.

Migration `007` binds every durable wakeup to immutable, tenant-scoped run and
accepted-WorkOrder metadata required by the worker. It persists only the
principal identity, purpose registry version, resource-scope ceiling, and
execution-definition binding; goal, input, challenge proof, and credentials are
excluded. It also adds claim lease/fence/result consistency constraints and an
expiry index. Because old wakeups cannot be reconstructed safely, the migration
fails before altering the schema when any legacy wakeup exists, with the stable
reason `migration_007_incompatible_unbound_wakeups`. Operators must drain or
explicitly reconcile that state before retrying.

Migration `008` adds append-only `EvidenceRecord`, `VerificationRecord`, and
`PatternRecord` tables. Every primary and digest lookup includes `tenant_id`;
verification identity additionally includes `run_id`, while pattern identity
includes the manifest version. Database triggers reject updates and deletes.
Exact inserts are idempotent, but changed same-key records, invalid embedded
digests, and cross-route digest reuse fail closed. The store suite exposes these
as `evidenceRecordStore`, `verificationRecordStore`, and `patternRecordStore`.
The migration is purely additive: it does not rewrite an existing table or need
a populated-state compatibility preflight. The migration ledger still pins its
canonical digest and applies it exactly once under the existing advisory
transaction lock.

Migration `009` adds immutable protected acknowledged-effect result storage.
The runtime protects the canonical JSON result before the command transaction;
the unit of work then validates the authoritative accepted WorkOrder and exact
effect, definition, tool, strategy, purpose, DataClass, plaintext byte-size, and
result-digest bindings before atomically committing both the acknowledged effect
and protected result. PostgreSQL stores only the protected reference and bound
metadata. A retry with fresh ciphertext for the same semantic identity is
idempotent and does not overwrite the canonical first record; changed reuse
fails closed. Primary, digest, and protected-reference identities all include
`tenant_id`, and an immutable trigger rejects updates and deletes. Reads decrypt
outside SQL and revalidate the complete AAD, canonical JSON, byte size, schema,
and digest before returning a result.

## Security defaults

Production connections accept only `ssl.mode: "verify-full"`. The adapter enables certificate-chain and hostname verification and rejects URL-level SSL overrides before constructing a pool. An explicit `ssl.mode: "disable"` is limited to loopback hosts in the `development` profile; it can never represent production readiness. CA bundles are host configuration and must not be placed in events, artifacts, evidence, or logs.

All accepted WorkOrder bodies and confidential/restricted artifact bodies require an injected core `DataProtector`. Durable input and context adapters also refuse writes when no protector is configured. Input submissions and context snapshots contain protected references, not submitted plaintext. Every read and write path includes `tenantId`; persisted JSON is schema-validated and its canonical digest is checked when read.

`Aes256GcmDataProtector` is the reference application protector. It uses a fresh
96-bit CSPRNG nonce, a full 128-bit tag, and AAD containing tenant, record,
store kind, schema, purpose, DataClass, key ID, and all caller-supplied immutable
routing metadata. The host supplies a `DataProtectionKeyProvider`; key bytes are
never stored beside ciphertext. New writes use `current()`, while old
ciphertext is read through `resolve(keyId)`, allowing rotation without rewriting
history. Production must pair it with `PostgresProtectionNonceRegistry`, whose
database primary key enforces global `(key_id, nonce)` uniqueness (the namespace
remains an immutable routing binding) and whose
counter rotates/fails before the configured conservative per-key invocation
ceiling. `MemoryProtectionNonceRegistry` is only for tests and ephemeral preview.

```ts
import {
  Aes256GcmDataProtector,
  PostgresProtectionNonceRegistry,
  createPostgresStoreSuite,
  type DataProtectionKeyProvider,
  type PostgresDatabase,
} from "@pactmark/store-postgres";

export function createProtectedStores(
  database: PostgresDatabase,
  hostKeyProvider: DataProtectionKeyProvider,
) {
  const dataProtector = new Aes256GcmDataProtector({
    keyProvider: hostKeyProvider, // Host KMS/HSM/secret-manager boundary.
    nonceRegistry: new PostgresProtectionNonceRegistry(database),
    invocationCeiling: 1_000_000,
  });
  return createPostgresStoreSuite(database, { dataProtector });
}
```

`PostgresContextStore.putProtected()` protects raw operational context and
stores only its authenticated ciphertext reference/metadata;
`getLatestProtected()` decrypts and rechecks byte size and content digest. The
ordinary core `put()`/`getLatest()` methods remain available for runtimes that
protect through the injected core port before storage. Events never receive the
context body.

```ts
import {
  createPostgresStoreSuiteFromConfig,
  createPostgresStorageSecurityProfile,
} from "@pactmark/store-postgres";
import type { DataProtector } from "@pactmark/core";

export function connectProductionStores(
  databaseUrl: string,
  dataProtector: DataProtector,
  ca?: string,
) {
  return createPostgresStoreSuiteFromConfig(
    {
      profile: "production",
      connectionString: databaseUrl,
      ssl: { mode: "verify-full", ...(ca === undefined ? {} : { ca }) },
      applicationName: "pactmark-worker",
    },
    {
      securityProfile: createPostgresStorageSecurityProfile(),
      dataProtector,
    },
  );
}

// Run stores.migrationManager.migrate() only from operator-controlled tooling.
```

Migrations are never run by `createPostgresStoreSuiteFromConfig` or by request handling. `PostgresMigrationManager.status()` and `.migrate()` are intended for explicit operator tooling.

## Backup, restore, and projection rebuild

The package does not operate managed backups. Operators must configure encrypted PostgreSQL backups, retention, restore access, monitoring, and periodic restore drills for their deployment. A safe restore procedure is:

1. stop writers and workers;
2. restore into an isolated database and validate the migration ledger;
3. check tenant/run event sequence continuity and canonical event digests;
4. leave events untouched, then call `PostgresProjectionRebuilder.rebuild(tenantId, runId)` (or `PostgresEventStore.rebuildProjection`) for each affected stream;
5. compare rebuilt projection/event/artifact digests before directing traffic to the restored database.

Events are append-only run truth; projections are disposable caches. Never repair an invalid event row in place. Restore a verified backup or use a new, audited compensating event if the domain permits it.

Deleting or expiring a protected WorkOrder, input submission, context snapshot, or artifact is final from this adapter’s perspective. `purgeExpired()` methods accept an injected clock through suite options and emit the configured metadata-only `onDelete` hook; they never emit a body or ciphertext. A suspended run whose required protected record is gone must fail closed; the package does not retain a hidden copy.

Backup responsibility remains with the deployer. Backups must include the
schema migration ledger, nonce/counter tables, events, protected records, and
the host's separately managed historical key versions. A database backup
without its authorized historical keys is intentionally undecryptable; keys
must not be copied into the database backup merely for convenience. Restore
drills should test old-key reads, expiry/deletion behavior, and projection
digests before traffic is redirected.

## Inline artifacts

`maxInlineArtifactBytes` defaults to 256 KiB and may be reduced per suite. The migration also enforces a 1 MiB absolute database ceiling. Larger objects should use a separately injected external artifact profile; content is never silently truncated.

## Development and tests

```sh
pnpm --filter @pactmark/store-postgres typecheck
pnpm --filter @pactmark/store-postgres test
pnpm --filter @pactmark/store-postgres build
```

The deterministic unit suite uses a recording database boundary. The integration gate never silently substitutes it for PostgreSQL:

```sh
PACTMARK_TEST_POSTGRES_URL='postgresql://…' \
PACTMARK_TEST_POSTGRES_TLS=verify-full \
PACTMARK_TEST_POSTGRES_CA='…optional private CA PEM…' \
pnpm --filter @pactmark/store-postgres test:integration
```

`PACTMARK_TEST_POSTGRES_URL` must identify a disposable database. `PACTMARK_TEST_POSTGRES_TLS=disable` is accepted only when that URL uses a loopback host and is intended solely for a local service-container gate. A deployment gate must run the shared store contracts against a disposable real PostgreSQL service with hostname-verified TLS before claiming production verification.

The separate TLS matrix creates an ephemeral private CA and an exact
`DNS:localhost` server certificate, starts PostgreSQL 17 on a random loopback
port, and removes the container and temporary key material in `finally`:

```sh
# Explicit bootstrap; the test never pulls an image or falls back to the network.
docker pull postgres:17
openssl version
pnpm test:postgres-tls
```

The host must provide a working Docker daemon, a locally present `postgres:17`
image, OpenSSL, and an available loopback port. The gate proves successful
`verify-full` connection with the explicit private CA and exact hostname. It
also proves wrong-host, untrusted CA, missing CA, production plaintext,
require-only/non-verifying, and `rejectUnauthorized: false` cases fail closed.
It scans captured tooling output, query/error observations, and package
artifacts for a per-run certificate canary. This is a narrowly scoped test gate,
not a claim that a deployment or external CA infrastructure is production-ready.
