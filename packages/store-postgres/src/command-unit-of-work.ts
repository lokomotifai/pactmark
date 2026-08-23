import {
  AcceptedWorkOrderSchema,
  CommandContextSchema,
  CommandRecordSchema,
  CommandScopeSchema,
  ContextSnapshotSchema,
  DurableWakeupReceiptSchema,
  DurableWakeupRequestSchema,
  ProtectedEffectResultRecordSchema,
  JsonValueSchema,
  KafError,
  RunEventSchema,
  RunProjectionSchema,
  RunTransitionKeySchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type CommandContext,
  type CommandRecord,
  type CommandScope,
  type CommandTransactionResult,
  type DataProtector,
  type DurableWakeupReceipt,
  type RunCommandTransaction,
  type RunCommandUnitOfWork,
  type RunEvent,
  type RunProjection,
  type RunTransitionKey,
  type StorageSecurityProfile,
  type QuotaLimit,
} from "@pactmark/core";

import { PostgresStorageGuard } from "./config.js";
import {
  claimApproval,
  consumeDecisionChallenge,
  issueCapabilityGrant,
  putApproval,
  putDecisionChallenge,
  putDecisionGate,
  putDecisionRejection,
  reserveCapabilityGrantUse,
} from "./aggregate-writes.js";
import type { PostgresClient, PostgresDatabase } from "./database.js";
import { withTenantTransaction } from "./database.js";
import {
  PostgresEffectLedger,
  putAuthorizationReservation,
  putEffectRecord,
} from "./effect-ledger.js";
import {
  assertEffectResultRecordBinding,
  PostgresAcknowledgedEffectResultStore,
} from "./acknowledged-effect-results.js";
import { conflict, parseJsonColumn } from "./internal.js";
import {
  PostgresAcceptedWorkOrderStore,
  PostgresContextStore,
  PostgresInputSubmissionStore,
} from "./record-stores.js";
import {
  putActiveExecutionReservation,
  putModelCallReservation,
  reserveAdmission,
} from "./resource-reservations.js";

type CommandRow = {
  scope_json: unknown;
  request_digest: string;
  command_record_json: unknown;
  value_json: unknown;
};
type ProjectionRow = { projection_json: unknown; last_sequence: string | number };
const PersistedTransitionValueSchema = JsonValueSchema.optional().transform(
  (value) => value ?? null,
);

export interface PostgresRunCommandUnitOfWorkOptions {
  readonly securityProfile: StorageSecurityProfile;
  readonly dataProtector?: DataProtector;
  readonly now?: () => string;
  readonly generateWakeupId?: (requestDigest: string) => string;
  readonly quotaLimits?: readonly QuotaLimit[];
}

type StagedOperation =
  | Readonly<{ kind: "event"; event: RunEvent }>
  | Readonly<{ kind: "projection"; projection: RunProjection }>;

function unsupported(operation: string): Promise<never> {
  return Promise.reject(
    new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
      details: { requiredCapability: `postgres_command_transaction:${operation}` },
    }),
  );
}

export class PostgresRunCommandUnitOfWork implements RunCommandUnitOfWork {
  readonly transactionDomain = "postgres.main";
  readonly atomicCommandAndWakeup = true;
  readonly #guard: PostgresStorageGuard;
  readonly #now: () => string;
  readonly #generateWakeupId: (requestDigest: string) => string;

  constructor(
    readonly database: PostgresDatabase,
    readonly options: PostgresRunCommandUnitOfWorkOptions,
  ) {
    this.#guard = new PostgresStorageGuard(options.securityProfile);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#generateWakeupId =
      options.generateWakeupId ?? ((digest) => `wakeup-${digest.slice("sha256:".length, 39)}`);
  }

