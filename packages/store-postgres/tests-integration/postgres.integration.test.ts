import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCommandContext,
  digestCanonicalJson,
  type ActiveExecutionReservation,
  type AuthorizationReservation,
  type CommandScope,
  type DataProtector,
} from "@pactmark/core";

import {
  Aes256GcmDataProtector,
  createPostgresDatabase,
  createPostgresStoreSuite,
  createPostgresStorageSecurityProfile,
  PostgresEventStore,
  PostgresEvidenceRecordStore,
  PostgresMigrationManager,
  PostgresProtectionNonceRegistry,
  PostgresPatternRecordStore,
  PostgresVerificationRecordStore,
  POSTGRES_INITIAL_SCHEMA_SQL,
  POSTGRES_COMMAND_UOW_SCHEMA_SQL,
  POSTGRES_RESOURCE_RESERVATIONS_SCHEMA_SQL,
  POSTGRES_WORKER_QUEUE_METADATA_SCHEMA_SQL,
  putActiveExecutionReservation,
  toPgPoolConfig,
  type PostgresConnectionConfig,
  type PostgresDatabase,
} from "../src/index.js";
import {
  acceptedWorkOrder,
  acknowledgedEffect,
  acknowledgedEffectResult,
  evidenceRecord,
  patternRecord,
  protectedEffectResult,
  runAccepted,
  verificationRecord,
} from "../tests/fixtures.js";
import { digest, instant } from "../tests/fixtures.js";

const connectionString = process.env.PACTMARK_TEST_POSTGRES_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error(
    "PACTMARK_TEST_POSTGRES_URL must name a disposable PostgreSQL database for the integration gate.",
  );
}

const tlsMode = process.env.PACTMARK_TEST_POSTGRES_TLS ?? "verify-full";
const integrationTenantSuffix = randomUUID();
const integrationTenants = [
  "tenant-a",
  "other-tenant",
  `tenant-effect-${integrationTenantSuffix}`,
  `tenant-quota-${integrationTenantSuffix}`,
  `tenant-active-race-${integrationTenantSuffix}`,
  `tenant-active-clock-${integrationTenantSuffix}`,
  `tenant-active-uow-${integrationTenantSuffix}`,
] as const;
const connection: PostgresConnectionConfig =
  tlsMode === "disable"
    ? { profile: "development", connectionString, ssl: { mode: "disable" } }
    : {
        profile: "production",
        connectionString,
        ssl: {
          mode: "verify-full",
          ...(process.env.PACTMARK_TEST_POSTGRES_CA === undefined
            ? {}
            : { ca: process.env.PACTMARK_TEST_POSTGRES_CA }),
        },
      };

