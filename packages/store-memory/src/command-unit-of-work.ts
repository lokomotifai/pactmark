import {
  AcceptedWorkOrderSchema,
  ApprovalSchema,
  AuthorizationReservationSchema,
  CapabilityGrantSchema,
  CommandRecordSchema,
  CommandScopeSchema,
  EffectRecordSchema,
  ProtectedEffectResultRecordSchema,
  DecisionGateSchema,
  DecisionRejectionSchema,
  DecisionSubmissionChallengeSchema,
  DurableWakeupRequestSchema,
  InputSubmissionRecordSchema,
  ContextSnapshotSchema,
  KafError,
  RunTransitionKeySchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type CommandContext,
  type CommandRecord,
  type CommandScope,
  type CommandTransactionResult,
  type RunCommandTransaction,
  type RunCommandUnitOfWork,
  type RunTransitionKey,
} from "@pactmark/core";

import type { MemoryCapabilityGrantStore, MemoryWakeupQueue } from "./authority-stores.js";
import type { MemoryDecisionStore } from "./decision-store.js";
import type { MemoryEffectLedger } from "./effect-ledger.js";
import {
  assertEffectResultRecordBinding,
  type MemoryAcknowledgedEffectResultStore,
} from "./acknowledged-effect-results.js";
import type { MemoryEventStore } from "./event-store.js";
import type {
  MemoryAcceptedWorkOrderStore,
  MemoryContextStore,
  MemoryInputSubmissionStore,
} from "./record-stores.js";
import type {
  MemoryActiveExecutionReservationStore,
  MemoryModelCallReservationStore,
  MemoryQuotaStore,
} from "./resource-reservations.js";

export interface MemoryRunCommandUnitOfWorkOptions {
  readonly acceptedWorkOrderStore: MemoryAcceptedWorkOrderStore;
  readonly eventStore: MemoryEventStore;
  readonly inputSubmissionStore: MemoryInputSubmissionStore;
  readonly contextStore: MemoryContextStore;
  readonly decisionStore: MemoryDecisionStore;
  readonly effectLedger: MemoryEffectLedger;
  readonly capabilityGrantStore: MemoryCapabilityGrantStore;
  readonly wakeupQueue: MemoryWakeupQueue;
  readonly quotaStore: MemoryQuotaStore;
  readonly activeExecutionReservationStore: MemoryActiveExecutionReservationStore;
  readonly modelCallReservationStore: MemoryModelCallReservationStore;
  readonly acknowledgedEffectResultStore: MemoryAcknowledgedEffectResultStore;
}

type StoredCommand = Readonly<{
  requestDigest: string;
  value: unknown;
  record: CommandRecord;
}>;

type MemoryUowSnapshot = Readonly<{
  acceptedWorkOrders: ReturnType<MemoryAcceptedWorkOrderStore["transactionSnapshot"]>;
  inputs: ReturnType<MemoryInputSubmissionStore["transactionSnapshot"]>;
  contexts: ReturnType<MemoryContextStore["transactionSnapshot"]>;
  events: ReturnType<MemoryEventStore["transactionSnapshot"]>;
  decisions: ReturnType<MemoryDecisionStore["transactionSnapshot"]>;
  effects: ReturnType<MemoryEffectLedger["snapshot"]>;
  grants: ReturnType<MemoryCapabilityGrantStore["snapshot"]>;
  wakeups: ReturnType<MemoryWakeupQueue["snapshot"]>;
  quotas: ReturnType<MemoryQuotaStore["snapshot"]>;
  activeExecutions: ReturnType<MemoryActiveExecutionReservationStore["snapshot"]>;
  modelCalls: ReturnType<MemoryModelCallReservationStore["snapshot"]>;
  acknowledgedEffectResults: ReturnType<MemoryAcknowledgedEffectResultStore["transactionSnapshot"]>;
}>;

function unsupported(): Promise<never> {
  return Promise.reject(
    new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
      details: { requiredCapability: "memory_transaction_operation" },
    }),
  );
}

/**
 * Process-local command serialization and replay for the ephemeral profile.
 * It never advertises durable or atomic wake-up behavior.
 */