  transactCommand<T>(
    scopeInput: CommandScope,
    contextInput: CommandContext,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<CommandTransactionResult<T>> {
    const scope = CommandScopeSchema.parse(scopeInput);
    const context = CommandContextSchema.parse(contextInput);
    this.#guard.assertTenantAllowed(scope.tenant.id);
    this.#assertCommandBinding(scope, context);
    const scopeDigest = digestCanonicalJson(scope);
    return withTenantTransaction(this.database, scope.tenant.id, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        digestCanonicalJson({ tenantId: scope.tenant.id, scopeDigest }),
      ]);
      const prior = await client.query<CommandRow>(
        `SELECT scope_json,request_digest,command_record_json,value_json
         FROM pactmark_commands WHERE tenant_id=$1 AND command_scope=$2 AND idempotency_key=$3
         FOR UPDATE`,
        [scope.tenant.id, scopeDigest, scope.commandId],
      );
      const existing = prior.rows[0];
      if (existing !== undefined) {
        const storedScope = CommandScopeSchema.parse(parseJsonColumn(existing.scope_json));
        if (
          canonicalJsonStringify(storedScope) !== canonicalJsonStringify(scope) ||
          existing.request_digest !== context.requestDigest
        ) {
          throw new KafError("KAF_HTTP_IDEMPOTENCY_CONFLICT");
        }
        return {
          value: JsonValueSchema.parse(parseJsonColumn(existing.value_json)) as T,
          commandRecord: CommandRecordSchema.parse(parseJsonColumn(existing.command_record_json)),
          replayed: true,
        };
      }
      const state = this.#transaction(client, scope.tenant.id, scope.commandId);
      const value = await callback(state.transaction);
      const jsonValue = JsonValueSchema.parse(value);
      const record = CommandRecordSchema.parse(state.commandRecord());
      this.#assertRecordBinding(record, scope, context);
      await this.#flushRunState(client, state.operations(), state.stagedWorkOrder());
      await client.query(
        `INSERT INTO pactmark_commands
         (tenant_id,command_scope,idempotency_key,canonical_digest,state,result_ref_json,
          expires_at,scope_json,request_digest,command_record_json,value_json)
         VALUES ($1,$2,$3,$4,'committed',$5::jsonb,$6::timestamptz,$7::jsonb,$8,$9::jsonb,$10::jsonb)`,
        [
          scope.tenant.id,
          scopeDigest,
          scope.commandId,
          digestCanonicalJson(record),
          record.resultReference === undefined ? null : JSON.stringify(record.resultReference),
          record.idempotencyExpiresAt,
          JSON.stringify(scope),
          context.requestDigest,
          JSON.stringify(record),
          JSON.stringify(jsonValue),
        ],
      );
      return { value: jsonValue as T, commandRecord: record, replayed: false };
    });
  }

  transactTransition<T>(
    keyInput: RunTransitionKey,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<T> {
    const key = RunTransitionKeySchema.parse(keyInput);
    this.#guard.assertTenantAllowed(key.tenantId);
    const keyDigest = digestCanonicalJson(key);
    return withTenantTransaction(this.database, key.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        digestCanonicalJson({ tenantId: key.tenantId, runId: key.runId }),
      ]);
      await this.#assertTransitionFence(client, key);
      const prior = await client.query(
        "SELECT 1 FROM pactmark_run_transitions WHERE tenant_id=$1 AND transition_digest=$2 FOR UPDATE",
        [key.tenantId, keyDigest],
      );
      if (prior.rowCount !== 0) conflict("transition_already_committed");
      const state = this.#transaction(client, key.tenantId);
      const value = await callback(state.transaction);
      const persistedValue = PersistedTransitionValueSchema.parse(value);
      await this.#flushRunState(client, state.operations());
      await client.query(
        `INSERT INTO pactmark_run_transitions
         (tenant_id,run_id,transition_digest,transition_json,value_json)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [key.tenantId, key.runId, keyDigest, JSON.stringify(key), JSON.stringify(persistedValue)],
      );
      return value;
    });
  }

  #transaction(client: PostgresClient, tenantId: string, boundCommandId?: string) {
    const operations: StagedOperation[] = [];
    const consumedChallenges = new Map<string, string>();
    let commandRecord: CommandRecord | undefined;
    let stagedWorkOrder: ReturnType<typeof AcceptedWorkOrderSchema.parse> | undefined;
    const transactionalDatabase: PostgresDatabase = {
      query: (text, values) => client.query(text, values),
      connect: () => unsupported("nested_transaction"),
    };
    const workOrders = new PostgresAcceptedWorkOrderStore(
      transactionalDatabase,
      this.options.securityProfile,
      this.options.dataProtector === undefined ? {} : { dataProtector: this.options.dataProtector },
    );
    const protectedRecords = new PostgresInputSubmissionStore(
      transactionalDatabase,
      this.options.securityProfile,
      this.options.dataProtector === undefined ? {} : { dataProtector: this.options.dataProtector },
    );
    const contexts = new PostgresContextStore(transactionalDatabase, this.options.securityProfile, {
      ...(this.options.dataProtector === undefined
        ? {}
        : { dataProtector: this.options.dataProtector }),
      now: this.#now,
    });
    const acknowledgedEffectResults = new PostgresAcknowledgedEffectResultStore(
      transactionalDatabase,
      this.options.securityProfile,
      this.options.dataProtector,
    );
    const transaction: RunCommandTransaction = {
      reserveAdmission: (request) =>
        reserveAdmission(client, tenantId, request, this.options.quotaLimits ?? []),
      putAcceptedWorkOrder: (workOrder) => {
        const parsed = AcceptedWorkOrderSchema.parse(workOrder);
        if (parsed.tenant.id !== tenantId) conflict("cross_tenant_work_order");
        stagedWorkOrder = parsed;
        return workOrders.putImmutable(parsed);
      },
      putInputSubmission: (record) => {
        if (record.tenantId !== tenantId) conflict("cross_tenant_input_submission");
        if (boundCommandId === undefined || record.consumingCommandId !== boundCommandId) {
          conflict("input_submission_command_binding_changed");
        }
        return protectedRecords.putOnce(record).then(() => undefined);
      },
      putContextSnapshot: (input) => {
        const snapshot = ContextSnapshotSchema.parse(input);
        if (snapshot.tenantId !== tenantId) conflict("cross_tenant_context_snapshot");
        return contexts.put(snapshot);
      },
      issueCapabilityGrant: (grant) => issueCapabilityGrant(client, tenantId, grant),
      reserveCapabilityGrantUse: (grantId, authorizationKey, at) =>
        reserveCapabilityGrantUse(client, tenantId, grantId, authorizationKey, at),
      appendRunEvent: (event) => {
        const parsed = RunEventSchema.parse(event);
        if (parsed.tenantId !== tenantId) conflict("cross_tenant_event");
        operations.push({ kind: "event", event: parsed });
        return Promise.resolve();
      },
      putRunProjection: (projection) => {
        const parsed = RunProjectionSchema.parse(projection);
        if (parsed.tenantId !== tenantId) conflict("cross_tenant_projection");
        operations.push({ kind: "projection", projection: parsed });
        return Promise.resolve();
      },
      putCommandRecord: (record) => {
        commandRecord = CommandRecordSchema.parse(record);
        return Promise.resolve();
      },
      putDecisionChallenge: (challenge) => putDecisionChallenge(client, tenantId, challenge),
      putDecisionGate: (gate) => putDecisionGate(client, tenantId, gate),
      consumeDecisionChallenge: async (challengeId, commandId, consumedAt) => {
        if (boundCommandId === undefined || boundCommandId !== commandId) {
          conflict("decision_command_binding_changed");
        }
        await consumeDecisionChallenge(client, tenantId, challengeId, commandId, consumedAt);
        consumedChallenges.set(challengeId, commandId);
      },
      putApproval: (approval) => {
        if (
          boundCommandId === undefined ||
          consumedChallenges.get(approval.challengeId) !== boundCommandId
        ) {
          return Promise.reject(
            new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
              details: { reason: "approval_challenge_not_consumed_in_command" },
            }),
          );
        }
        return putApproval(client, tenantId, approval);
      },
      putDecisionRejection: (rejection) => putDecisionRejection(client, tenantId, rejection),
      claimApproval: (approvalId, authorizationKey, at) =>
        claimApproval(client, tenantId, approvalId, authorizationKey, at),
      putAuthorizationReservation: (reservation) =>
        putAuthorizationReservation(client, tenantId, reservation),
      putEffectRecord: (record) => putEffectRecord(client, tenantId, record),
      putProtectedEffectResult: async (input) => {
        const record = ProtectedEffectResultRecordSchema.parse(input);
        if (record.tenantId !== tenantId) conflict("cross_tenant_acknowledged_effect_result");
        const effect = await new PostgresEffectLedger(
          transactionalDatabase,
          this.options.securityProfile,
        ).getByEffectId(tenantId, record.runId, record.effectId);
        if (effect === undefined) conflict("acknowledged_effect_missing");
        assertEffectResultRecordBinding(record, effect);
        const workOrder = await client.query<{
          work_order_id: string;
          work_order_binding_digest: string;
          execution_definition_digest: string;
          purpose_code: string;
          purpose_registry_version: string;
          data_class: string;
        }>(
          `SELECT rwo.work_order_id,rwo.work_order_binding_digest,rwo.execution_definition_digest,
                  wo.purpose_code,wo.purpose_registry_version,wo.data_class
           FROM pactmark_run_work_orders rwo
           JOIN pactmark_work_orders wo
             ON wo.tenant_id=rwo.tenant_id AND wo.work_order_id=rwo.work_order_id
           WHERE rwo.tenant_id=$1 AND rwo.run_id=$2`,
          [tenantId, record.runId],
        );
        const binding = workOrder.rows[0];
        const mismatchedFields =
          binding === undefined
            ? ["binding"]
            : [
                ...(binding.work_order_id === record.workOrderId ? [] : ["workOrderId"]),
                ...(binding.work_order_binding_digest === record.workOrderBindingDigest
                  ? []
                  : ["workOrderBindingDigest"]),
                ...(binding.execution_definition_digest === record.executionDefinitionDigest
                  ? []
                  : ["executionDefinitionDigest"]),
                ...(binding.purpose_code === record.purposeCode ? [] : ["purposeCode"]),
                ...(binding.purpose_registry_version === record.purposeRegistryVersion
                  ? []
                  : ["purposeRegistryVersion"]),
                ...(binding.data_class === record.dataClass ? [] : ["dataClass"]),
              ];
        if (mismatchedFields.length > 0) {
          throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
            details: {
              reason: "acknowledged_effect_result_work_order_binding_changed",
              mismatchedFields: mismatchedFields.join(","),
            },
          });
        }
        await acknowledgedEffectResults.putImmutable(record);
      },
      putActiveExecutionReservation: async (reservation, runMaximumActiveExecutionMs) => {
        const binding = await client.query<{
          work_order_id: string;
          max_active_execution_ms: string | number | null;
        }>(
          `SELECT rwo.work_order_id,wo.max_active_execution_ms
           FROM pactmark_run_work_orders rwo
           JOIN pactmark_work_orders wo
             ON wo.tenant_id=rwo.tenant_id AND wo.work_order_id=rwo.work_order_id
           WHERE rwo.tenant_id=$1 AND rwo.run_id=$2`,
          [tenantId, reservation.runId],
        );
        const storedMaximum = binding.rows[0]?.max_active_execution_ms;
        if (
          storedMaximum === undefined ||
          storedMaximum === null ||
          Number(storedMaximum) !== runMaximumActiveExecutionMs
        ) {
          conflict("active_execution_work_order_budget_binding_changed");
        }
        return putActiveExecutionReservation(
          client,
          tenantId,
          reservation,
          runMaximumActiveExecutionMs,
        );
      },
      putModelCallReservation: (reservation) =>
        putModelCallReservation(client, tenantId, reservation, this.options.quotaLimits ?? []),
      enqueueWakeup: (request) => this.#enqueueWakeup(client, tenantId, request, stagedWorkOrder),
    };
    return {
      transaction,
      commandRecord: () => commandRecord,
      operations: () => operations,
      stagedWorkOrder: () => stagedWorkOrder,
    };
  }

  async #enqueueWakeup(
    client: PostgresClient,
    tenantId: string,
    input: Parameters<RunCommandTransaction["enqueueWakeup"]>[0],
    stagedWorkOrder?: ReturnType<typeof AcceptedWorkOrderSchema.parse>,
  ): Promise<DurableWakeupReceipt> {
    const request = DurableWakeupRequestSchema.parse(input);
    if (request.tenantId !== tenantId) conflict("cross_tenant_wakeup");
    const requestDigest = digestCanonicalJson(request);
    if (stagedWorkOrder !== undefined) {
      await this.#bindRunWorkOrder(client, tenantId, request.runId, stagedWorkOrder);
    }
    const binding = await client.query<{ work_order_id: string }>(
      `SELECT work_order_id FROM pactmark_run_work_orders
       WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, request.runId],
    );
    const workOrderId = binding.rows[0]?.work_order_id;
    if (workOrderId === undefined) conflict("run_work_order_binding_missing");
    const receipt = DurableWakeupReceiptSchema.parse({
      schemaVersion: "1",
      receiptId: this.#generateWakeupId(requestDigest),
      requestDigest,
      enqueuedAt: this.#now(),
    });
    const result = await client.query<{ request_digest: string; wakeup_id: string }>(
      `INSERT INTO pactmark_wakeups
       (tenant_id,run_id,wakeup_id,deduplication_key,delegation_json,available_at,state,
        request_digest,work_order_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,'pending',$7,$8)
       ON CONFLICT (tenant_id,deduplication_key) DO NOTHING
       RETURNING request_digest,wakeup_id`,
      [
        request.tenantId,
        request.runId,
        receipt.receiptId,
        request.deduplicationKey,
        JSON.stringify(request),
        request.notBefore,
        requestDigest,
        workOrderId,
      ],
    );
    if (result.rowCount === 1) return receipt;
    const prior = await client.query<{ request_digest: string; wakeup_id: string }>(
      "SELECT request_digest,wakeup_id FROM pactmark_wakeups WHERE tenant_id=$1 AND deduplication_key=$2",
      [request.tenantId, request.deduplicationKey],
    );
    if (prior.rows[0]?.request_digest !== requestDigest) conflict("wakeup_deduplication_changed");
    return DurableWakeupReceiptSchema.parse({
      ...receipt,
      receiptId: prior.rows[0].wakeup_id,
    });
  }

  async #bindRunWorkOrder(
    client: PostgresClient,
    tenantId: string,
    runId: string,
    workOrder: ReturnType<typeof AcceptedWorkOrderSchema.parse>,
  ): Promise<void> {
    const bound = await client.query<{ work_order_binding_digest: string }>(
      `INSERT INTO pactmark_run_work_orders
       (tenant_id,run_id,work_order_id,work_order_binding_digest,execution_definition_digest)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,run_id) DO NOTHING
       RETURNING work_order_binding_digest`,
      [
        tenantId,
        runId,
        workOrder.id,
        workOrder.workOrderBindingDigest,
        workOrder.executionDefinitionDigest,
      ],
    );
    if (bound.rowCount === 1) return;
    const prior = await client.query<{
      work_order_id: string;
      work_order_binding_digest: string;
      execution_definition_digest: string;
    }>(
      `SELECT work_order_id,work_order_binding_digest,execution_definition_digest
       FROM pactmark_run_work_orders WHERE tenant_id=$1 AND run_id=$2`,
      [tenantId, runId],
    );
    const priorBinding = prior.rows[0];
    if (priorBinding === undefined) conflict("run_work_order_binding_missing");
    if (
      priorBinding.work_order_id !== workOrder.id ||
      priorBinding.work_order_binding_digest !== workOrder.workOrderBindingDigest ||
      priorBinding.execution_definition_digest !== workOrder.executionDefinitionDigest
    ) {
      conflict("run_work_order_binding_changed");
    }
  }

  async #flushRunState(
    client: PostgresClient,
    operations: readonly StagedOperation[],
    stagedWorkOrder?: ReturnType<typeof AcceptedWorkOrderSchema.parse>,
  ) {
    if (stagedWorkOrder !== undefined) {
      const accepted = operations.find(
        (operation) => operation.kind === "event" && operation.event.eventType === "RunAccepted",
      );
      if (accepted !== undefined && accepted.kind === "event") {
        await this.#bindRunWorkOrder(
          client,
          stagedWorkOrder.tenant.id,
          accepted.event.runId,
          stagedWorkOrder,
        );
      }
    }
    for (const operation of operations) {
      if (operation.kind === "event") {
        const event = operation.event;
        this.#guard.assertRoutingAllowed(event.tenantId, event.dataClass);
        const tail = await client.query<{ sequence: string | number }>(
          "SELECT sequence FROM pactmark_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence DESC LIMIT 1 FOR UPDATE",
          [event.tenantId, event.runId],
        );
        if (Number(tail.rows[0]?.sequence ?? 0) + 1 !== event.sequence) conflict("event_sequence");
        await client.query(
          `INSERT INTO pactmark_run_events
           (tenant_id,run_id,sequence,event_id,event_json,canonical_digest,occurred_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)`,
          [
            event.tenantId,
            event.runId,
            event.sequence,
            event.eventId,
            JSON.stringify(event),
            digestCanonicalJson(event),
            event.occurredAt,
          ],
        );
      } else {
        const projection = operation.projection;
        const current = await client.query<ProjectionRow>(
          "SELECT projection_json,last_sequence FROM pactmark_run_projections WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE",
          [projection.tenantId, projection.runId],
        );
        const previous = current.rows[0];
        if (previous !== undefined && Number(previous.last_sequence) >= projection.lastSequence) {
          conflict("projection_sequence");
        }
        await client.query(
          `INSERT INTO pactmark_run_projections
           (tenant_id,run_id,last_sequence,projection_json,updated_at)
           VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
           ON CONFLICT (tenant_id,run_id) DO UPDATE SET
             last_sequence=EXCLUDED.last_sequence,projection_json=EXCLUDED.projection_json,
             updated_at=EXCLUDED.updated_at`,
          [
            projection.tenantId,
            projection.runId,
            projection.lastSequence,
            JSON.stringify(projection),
            projection.updatedAt,
          ],
        );
      }
    }
  }

  async #assertTransitionFence(client: PostgresClient, key: RunTransitionKey) {
    const projection = await client.query<ProjectionRow>(
      "SELECT projection_json,last_sequence FROM pactmark_run_projections WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE",
      [key.tenantId, key.runId],
    );
    const stored = projection.rows[0];
    if (stored === undefined) conflict("transition_run_missing");
    const run = RunProjectionSchema.parse(parseJsonColumn(stored.projection_json));
    if (
      run.tenantId !== key.tenantId ||
      run.runId !== key.runId ||
      run.workOrderBindingDigest !== key.workOrderBindingDigest ||
      run.executionDefinitionDigest !== key.executionDefinitionDigest
    ) {
      conflict("transition_binding_changed");
    }
    if ((key.leaseId === undefined) !== (key.fencingToken === undefined)) {
      conflict("transition_fence_incomplete");
    }
    if (key.leaseId !== undefined) {
      const lease = await client.query(
        `SELECT 1 FROM pactmark_run_leases
         WHERE tenant_id=$1 AND run_id=$2 AND lease_id=$3 AND fencing_token=$4
           AND state='active' AND expires_at > clock_timestamp() FOR UPDATE`,
        [key.tenantId, key.runId, key.leaseId, key.fencingToken],
      );
      if (lease.rowCount !== 1) conflict("stale_or_expired_fence");
    }
  }

  #assertCommandBinding(scope: CommandScope, context: CommandContext) {
    if (
      scope.commandId !== context.commandId ||
      scope.operation !== context.operation ||
      canonicalJsonStringify(scope.normalizedResourceScope) !==
        canonicalJsonStringify(context.normalizedResourceScope)
    ) {
      throw new KafError("KAF_HTTP_IDEMPOTENCY_CONFLICT");
    }
  }

  #assertRecordBinding(record: CommandRecord, scope: CommandScope, context: CommandContext) {
    if (
      canonicalJsonStringify(record.scope) !== canonicalJsonStringify(scope) ||
      record.requestDigest !== context.requestDigest ||
      record.status !== "committed"
    ) {
      throw new KafError("KAF_HTTP_IDEMPOTENCY_CONFLICT");
    }
  }
}