describe("real PostgreSQL durability", () => {
  let database: PostgresDatabase;
  let store: PostgresEventStore;

  beforeAll(async () => {
    database = createPostgresDatabase(toPgPoolConfig(connection));
    await new PostgresMigrationManager(database).migrate();
    store = new PostgresEventStore(database, integrationStorageProfile());
  });

  afterAll(async () => {
    await database.end?.();
  });

  it("persists one tenant stream and reconstructs its projection in a later store instance", async () => {
    const suffix = randomUUID();
    const event = runAccepted({
      eventId: `event-${suffix}`,
      runId: `run-${suffix}`,
      correlationId: `correlation-${suffix}`,
    });
    await expect(store.append(event, 0)).resolves.toEqual({ sequence: 1, replayed: false });
    await expect(store.append(event, 0)).resolves.toEqual({ sequence: 1, replayed: true });

    const freshStore = new PostgresEventStore(database, integrationStorageProfile());
    const projection = await freshStore.getProjection(event.tenantId, event.runId);
    expect(projection).toMatchObject({
      tenantId: event.tenantId,
      runId: event.runId,
      lastSequence: 1,
    });
    await expect(collect(freshStore.read("other-tenant", event.runId))).resolves.toEqual([]);
  });

  it("persists immutable evidence records and reloads them through fresh store instances", async () => {
    const suffix = randomUUID();
    const profile = integrationStorageProfile();
    const baseEvidence = evidenceRecord();
    const { evidenceDigest: _evidenceDigest, ...evidenceMaterial } = {
      ...baseEvidence,
      evidenceRecordId: `evidence-${suffix}`,
      runId: `run-${suffix}`,
    };
    void _evidenceDigest;
    const evidence = {
      ...evidenceMaterial,
      evidenceDigest: digestCanonicalJson(evidenceMaterial),
    };
    const baseVerification = verificationRecord("tenant-a", `run-${suffix}`);
    const { verificationDigest: _verificationDigest, ...verificationMaterial } = {
      ...baseVerification.verification,
      verificationId: `verification-${suffix}`,
    };
    void _verificationDigest;
    const verification = {
      ...baseVerification,
      verification: {
        ...verificationMaterial,
        verificationDigest: digestCanonicalJson(verificationMaterial),
      },
    };
    const basePattern = patternRecord();
    const { patternDigest: _patternDigest, ...patternMaterial } = {
      ...basePattern.pattern,
      patternId: `pattern-${suffix}`,
    };
    void _patternDigest;
    const pattern = {
      ...basePattern,
      pattern: { ...patternMaterial, patternDigest: digestCanonicalJson(patternMaterial) },
    };

    await new PostgresEvidenceRecordStore(database, profile).putImmutable(evidence);
    await new PostgresVerificationRecordStore(database, profile).putImmutable(verification);
    await new PostgresPatternRecordStore(database, profile).putImmutable(pattern);

    const reloadedEvidence = new PostgresEvidenceRecordStore(database, profile);
    const reloadedVerification = new PostgresVerificationRecordStore(database, profile);
    const reloadedPattern = new PostgresPatternRecordStore(database, profile);
    await expect(reloadedEvidence.get("tenant-a", evidence.evidenceRecordId)).resolves.toEqual(
      evidence,
    );
    await expect(
      reloadedVerification.get(
        "tenant-a",
        verification.runId,
        verification.verification.verificationId,
      ),
    ).resolves.toEqual(verification);
    await expect(
      reloadedPattern.get("tenant-a", pattern.pattern.patternId, pattern.pattern.version),
    ).resolves.toEqual(pattern);
    await expect(
      reloadedEvidence.get("other-tenant", evidence.evidenceRecordId),
    ).resolves.toBeUndefined();
    await expect(
      database.query(
        "DELETE FROM pactmark_evidence_records WHERE tenant_id=$1 AND evidence_record_id=$2",
        ["tenant-a", evidence.evidenceRecordId],
      ),
    ).rejects.toThrow("pactmark immutable record cannot be updated");
  });

  it("atomically persists a durable command record and deduplicated wakeup", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const commandId = `kafcmd_1722680000000_${suffix.slice(0, 32)}`;
    const runId = `run-${suffix}`;
    const scope: CommandScope = {
      issuerId: "integration-issuer",
      tenant: { id: "tenant-a" },
      principal: { type: "service", id: "integration-service" },
      operation: "resume",
      normalizedResourceScope: [],
      commandId,
    };
    const context = createCommandContext({ commandId, operation: "resume", payload: { runId } });
    const suite = createPostgresStoreSuite(database, {
      securityProfile: integrationStorageProfile(),
      dataProtector: integrationProtector(database, suffix),
      now: () => instant,
      generateWakeupId: () => `wakeup-${suffix}`,
    });
    const execute = () =>
      suite.runCommandUnitOfWork.transactCommand(scope, context, async (transaction) => {
        await transaction.putAcceptedWorkOrder(acceptedWorkOrder({ id: `work-${suffix}` }));
        await transaction.enqueueWakeup({
          schemaVersion: "1",
          tenantId: "tenant-a",
          runId,
          reason: "resume",
          notBefore: instant,
          deduplicationKey: `${runId}:resume`,
          payload: {},
        });
        await transaction.putCommandRecord({
          schemaVersion: "1",
          scope,
          requestDigest: context.requestDigest,
          status: "committed",
          resultReference: { kind: "run", runId },
          safeResponseDigest: digest(`response:${suffix}`),
          firstSeenAt: instant,
          committedAt: instant,
          detailRetentionExpiresAt: "2026-08-04T00:00:00.000Z",
          idempotencyExpiresAt: "2026-08-05T00:00:00.000Z",
        });
        return { runId };
      });
    await expect(execute()).resolves.toMatchObject({ replayed: false, value: { runId } });
    await expect(execute()).resolves.toMatchObject({ replayed: true, value: { runId } });
    const wakeups = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pactmark_wakeups WHERE tenant_id=$1 AND deduplication_key=$2",
      ["tenant-a", `${runId}:resume`],
    );
    expect(wakeups.rows[0]?.count).toBe("1");
  });

  it("atomically persists, reloads, and tamper-detects a protected acknowledged effect result", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const tenantId = `tenant-effect-${integrationTenantSuffix}`;
    const runId = `run-effect-${suffix}`;
    const effectId = `effect-${suffix}`;
    const protector = integrationProtector(database, `effect-${suffix}`);
    const seedSuite = createPostgresStoreSuite(database, {
      securityProfile: integrationStorageProfile(),
      dataProtector: compactReferenceProtector(`effect-seed-${suffix}`),
    });
    const workOrder = acceptedWorkOrder({ tenant: { id: tenantId } });
    const accepted = runAccepted({
      eventId: `event-effect-${suffix}`,
      tenantId,
      runId,
      correlationId: `correlation-effect-${suffix}`,
      dataClass: workOrder.dataClass,
      payload: {
        workOrderId: workOrder.id,
        workOrderBindingDigest: workOrder.workOrderBindingDigest,
        requiredVerifierIds: [],
      },
    });
    await seedSuite.acceptedWorkOrderStore.putImmutable(workOrder);
    await seedSuite.eventStore.append(accepted, 0);
    await database.query(
      `INSERT INTO pactmark_run_work_orders
       (tenant_id,run_id,work_order_id,work_order_binding_digest,execution_definition_digest)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        tenantId,
        runId,
        workOrder.id,
        workOrder.workOrderBindingDigest,
        workOrder.executionDefinitionDigest,
      ],
    );
    const suite = createPostgresStoreSuite(database, {
      securityProfile: integrationStorageProfile(),
      dataProtector: protector,
    });
    const effect = acknowledgedEffect({ tenantId, runId, effectId });
    const resultRecord = await protectedEffectResult(protector, effect);
    const reservation: AuthorizationReservation = {
      schemaVersion: "1",
      authorizationReservationId: effect.authorizationReservationId,
      authorizationKey: effect.effectKey,
      tenantId,
      runId,
      stepId: effect.stepId,
      toolCallId: effect.toolCallId,
      effectKey: effect.effectKey,
      workOrderBindingDigest: effect.workOrderBindingDigest,
      executionDefinition: effect.executionDefinition,
      executionDefinitionDigest: effect.executionDefinitionDigest,
      toolId: effect.toolId,
      toolVersion: effect.toolVersion,
      toolRegistrationDigest: effect.toolRegistrationDigest,
      policyRegistrationDigest: digest("policy-registration"),
      argumentsDigest: effect.argumentsDigest,
      normalizedTargetDigest: effect.normalizedTargetDigest,
      grantId: `grant-${suffix}`,
      secretRefIds: [],
      purposeCode: workOrder.purpose.code,
      purposeRegistryVersion: workOrder.purpose.registryVersion,
      state: "reserved",
      createdAt: instant,
      expiresAt: "2026-08-03T11:00:00.000Z",
    };
    const transition = (key: string) => ({
      schemaVersion: "1" as const,
      tenantId,
      runId,
      transitionKind: "EffectAcknowledged",
      transitionKey: key,
      workOrderBindingDigest: workOrder.workOrderBindingDigest,
      executionDefinitionDigest: workOrder.executionDefinitionDigest,
    });

    await expect(
      suite.runCommandUnitOfWork.transactTransition(
        transition(`${effectId}:rollback`),
        async (transaction) => {
          await transaction.putAuthorizationReservation(reservation);
          await transaction.putEffectRecord(effect);
          await transaction.putProtectedEffectResult(resultRecord);
          throw new Error("crash-after-effect-result");
        },
      ),
    ).rejects.toThrow("crash-after-effect-result");
    await expect(
      database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pactmark_acknowledged_effect_results
         WHERE tenant_id=$1 AND run_id=$2 AND effect_id=$3`,
        [tenantId, runId, effectId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });

    await expect(
      suite.runCommandUnitOfWork.transactTransition(
        transition(`${effectId}:wrong-work-order`),
        async (transaction) => {
          await transaction.putAuthorizationReservation(reservation);
          await transaction.putEffectRecord(effect);
          await transaction.putProtectedEffectResult({
            ...resultRecord,
            purposeCode: "wrong-purpose",
          });
          return null;
        },
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    await suite.runCommandUnitOfWork.transactTransition(
      transition(`${effectId}:commit`),
      async (transaction) => {
        await transaction.putAuthorizationReservation(reservation);
        await transaction.putEffectRecord(effect);
        await transaction.putProtectedEffectResult(resultRecord);
        return null;
      },
    );
    const replayWithFreshCiphertext = await protectedEffectResult(protector, effect);
    await suite.acknowledgedEffectResultStore.putImmutable(replayWithFreshCiphertext);

    const freshSuite = createPostgresStoreSuite(database, {
      securityProfile: integrationStorageProfile(),
      dataProtector: integrationProtector(database, `effect-${suffix}`),
    });
    const reloadedEffect = await freshSuite.effectLedger.getByEffectId(tenantId, runId, effectId);
    if (reloadedEffect === undefined) throw new Error("integration effect missing");
    await expect(freshSuite.effectLedger.getAcknowledgedResult(reloadedEffect)).resolves.toEqual(
      acknowledgedEffectResult,
    );
    await expect(
      freshSuite.effectLedger.getByEffectId("other-tenant", runId, effectId),
    ).resolves.toBeUndefined();
    const plaintextScan = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pactmark_acknowledged_effect_results
       WHERE tenant_id=$1 AND record_json::text LIKE '%PLAINTEXT-EFFECT-RESULT-CANARY%'`,
      [tenantId],
    );
    expect(plaintextScan.rows[0]?.count).toBe("0");
    await expect(
      database.query(
        `DELETE FROM pactmark_acknowledged_effect_results
         WHERE tenant_id=$1 AND run_id=$2 AND effect_id=$3`,
        [tenantId, runId, effectId],
      ),
    ).rejects.toThrow("pactmark immutable record cannot be updated");

    const tampered = { ...resultRecord, purposeCode: "tampered-purpose" };
    try {
      await database.query("ALTER TABLE pactmark_acknowledged_effect_results DISABLE TRIGGER USER");
      await database.query(
        `UPDATE pactmark_acknowledged_effect_results
         SET purpose_code=$1,canonical_digest=$2,record_json=$3::jsonb
         WHERE tenant_id=$4 AND run_id=$5 AND effect_id=$6`,
        [
          tampered.purposeCode,
          digestCanonicalJson(tampered),
          JSON.stringify(tampered),
          tenantId,
          runId,
          effectId,
        ],
      );
    } finally {
      await database.query("ALTER TABLE pactmark_acknowledged_effect_results ENABLE TRIGGER USER");
    }
    await expect(
      freshSuite.effectLedger.getAcknowledgedResult(reloadedEffect),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_SECURITY_PROFILE" });
  });

  it("reserves nonces durably and decrypts AES-GCM ciphertext with full AAD", async () => {
    const suffix = randomUUID();
    const key = { keyId: `integration-key-${suffix}`, key: new Uint8Array(32).fill(13) };
    const protector = new Aes256GcmDataProtector({
      keyProvider: {
        current: () => Promise.resolve(key),
        resolve: (keyId) => Promise.resolve(keyId === key.keyId ? key : undefined),
      },
      nonceRegistry: new PostgresProtectionNonceRegistry(database),
      namespace: `integration-${suffix}`,
      invocationCeiling: 2,
    });
    const binding = {
      tenantId: "tenant-a",
      recordId: `context-${suffix}`,
      storeKind: "context",
      schemaVersion: "1",
      purposeCode: "integration",
      dataClass: "confidential",
      runId: `run-${suffix}`,
    };
    const plaintext = new TextEncoder().encode("integration protected context");
    const reference = await protector.protect(binding, plaintext);
    await expect(protector.unprotect(binding, reference)).resolves.toEqual(plaintext);
    const reservations = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pactmark_protection_nonces
       WHERE namespace_id=$1 AND key_id=$2`,
      [`integration-${suffix}`, key.keyId],
    );
    expect(reservations.rows[0]?.count).toBe("1");
  });

  it("fails migration 006 before deleting populated 001-era reservation state", async () => {
    const client = await database.connect();
    const schema = `pactmark_upgrade_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(POSTGRES_INITIAL_SCHEMA_SQL);
      await client.query(
        `INSERT INTO pactmark_admission_reservations
         (tenant_id,reservation_id,command_key,counter_kind,amount,lease_expires_at)
         VALUES ('tenant-a','legacy-reservation','legacy-command','request_start',1,
           clock_timestamp() + interval '1 hour')`,
      );
      await expect(client.query(POSTGRES_RESOURCE_RESERVATIONS_SCHEMA_SQL)).rejects.toThrow(
        "PACTMARK_MIGRATION_006_INCOMPATIBLE_POPULATED_SKELETON_TABLES",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("serializes a tenant-wide admission ceiling across 100 distinct principals", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const tenantId = `tenant-quota-${integrationTenantSuffix}`;
    const resourceKey = `agent:${suffix}`;
    const suite = createPostgresStoreSuite(database, {
      securityProfile: integrationStorageProfile(),
      dataProtector: integrationProtector(database, suffix),
      quotaLimits: [
        {
          schemaVersion: "1",
          scope: "tenant",
          metric: "request_start",
          resourceKey,
          maximum: 10,
          retryAfterSeconds: 3,
        },
      ],
    });
    const decisions = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        suite.quotaStore.reserve({
          schemaVersion: "1",
          tenant: { id: tenantId },
          principal: { type: "user", id: `principal-${String(index)}` },
          commandId: `kafcmd_1760000000000_${index.toString(16).padStart(32, "0")}`,
          category: "request_start",
          resourceKey,
          amount: 1,
          leaseDurationMs: 60_000,
        }),
      ),
    );
    expect(decisions.filter((decision) => decision.admitted)).toHaveLength(10);
    expect(decisions.filter((decision) => !decision.admitted)).toHaveLength(90);
    const stored = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pactmark_admission_reservations
       WHERE tenant_id=$1 AND resource_key=$2 AND state='reserved'`,
      [tenantId, resourceKey],
    );
    expect(stored.rows[0]?.count).toBe("10");
  });

  it("serializes 100 active-execution reservations against one tenant-run budget", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const tenantId = `tenant-active-race-${integrationTenantSuffix}`;
    const runId = `run-active-race-${suffix}`;
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        activeExecutionTransaction(database, (client) =>
          putActiveExecutionReservation(
            client,
            tenantId,
            activeReservation({
              tenantId,
              runId,
              id: `active-race-${String(index)}`,
              stepId: `step-${String(index)}`,
              boundaryKey: `boundary-${String(index)}`,
              maxChargeMs: 2,
            }),
            100,
          ),
        ),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(50);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(50);
    const aggregate = await database.query<{ consumed: string }>(
      `SELECT COALESCE(SUM(
         CASE WHEN state='settled' THEN settled_charge_ms ELSE max_charge_ms END
       ),0)::text AS consumed
       FROM pactmark_active_execution_reservations
       WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, runId],
    );
    expect(aggregate.rows[0]?.consumed).toBe("100");
  });

  it("uses PostgreSQL time for active reserve/settle and maximum crash closure", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const tenantId = `tenant-active-clock-${integrationTenantSuffix}`;
    const runId = `run-active-clock-${suffix}`;
    const requested = activeReservation({
      tenantId,
      runId,
      id: `active-clock-${suffix}`,
      stepId: "step-clock",
      boundaryKey: "boundary-clock",
      maxChargeMs: 10_000,
    });
    const reserved = await activeExecutionTransaction(database, (client) =>
      putActiveExecutionReservation(client, tenantId, requested, 20_000),
    );
    expect(reserved.startedAtServerTime).not.toBe(requested.startedAtServerTime);
    expect(Date.parse(reserved.expiresAt) - Date.parse(reserved.startedAtServerTime)).toBe(10_000);
    await database.query("SELECT pg_sleep(0.02)");
    const settled = await activeExecutionTransaction(database, (client) =>
      putActiveExecutionReservation(
        client,
        tenantId,
        {
          ...reserved,
          state: "settled",
          settledChargeMs: 0,
          refundedMs: reserved.maxChargeMs,
          settledAtServerTime: "2099-01-01T00:00:00.000Z",
        },
        20_000,
      ),
    );
    expect(settled.settledChargeMs).toBeGreaterThan(0);
    expect(settled.settledChargeMs).toBeLessThanOrEqual(reserved.maxChargeMs);
    expect(settled.refundedMs).toBe(reserved.maxChargeMs - (settled.settledChargeMs ?? 0));
    expect(settled.settledAtServerTime).not.toBe("2099-01-01T00:00:00.000Z");

    const crashRequested = activeReservation({
      tenantId,
      runId: `${runId}-crash`,
      id: `active-crash-${suffix}`,
      stepId: "step-crash",
      boundaryKey: "boundary-crash",
      maxChargeMs: 50,
    });
    const crashReserved = await activeExecutionTransaction(database, (client) =>
      putActiveExecutionReservation(client, tenantId, crashRequested, 50),
    );
    const closed = await activeExecutionTransaction(database, (client) =>
      putActiveExecutionReservation(
        client,
        tenantId,
        {
          ...crashReserved,
          state: "closed_uncertain",
          settledChargeMs: crashReserved.maxChargeMs,
          refundedMs: 0,
          settledAtServerTime: "2000-01-01T00:00:00.000Z",
        },
        50,
      ),
    );
    expect(closed).toMatchObject({
      state: "closed_uncertain",
      settledChargeMs: 50,
      refundedMs: 0,
    });
    expect(closed.settledAtServerTime).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("binds the UOW active-execution ceiling to the persisted WorkOrder budget", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const tenantId = `tenant-active-uow-${integrationTenantSuffix}`;
    const runId = `run-active-uow-${suffix}`;
    const workOrder = acceptedWorkOrder({ tenant: { id: tenantId } });
    const suite = createPostgresStoreSuite(database, {
      securityProfile: integrationStorageProfile(),
      dataProtector: compactReferenceProtector(`active-uow-${suffix}`),
    });
    await suite.acceptedWorkOrderStore.putImmutable(workOrder);
    const accepted = runAccepted({
      eventId: `event-active-uow-${suffix}`,
      tenantId,
      runId,
      correlationId: `correlation-active-uow-${suffix}`,
      dataClass: workOrder.dataClass,
      payload: {
        workOrderId: workOrder.id,
        workOrderBindingDigest: workOrder.workOrderBindingDigest,
        requiredVerifierIds: [],
      },
    });
    await suite.eventStore.append(accepted, 0);
    await database.query(
      `INSERT INTO pactmark_run_work_orders
       (tenant_id,run_id,work_order_id,work_order_binding_digest,execution_definition_digest)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        tenantId,
        runId,
        workOrder.id,
        workOrder.workOrderBindingDigest,
        workOrder.executionDefinitionDigest,
      ],
    );
    const reservation = activeReservation({
      tenantId,
      runId,
      id: `active-uow-${suffix}`,
      stepId: "step-uow",
      boundaryKey: "boundary-uow",
      maxChargeMs: 10,
    });
    const transition = (transitionKey: string, maximum: number) =>
      suite.runCommandUnitOfWork.transactTransition(
        {
          schemaVersion: "1",
          tenantId,
          runId,
          transitionKind: "active_execution_reservation",
          transitionKey,
          workOrderBindingDigest: workOrder.workOrderBindingDigest,
          executionDefinitionDigest: workOrder.executionDefinitionDigest,
        },
        (transaction) => transaction.putActiveExecutionReservation(reservation, maximum),
      );
    await expect(
      transition("active-uow-wrong-budget", workOrder.budget.maxActiveExecutionMs + 1),
    ).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
      details: { reason: "active_execution_work_order_budget_binding_changed" },
    });
    await expect(
      transition("active-uow-correct-budget", workOrder.budget.maxActiveExecutionMs),
    ).resolves.toMatchObject({ state: "reserved", maxChargeMs: 10 });
  });

  it("fails migration 007 before changing an unbound legacy wakeup", async () => {
    const client = await database.connect();
    const schema = `pactmark_worker_upgrade_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(POSTGRES_INITIAL_SCHEMA_SQL);
      await client.query(POSTGRES_COMMAND_UOW_SCHEMA_SQL);
      await client.query(
        `INSERT INTO pactmark_wakeups
         (tenant_id,run_id,wakeup_id,deduplication_key,delegation_json,available_at,state,request_digest)
         VALUES ('tenant-a','run-legacy','wakeup-legacy','legacy-command','{}'::jsonb,
           clock_timestamp(),'pending','${digest("legacy-request")}')`,
      );
      await expect(client.query(POSTGRES_WORKER_QUEUE_METADATA_SCHEMA_SQL)).rejects.toThrow(
        "PACTMARK_MIGRATION_007_INCOMPATIBLE_UNBOUND_WAKEUPS",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

function integrationStorageProfile() {
  return createPostgresStorageSecurityProfile({
    transportMode: tlsMode === "disable" ? "development-plaintext" : "verify-full",
    allowedTenants: integrationTenants,
    allowedPurposes: ["support"],
  });
}

function integrationProtector(database: PostgresDatabase, suffix: string) {
  const key = { keyId: `uow-key-${suffix}`, key: new Uint8Array(32).fill(17) };
  return new Aes256GcmDataProtector({
    keyProvider: {
      current: () => Promise.resolve(key),
      resolve: (keyId) => Promise.resolve(keyId === key.keyId ? key : undefined),
    },
    nonceRegistry: new PostgresProtectionNonceRegistry(database),
    namespace: `uow-${suffix}`,
  });
}

function compactReferenceProtector(suffix: string): DataProtector {
  return {
    protect: (binding, plaintext) =>
      Promise.resolve({
        schemaVersion: "1",
        protectorId: "integration.external-reference",
        keyId: `external-key-${suffix}`,
        ciphertextRef: `external-ref-${suffix}`,
        ciphertextDigest: digestCanonicalJson([...plaintext]),
        aadDigest: digestCanonicalJson(binding),
        algorithm: "external-test-reference",
      }),
    unprotect: () => Promise.reject(new Error("integration seed value is not read")),
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of iterable) output.push(value);
  return output;
}

function activeReservation(input: {
  readonly tenantId: string;
  readonly runId: string;
  readonly id: string;
  readonly stepId: string;
  readonly boundaryKey: string;
  readonly maxChargeMs: number;
}): ActiveExecutionReservation {
  return {
    schemaVersion: "1",
    id: input.id,
    tenant: { id: input.tenantId },
    runId: input.runId,
    stepId: input.stepId,
    boundary: "tool",
    boundaryKey: input.boundaryKey,
    leaseId: `lease-${input.id}`,
    fencingToken: 1,
    startedAtServerTime: "2000-01-01T00:00:00.000Z",
    maxChargeMs: input.maxChargeMs,
    state: "reserved",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

async function activeExecutionTransaction<T>(
  database: PostgresDatabase,
  operation: (client: Awaited<ReturnType<PostgresDatabase["connect"]>>) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