export class MemoryRunCommandUnitOfWork implements RunCommandUnitOfWork {
  readonly transactionDomain = "memory.process-local";
  readonly atomicCommandAndWakeup = false;
  readonly #stores: MemoryRunCommandUnitOfWorkOptions;
  readonly #commands = new Map<string, StoredCommand>();
  readonly #transitions = new Map<string, unknown>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: MemoryRunCommandUnitOfWorkOptions) {
    this.#stores = options;
  }

  transactCommand<T>(
    scopeInput: CommandScope,
    command: CommandContext,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<CommandTransactionResult<T>> {
    const scope = CommandScopeSchema.parse(scopeInput);
    const key = canonicalJsonStringify(scope);
    return this.#exclusive(async () => {
      const existing = this.#commands.get(key);
      if (existing !== undefined) {
        if (existing.requestDigest !== command.requestDigest) {
          throw new KafError("KAF_HTTP_IDEMPOTENCY_CONFLICT");
        }
        return {
          value: existing.value as T,
          commandRecord: existing.record,
          replayed: true,
        };
      }
      const snapshot = this.#snapshot();
      try {
        let commandRecord: CommandRecord | undefined;
        const transaction = this.#transaction(scope.tenant.id, scope.commandId, (record) => {
          commandRecord = CommandRecordSchema.parse(record);
        });
        const value = await callback(transaction);
        const record = CommandRecordSchema.parse(commandRecord);
        if (
          canonicalJsonStringify(record.scope) !== canonicalJsonStringify(scope) ||
          record.requestDigest !== command.requestDigest
        ) {
          throw new KafError("KAF_HTTP_IDEMPOTENCY_CONFLICT");
        }
        this.#commands.set(key, { requestDigest: command.requestDigest, value, record });
        return { value, commandRecord: record, replayed: false };
      } catch (error) {
        this.#restore(snapshot);
        throw error;
      }
    });
  }

  transactTransition<T>(
    keyInput: RunTransitionKey,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<T> {
    const transitionKey = digestCanonicalJson(RunTransitionKeySchema.parse(keyInput));
    return this.#exclusive(async () => {
      if (this.#transitions.has(transitionKey)) return this.#transitions.get(transitionKey) as T;
      const snapshot = this.#snapshot();
      try {
        const result = await callback(
          this.#transaction(keyInput.tenantId, undefined, () => undefined),
        );
        this.#transitions.set(transitionKey, result);
        return result;
      } catch (error) {
        this.#restore(snapshot);
        throw error;
      }
    });
  }

  #transaction(
    tenantId: string,
    boundCommandId: string | undefined,
    onCommandRecord: (record: CommandRecord) => void,
  ): RunCommandTransaction {
    const consumedChallenges = new Map<string, string>();
    return {
      reserveAdmission: async (request) => {
        if (request.tenant.id !== tenantId) await this.#crossTenant("admission");
        const decision = this.#stores.quotaStore.reserveInTransaction(request);
        if (!decision.admitted) {
          throw new KafError("KAF_ADMISSION_DENIED", {
            details: { retryAfterSeconds: decision.retryAfterSeconds },
          });
        }
        return decision.reservation;
      },
      putAcceptedWorkOrder: (input) => {
        const workOrder = AcceptedWorkOrderSchema.parse(input);
        if (workOrder.tenant.id !== tenantId) return this.#crossTenant("work_order");
        return this.#stores.acceptedWorkOrderStore.putImmutable(workOrder);
      },
      putInputSubmission: async (record) => {
        const parsed = InputSubmissionRecordSchema.parse(record);
        if (parsed.tenantId !== tenantId) await this.#crossTenant("input_submission");
        if (boundCommandId === undefined || parsed.consumingCommandId !== boundCommandId) {
          throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
            details: { reason: "input_submission_command_binding_changed" },
          });
        }
        await this.#stores.inputSubmissionStore.putOnce(parsed);
      },
      putContextSnapshot: async (input) => {
        const snapshot = ContextSnapshotSchema.parse(input);
        if (snapshot.tenantId !== tenantId) await this.#crossTenant("context_snapshot");
        await this.#stores.contextStore.put(snapshot);
      },
      issueCapabilityGrant: (input) => {
        const grant = CapabilityGrantSchema.parse(input);
        if (grant.tenant.id !== tenantId) return this.#crossTenant("capability_grant");
        return this.#stores.capabilityGrantStore.issue(grant);
      },
      reserveCapabilityGrantUse: (grantId, authorizationKey, at) =>
        this.#stores.capabilityGrantStore.reserveUseForTenant(
          tenantId,
          grantId,
          authorizationKey,
          at,
        ),
      appendRunEvent: async (event) => {
        if (event.tenantId !== tenantId) await this.#crossTenant("event");
        await this.#stores.eventStore.append(event, event.sequence - 1);
      },
      putRunProjection: async (projection) => {
        if (projection.tenantId !== tenantId) await this.#crossTenant("projection");
        const stored = await this.#stores.eventStore.getProjection(
          projection.tenantId,
          projection.runId,
        );
        if (
          stored === undefined ||
          canonicalJsonStringify(stored) !== canonicalJsonStringify(projection)
        ) {
          throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
            details: { reason: "projection_drift" },
          });
        }
      },
      putCommandRecord: (record) => {
        onCommandRecord(CommandRecordSchema.parse(record));
        return Promise.resolve();
      },
      putDecisionChallenge: (input) => {
        const challenge = DecisionSubmissionChallengeSchema.parse(input);
        if (challenge.binding.tenant.id !== tenantId)
          return this.#crossTenant("decision_challenge");
        return this.#stores.decisionStore.putChallenge(challenge);
      },
      putDecisionGate: async (gate) => {
        const parsed = DecisionGateSchema.parse(gate);
        if (parsed.tenantId !== tenantId) await this.#crossTenant("decision_gate");
        await this.#stores.decisionStore.putGateOnce(parsed);
      },
      consumeDecisionChallenge: async (challengeId, commandId, consumedAt) => {
        if (boundCommandId === undefined || commandId !== boundCommandId) {
          await this.#crossTenant("decision_command_binding");
        }
        await this.#stores.decisionStore.consumeChallenge(
          challengeId,
          commandId,
          consumedAt,
          tenantId,
        );
        consumedChallenges.set(challengeId, commandId);
      },
      putApproval: async (input) => {
        const approval = ApprovalSchema.parse(input);
        if (approval.binding.tenant.id !== tenantId) await this.#crossTenant("approval");
        if (
          boundCommandId === undefined ||
          consumedChallenges.get(approval.challengeId) !== boundCommandId
        ) {
          throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
            details: { reason: "approval_challenge_not_consumed_in_command" },
          });
        }
        await this.#stores.decisionStore.putApproval(approval);
      },
      putDecisionRejection: (input) => {
        const rejection = DecisionRejectionSchema.parse(input);
        if (rejection.tenantId !== tenantId) return this.#crossTenant("decision_rejection");
        return this.#stores.decisionStore.putRejection(rejection);
      },
      claimApproval: unsupported,
      putAuthorizationReservation: (input) => {
        const reservation = AuthorizationReservationSchema.parse(input);
        if (reservation.tenantId !== tenantId) {
          return Promise.reject(
            new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
              details: { reason: "cross_tenant_authorization_reservation" },
            }),
          );
        }
        return this.#stores.effectLedger.putAuthorizationReservation(reservation);
      },
      putEffectRecord: (input) => {
        const record = EffectRecordSchema.parse(input);
        if (record.tenantId !== tenantId) {
          return Promise.reject(
            new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
              details: { reason: "cross_tenant_effect_record" },
            }),
          );
        }
        return this.#stores.effectLedger.putEffectRecord(record);
      },
      putProtectedEffectResult: async (input) => {
        const record = ProtectedEffectResultRecordSchema.parse(input);
        if (record.tenantId !== tenantId) await this.#crossTenant("acknowledged_effect_result");
        const effect = await this.#stores.effectLedger.getByEffectId(
          tenantId,
          record.runId,
          record.effectId,
        );
        if (effect === undefined) {
          throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
            details: { reason: "acknowledged_effect_missing" },
          });
        }
        assertEffectResultRecordBinding(record, effect);
        const projection = await this.#stores.eventStore.getProjection(tenantId, record.runId);
        const workOrder = await this.#stores.acceptedWorkOrderStore.get(
          tenantId,
          record.workOrderId,
        );
        if (
          projection === undefined ||
          projection.workOrderId !== record.workOrderId ||
          projection.workOrderBindingDigest !== record.workOrderBindingDigest ||
          projection.executionDefinitionDigest !== record.executionDefinitionDigest ||
          projection.dataClass !== record.dataClass ||
          workOrder === undefined ||
          workOrder.workOrderBindingDigest !== record.workOrderBindingDigest ||
          workOrder.executionDefinitionDigest !== record.executionDefinitionDigest ||
          workOrder.purpose.code !== record.purposeCode ||
          workOrder.purpose.registryVersion !== record.purposeRegistryVersion ||
          workOrder.dataClass !== record.dataClass
        ) {
          throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
            details: { reason: "acknowledged_effect_result_work_order_binding_changed" },
          });
        }
        await this.#stores.acknowledgedEffectResultStore.putImmutable(record);
      },
      putActiveExecutionReservation: async (reservation, runMaximumActiveExecutionMs) => {
        if (reservation.tenant.id !== tenantId) await this.#crossTenant("active_execution");
        const projection = await this.#stores.eventStore.getProjection(tenantId, reservation.runId);
        const workOrder =
          projection === undefined
            ? undefined
            : await this.#stores.acceptedWorkOrderStore.get(tenantId, projection.workOrderId);
        if (
          projection === undefined ||
          workOrder === undefined ||
          projection.workOrderBindingDigest !== workOrder.workOrderBindingDigest ||
          workOrder.budget.maxActiveExecutionMs !== runMaximumActiveExecutionMs
        ) {
          throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
            details: { reason: "active_execution_work_order_budget_binding_changed" },
          });
        }
        return this.#stores.activeExecutionReservationStore.putInTransaction(
          reservation,
          runMaximumActiveExecutionMs,
        );
      },
      putModelCallReservation: (reservation) => {
        if (reservation.tenantId !== tenantId) return this.#crossTenant("model_call");
        this.#stores.modelCallReservationStore.putInTransaction(reservation);
        return Promise.resolve();
      },
      enqueueWakeup: (input) => {
        const request = DurableWakeupRequestSchema.parse(input);
        if (request.tenantId !== tenantId) return this.#crossTenant("wakeup");
        return this.#stores.wakeupQueue.enqueue(request);
      },
    };
  }

  #snapshot(): MemoryUowSnapshot {
    return {
      acceptedWorkOrders: this.#stores.acceptedWorkOrderStore.transactionSnapshot(),
      inputs: this.#stores.inputSubmissionStore.transactionSnapshot(),
      contexts: this.#stores.contextStore.transactionSnapshot(),
      events: this.#stores.eventStore.transactionSnapshot(),
      decisions: this.#stores.decisionStore.transactionSnapshot(),
      effects: this.#stores.effectLedger.snapshot(),
      grants: this.#stores.capabilityGrantStore.snapshot(),
      wakeups: this.#stores.wakeupQueue.snapshot(),
      quotas: this.#stores.quotaStore.snapshot(),
      activeExecutions: this.#stores.activeExecutionReservationStore.snapshot(),
      modelCalls: this.#stores.modelCallReservationStore.snapshot(),
      acknowledgedEffectResults: this.#stores.acknowledgedEffectResultStore.transactionSnapshot(),
    };
  }

  #restore(snapshot: MemoryUowSnapshot): void {
    this.#stores.acceptedWorkOrderStore.transactionRestore(snapshot.acceptedWorkOrders);
    this.#stores.inputSubmissionStore.transactionRestore(snapshot.inputs);
    this.#stores.contextStore.transactionRestore(snapshot.contexts);
    this.#stores.eventStore.transactionRestore(snapshot.events);
    this.#stores.decisionStore.transactionRestore(snapshot.decisions);
    this.#stores.effectLedger.restore(snapshot.effects);
    this.#stores.capabilityGrantStore.restore(snapshot.grants);
    this.#stores.wakeupQueue.restore(snapshot.wakeups);
    this.#stores.quotaStore.restore(snapshot.quotas);
    this.#stores.activeExecutionReservationStore.restore(snapshot.activeExecutions);
    this.#stores.modelCallReservationStore.restore(snapshot.modelCalls);
    this.#stores.acknowledgedEffectResultStore.transactionRestore(
      snapshot.acknowledgedEffectResults,
    );
  }

  #crossTenant(kind: string): Promise<never> {
    return Promise.reject(
      new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: `cross_tenant_${kind}` },
      }),
    );
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
