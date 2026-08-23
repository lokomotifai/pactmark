import {
  createAuthorityIssuer,
  createCommandContext,
  defineModelAdapterRegistration,
  defineModelResourceProfile,
  defineModelSecurityProfile,
  digestBytes,
  digestCanonicalJson,
  KafError,
  ModelCredentialRefSchema,
  ResolvedModelCredential,
  protectedEffectResultAad,
  type AcceptedWorkOrder,
  type AgentDefinition,
  type Artifact,
  type AuthorityContext,
  type CommandContext,
  type CommandRecord,
  type CommandScope,
  type CommandTransactionResult,
  type CompensationRunDefinition,
  type DecisionChallengeIssueRequest,
  type DecisionChallengeIssuer,
  type DecisionSubmissionChallenge,
  type DurableWakeupRequest,
  type EffectRecord,
  type EventStore,
  type JsonValue,
  type ModelCallReservation,
  type ModelCredentialIssueRequest,
  type ModelCredentialRef,
  type ProposedEffectBinding,
  type ProtectedEffectResultRecord,
  type RunEvent,
  type RunCommandTransaction,
  type RunCommandUnitOfWork,
  type RunTransitionKey,
  type RuntimeCapabilities,
  type ToolRegistrationContract,
  type VerificationResult,
  type WakeupScheduler,
} from "@pactmark/core";
import { createMemoryStoreSuite } from "../../store-memory/src/index.js";
import { describe, expect, it, vi } from "vitest";

import {
  assertEffectRecordBinding,
  createRuntime,
  effectProofDigest,
  type RuntimeEffectServices,
  type RuntimeExecutableEffectStrategy,
  type RuntimeCompensationServices,
  type RuntimeKernelConfig,
  type RuntimeModelCallSettlement,
  type RuntimeProductionModelServices,
  validateAuthorizationReservation,
  validateEffectExecution,
  validateEffectPreview,
} from "../src/index.js";

const d = (digit: string) => `sha256:${digit.repeat(64)}` as const;
function omitProperty<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy;
}
const now = "2026-08-03T12:00:00.000Z";
const caps: RuntimeCapabilities = {
  schemaVersion: "1",
  executionProfile: "ephemeral",
  durableStorage: false,
  protectedContext: false,
  protectedWorkOrders: false,
  protectedInputSubmissions: false,
  streaming: true,
  cancellation: true,
  sandbox: "unsafe_local",
  networkPolicy: "none",
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: false,
  typedInput: false,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: ["memory.process-local"],
};

class MemoryCommandUnitOfWork implements RunCommandUnitOfWork {
  readonly transactionDomain = "memory.process-local";
  readonly atomicCommandAndWakeup: boolean;
  readonly enqueuedWakeups: unknown[] = [];
  readonly effectRecords = new Map<string, EffectRecord>();
  readonly effectResults = new Map<string, ProtectedEffectResultRecord>();
  readonly #commands = new Map<
    string,
    Readonly<{ requestDigest: string; value: unknown; record: CommandRecord }>
  >();
  readonly #transaction: RunCommandTransaction;
  readonly #commandRecords = new Map<string, CommandRecord>();
  readonly #transitionCounts = new Map<string, number>();
  #crashTransitionPending: string | undefined;
  #crashCommandPending: boolean;

  constructor(
    stores: ReturnType<typeof createMemoryStoreSuite>,
    options: Readonly<{
      atomicCommandAndWakeup?: boolean;
      crashAfterTransitionKindOnce?: string;
    }> = {},
  ) {
    this.atomicCommandAndWakeup = options.atomicCommandAndWakeup ?? false;
    this.#crashCommandPending = options.crashAfterTransitionKindOnce === "RunAccepted";
    this.#crashTransitionPending = this.#crashCommandPending
      ? undefined
      : options.crashAfterTransitionKindOnce;
    this.#transaction = {
      reserveAdmission: async (
        request: Parameters<RunCommandTransaction["reserveAdmission"]>[0],
      ) => {
        await Promise.resolve();
        return {
          schemaVersion: "1" as const,
          id: `admission-${request.commandId ?? request.resourceKey}`,
          tenant: request.tenant,
          principal: request.principal,
          ...(request.commandId === undefined ? {} : { commandId: request.commandId }),
          category: request.category,
          resourceKey: request.resourceKey,
          amount: request.amount,
          state: "reserved" as const,
          fencingToken: 1,
          reservedAtServerTime: now,
          leaseExpiresAt: "2026-08-03T13:00:00.000Z",
        };
      },
      putAcceptedWorkOrder: (workOrder: AcceptedWorkOrder) =>
        stores.acceptedWorkOrderStore.putImmutable(workOrder),
      putInputSubmission: async (
        record: Parameters<RunCommandTransaction["putInputSubmission"]>[0],
      ) => {
        await stores.inputSubmissionStore.putOnce(record);
      },
      putContextSnapshot: (snapshot: Parameters<RunCommandTransaction["putContextSnapshot"]>[0]) =>
        stores.contextStore.put(snapshot),
      appendRunEvent: async (event: RunEvent) => {
        await stores.eventStore.append(event, event.sequence - 1);
      },
      putRunProjection: () => Promise.resolve(),
      putCommandRecord: async (record: CommandRecord) => {
        await Promise.resolve();
        this.#commandRecords.set(
          `${digestCanonicalJson(record.scope)}\u0000${record.scope.operation}\u0000${record.scope.commandId}`,
          record,
        );
      },
      putDecisionGate: async (gate: Parameters<RunCommandTransaction["putDecisionGate"]>[0]) => {
        await stores.decisionStore.putGateOnce(gate);
      },
      putDecisionChallenge: (
        challenge: Parameters<RunCommandTransaction["putDecisionChallenge"]>[0],
      ) => stores.decisionStore.putChallenge(challenge),
      consumeDecisionChallenge: (challengeId: string, commandId: string, consumedAt: string) =>
        stores.decisionStore.consumeChallenge(challengeId, commandId, consumedAt),
      putApproval: (approval: Parameters<RunCommandTransaction["putApproval"]>[0]) =>
        stores.decisionStore.putApproval(approval),
      putDecisionRejection: (
        rejection: Parameters<RunCommandTransaction["putDecisionRejection"]>[0],
      ) => stores.decisionStore.putRejection(rejection),
      reserveCapabilityGrantUse: async (grantId: string, authorizationKey: string, at: string) => {
        await Promise.resolve();
        return { schemaVersion: "1", grantId, authorizationKey, useNumber: 1, claimedAt: at };
      },
      claimApproval: async (approvalId: string, authorizationKey: string, at: string) => {
        await Promise.resolve();
        return { schemaVersion: "1", approvalId, authorizationKey, claimedAt: at };
      },
      putAuthorizationReservation: () => Promise.resolve(),
      putEffectRecord: async (record: EffectRecord) => {
        await Promise.resolve();
        this.effectRecords.set(record.effectId, record);
      },
      putProtectedEffectResult: async (record: ProtectedEffectResultRecord) => {
        await Promise.resolve();
        this.effectResults.set(record.effectId, record);
      },
      putActiveExecutionReservation: async (
        reservation: Parameters<RunCommandTransaction["putActiveExecutionReservation"]>[0],
        runMaximumActiveExecutionMs: number,
      ) => {
        await Promise.resolve();
        return stores.activeExecutionReservationStore.putInTransaction(
          reservation,
          runMaximumActiveExecutionMs,
        );
      },
      enqueueWakeup: async (wakeup: DurableWakeupRequest) => {
        await Promise.resolve();
        this.enqueuedWakeups.push(wakeup);
        return {
          schemaVersion: "1",
          receiptId: `receipt-${wakeup.deduplicationKey}`,
          requestDigest: digestCanonicalJson(wakeup),
          enqueuedAt: now,
        };
      },
    } as unknown as RunCommandTransaction;
  }

  async transactCommand<T>(
    scope: CommandScope,
    command: CommandContext,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<CommandTransactionResult<T>> {
    const key = `${digestCanonicalJson(scope)}\u0000${command.operation}\u0000${command.commandId}`;
    const existing = this.#commands.get(key);
    if (existing !== undefined) {
      if (existing.requestDigest !== command.requestDigest)
        throw new KafError("KAF_HTTP_IDEMPOTENCY_CONFLICT");
      return {
        value: existing.value as T,
        commandRecord: existing.record,
        replayed: true,
      };
    }
    const value = await callback(this.#transaction);
    const record = this.#commandRecords.get(key);
    if (record === undefined) throw new Error("command callback did not persist a CommandRecord");
    this.#commands.set(key, { requestDigest: command.requestDigest, value, record });
    if (this.#crashCommandPending) {
      this.#crashCommandPending = false;
      throw new Error("simulated crash after committed RunAccepted");
    }
    return { value, commandRecord: record, replayed: false };
  }

  async transactTransition<T>(
    key: RunTransitionKey,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await callback(this.#transaction);
    const count = (this.#transitionCounts.get(key.transitionKind) ?? 0) + 1;
    this.#transitionCounts.set(key.transitionKind, count);
    if (
      this.#crashTransitionPending === key.transitionKind ||
      this.#crashTransitionPending === `${key.transitionKind}#${String(count)}`
    ) {
      this.#crashTransitionPending = undefined;
      throw new Error(`simulated crash after committed ${key.transitionKind}`);
    }
    return result;
  }
}

const definition: AgentDefinition = {
  schemaVersion: "1",
  id: "research-agent",
  version: "0.1.0",
  description: "test agent",
  instructions: {
    schemaVersion: "1",
    entries: [{ schemaVersion: "1", sourceName: "test", text: "test", contentDigest: d("1") }],
    bundleDigest: d("2"),
  },
  skillManifestDigests: [],
  inputSchemaDigest: d("3"),
  outputSchemaDigest: d("4"),
  toolRegistrationDigests: [d("5")],
  policyRegistrationDigest: d("6"),
  verifierRegistrationDigests: [d("7")],
  modelSecurityProfileDigest: d("8"),
  modelResourceProfileDigest: d("9"),
  modelAdapterRegistrationDigest: d("a"),
  modelConfig: {},
  requiredRuntimeCapabilities: [],
  agentDefinitionDigest: d("b"),
};

const productionModelSecurity = defineModelSecurityProfile({
  id: "fixture-production-model@1",
  provider: "fixture-provider",
  model: "fixture-model",
  endpointOrigin: "https://model.fixture.invalid",
  credentialSlot: "fixture.model-key",
  allowedTenants: ["tenant-1"],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["public"],
  processingRegion: "fixture-region",
  retention: "none",
  logging: "none",
  training: "none",
  contractReference: "fixture-contract",
});
const productionModelResource = defineModelResourceProfile({
  id: "fixture-production-resource@1",
  implementationVersion: "1.0.0",
  maxInputBytesPerCall: 100_000,
  maxInputTokensPerCall: 100_000,
  maxOutputTokensPerCall: 1_000,
  maxStreamedOutputBytesPerCall: 100_000,
  maxStreamEventsPerCall: 100,
  maxToolResultToContextBytes: 100_000,
  maxContextSnapshotBytes: 100_000,
  maxRunModelInputBytes: 1_000_000,
  maxRunModelInputTokens: 1_000_000,
  maxRunModelOutputBytes: 1_000_000,
  maxRunModelOutputTokens: 1_000_000,
  maxRunToolResultToContextBytes: 1_000_000,
  estimator: "fixture-conservative-estimator@1",
  providerOutputCap: "enforced",
});
const productionModelRegistration = defineModelAdapterRegistration({
  id: "fixture.sealed-model-adapter@1",
  implementationVersion: "1.0.0",
  securityProfile: productionModelSecurity,
  resourceProfile: productionModelResource,
  credentialSlot: productionModelSecurity.credentialSlot,
  endpointOrigin: productionModelSecurity.endpointOrigin,
  endpointNormalizerVersion: "whatwg-origin@1",
  adapterArtifact: {
    packageName: "@pactmark/fixture-model-adapter",
    exportName: "fixtureSealedModelAdapter",
    packageVersion: "1.0.0",
    artifactDigest: d("1"),
  },
  providerArtifact: {
    packageName: "fixture-provider-sdk",
    exportName: "createFixtureModel",
    packageVersion: "1.0.0",
    artifactDigest: d("2"),
  },
  executorIdentity: { kind: "sealed-fixture" },
  egressEnforcementIdentity: { mode: "fixture-enforced" },
  conservativeEstimatorIdentity: { id: "fixture-conservative-estimator@1" },
  providerOutputCapIdentity: { setting: "maxOutputTokens", enforcement: "required" },
  streamCounterIdentity: { id: "fixture-stream-counter@1" },
  usageTrustIdentity: { id: "fixture-trusted-usage@1" },
  capabilityContract: { streaming: true, tools: true },
});
const productionDefinition: AgentDefinition = {
  ...definition,
  id: "production-research-agent",
  modelSecurityProfileDigest: productionModelSecurity.modelSecurityProfileDigest,
  modelResourceProfileDigest: productionModelResource.modelResourceProfileDigest,
  modelAdapterRegistrationDigest: productionModelRegistration.modelAdapterRegistrationDigest,
  agentDefinitionDigest: d("c"),
};

function productionModelServicesFixture(
  options: Readonly<{
    durable?: boolean;
    transactionDomain?: string;
    registeredAdapter?: boolean;
    throwAfterResolution?: boolean;
    skipResolution?: boolean;
    repeatResolution?: boolean;
    emptyEmission?: boolean;
    trustedUsage?: boolean;
    transformRef?: (ref: ModelCredentialRef) => unknown;
    onIssue?: (request: ModelCredentialIssueRequest) => Promise<void>;
  }> = {},
) {
  const reservations = new Map<string, ModelCallReservation>();
  const reserve = vi.fn(
    async (_transaction: RunCommandTransaction, value: ModelCallReservation) => {
      await Promise.resolve();
      const key = `${value.tenantId}\u0000${value.runId}\u0000${value.stepId}\u0000${String(value.attempt)}`;
      const existing = reservations.get(key);
      if (existing !== undefined) return existing;
      reservations.set(key, value);
      return value;
    },
  );
  const markDispatched = vi.fn(
    async (_transaction: RunCommandTransaction, value: ModelCallReservation) => {
      await Promise.resolve();
      const next = { ...value, status: "dispatched" as const };
      reservations.set(
        `${value.tenantId}\u0000${value.runId}\u0000${value.stepId}\u0000${String(value.attempt)}`,
        next,
      );
      return next;
    },
  );
  let observedSettlement: unknown;
  const settle = vi.fn(
    async (
      _transaction: RunCommandTransaction,
      value: ModelCallReservation,
      settlement: RuntimeModelCallSettlement,
    ) => {
      await Promise.resolve();
      observedSettlement = settlement;
      const next = {
        ...value,
        status: "settled" as const,
        settlement: {
          schemaVersion: "1" as const,
          inputBytes: settlement.inputBytes,
          inputTokenLowerBound: settlement.inputTokenLowerBound,
          outputBytes: settlement.outputBytes,
          outputTokenLowerBound: settlement.outputTokenLowerBound,
          chargedTokens: Math.max(
            settlement.inputTokenLowerBound + settlement.outputTokenLowerBound,
            (settlement.trustedProviderUsage?.inputTokens ?? 0) +
              (settlement.trustedProviderUsage?.outputTokens ?? 0),
          ),
          chargedIoBytes: settlement.inputBytes + settlement.outputBytes,
          settledAt: now,
        },
      };
      reservations.set(
        `${value.tenantId}\u0000${value.runId}\u0000${value.stepId}\u0000${String(value.attempt)}`,
        next,
      );
      return next;
    },
  );
  const markUncertain = vi.fn(
    async (_transaction: RunCommandTransaction, value: ModelCallReservation) => {
      await Promise.resolve();
      const next = { ...value, status: "uncertain" as const };
      reservations.set(
        `${value.tenantId}\u0000${value.runId}\u0000${value.stepId}\u0000${String(value.attempt)}`,
        next,
      );
      return next;
    },
  );
  const issue = vi.fn(async (request: ModelCredentialIssueRequest) => {
    await Promise.resolve();
    await options.onIssue?.(request);
    const ref = ModelCredentialRefSchema.parse({
      schemaVersion: "1",
      credentialKind: "model",
      refId: "model-ref-1",
      issuerId: "fixture-model-issuer@1",
      ...request.binding,
      issuedAt: request.reservation.createdAt,
      expiresAt: request.expiresAt,
    });
    return (options.transformRef?.(ref) ?? ref) as ModelCredentialRef;
  });
  const resolve = vi.fn(async () => {
    await Promise.resolve();
    return ResolvedModelCredential.fromAdapter("credential-canary-value");
  });
  let adapterCalls = 0;
  let exportContainedSecret = false;
  const services: RuntimeProductionModelServices = {
    profiles: {
      resolveSecurity: (digest) =>
        digest === productionModelSecurity.modelSecurityProfileDigest
          ? productionModelSecurity
          : undefined,
      resolveResource: (digest) =>
        digest === productionModelResource.modelResourceProfileDigest
          ? productionModelResource
          : undefined,
    },
    adapters: {
      resolve: (digest) =>
        options.registeredAdapter !== false &&
        digest === productionModelRegistration.modelAdapterRegistrationDigest
          ? {
              registration: productionModelRegistration,
              estimateInputTokens: ({ inputBytes }) => inputBytes,
              async *invoke(input) {
                exportContainedSecret = JSON.stringify({
                  providerRequest: input.providerRequest,
                  context: input.context,
                }).includes("credential-canary-value");
                if (!options.skipResolution) {
                  const credential = await input.resolveCredential();
                  credential.use((value) => {
                    if (value !== "credential-canary-value") throw new Error("wrong credential");
                  });
                  if (options.repeatResolution) await input.resolveCredential();
                }
                adapterCalls += 1;
                if (options.throwAfterResolution) {
                  throw new Error("provider failed with credential-canary-value");
                }
                if (options.emptyEmission) return;
                yield { type: "final", value: { title: "Sealed", body: "Bound" } };
              },
              ...(options.trustedUsage === false
                ? {}
                : { trustedUsage: () => ({ inputTokens: 12, outputTokens: 3 }) }),
            }
          : undefined,
    },
    credentialIssuer: { issuerId: "fixture-model-issuer@1", issue },
    credentialResolver: { resolverId: "fixture-model-resolver@1", resolve },
    reservations: {
      transactionDomain: options.transactionDomain ?? "memory.process-local",
      durable: options.durable ?? true,
      reserve,
      markDispatched,
      settle,
      markUncertain,
    },
    reservationReader: {
      get: (_tenantId, _runId, stepId, attempt) =>
        Promise.resolve(
          reservations.get(`${_tenantId}\u0000${_runId}\u0000${stepId}\u0000${String(attempt)}`),
        ),
    },
  };
  return {
    services,
    reserve,
    markDispatched,
    settle,
    markUncertain,
    issue,
    resolve,
    reservations,
    getAdapterCalls: () => adapterCalls,
    getExportContainedSecret: () => exportContainedSecret,
    getObservedSettlement: () => observedSettlement,
  };
}

const tool: ToolRegistrationContract = {
  schemaVersion: "1",
  id: "knowledge.search@1",
  implementationVersion: "1.0.0",
  description: "fixture search",
  inputSchemaDigest: d("c"),
  outputSchemaDigest: d("d"),
  security: {
    schemaVersion: "1",
    riskClass: "R1",
    dataClasses: ["public"],
    reversibility: "not_applicable",
    requiredScopes: ["knowledge:read"],
    egress: { mode: "none" },
    networkEnforcement: "declared_ok",
    maxCallsPerRun: 2,
    timeoutMs: 1_000,
  },
  effectStrategyKind: "read",
  effectStrategyRegistrationDigest: d("e"),
  executorKind: "fixture",
  executorVersion: "1",
  toolRegistrationDigest: d("5"),
};

const request = {
  schemaVersion: "1" as const,
  agent: { id: definition.id, version: definition.version },
  goal: "Research a bounded topic",
  input: { topic: "Pactmark" },
  context: { roleFamily: "research", workflowId: "brief", riskClass: "low" as const },
  workMode: "augment" as const,
  autonomyMode: "delegate_review" as const,
  decisionOwner: { mode: "requesting_principal" as const },
  purpose: { code: "service_delivery", registryVersion: "general@1" },
  dataClass: "public" as const,
  retention: { mode: "session" as const },
  requestedCapabilities: ["knowledge:read"],
  resourceScopeCeiling: [],
  budget: { maxTurns: 4, maxModelCalls: 4, maxToolCalls: 4, maxActiveExecutionMs: 10_000 },
};

interface FixtureOptions {
  readonly policyDecision?: "deny" | "allow_with_grant" | "require_approval";
  readonly policyDecisionSequence?: readonly ("deny" | "allow_with_grant" | "require_approval")[];
  readonly policyTargetDigest?: string;
  readonly modelEmission?: (invocation: number, signal: AbortSignal, input?: JsonValue) => unknown;
  readonly toolRegistration?: ToolRegistrationContract | null;
  readonly toolResult?: JsonValue;
  readonly verifierAvailable?: boolean;
  readonly verificationStatus?: VerificationResult["status"];
  readonly resolveDefinition?: boolean;
  readonly monotonicMilliseconds?: () => number;
  readonly wakeupScheduler?: WakeupScheduler;
  readonly runCommandUnitOfWork?: RunCommandUnitOfWork;
  readonly atomicCommandAndWakeup?: boolean;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly leaseTtlMs?: number;
  readonly decisionChallengeTtlMs?: number;
  readonly clockNow?: () => string;
  readonly commandSurface?: boolean;
  readonly typedInputDigestOverride?: string;
  readonly inputProtectorAadMismatch?: boolean;
  readonly contextCheckpointTransactionDomain?: string;
  readonly authenticationStrength?:
    "single_factor" | "multi_factor" | "phishing_resistant" | "user_presence";
  readonly challengeIssueMismatch?: boolean;
  readonly challengeVerifyMismatch?: boolean;
  readonly approvalBindingMismatch?: boolean;
  readonly authenticatedAt?: string;
  readonly decisionRoles?: readonly string[];
  readonly effectStrategy?: RuntimeExecutableEffectStrategy;
  readonly effectCrashAfterTransition?: "EffectDispatched" | "EffectAcknowledged";
  readonly crashAfterTransition?: string;
  readonly effectExistingRecord?: (
    effectKey: string,
    tenantId: string,
    runId: string,
  ) => EffectRecord;
  readonly effectRecoveredResult?: JsonValue;
  readonly effectResultProtectorMode?: "missing" | "aad_mismatch";
  readonly effectStrategyUnavailable?: boolean;
  readonly effectAuthorizationTransform?: (reservation: Record<string, unknown>) => unknown;
  readonly additionalToolRegistrations?: readonly ToolRegistrationContract[];
  readonly additionalEffectStrategies?: readonly Readonly<{
    toolRegistrationDigest: string;
    strategy: RuntimeExecutableEffectStrategy;
  }>[];
  readonly compensationServices?: RuntimeCompensationServices;
  readonly productionModelServices?: RuntimeKernelConfig["productionModelServices"];
  readonly killSwitches?: RuntimeKernelConfig["killSwitches"];
  readonly requireProductionModelBoundary?: boolean;
  readonly agentDefinition?: AgentDefinition;
  readonly retryPolicy?: RuntimeKernelConfig["retryPolicy"];
  readonly retryJitterSource?: RuntimeKernelConfig["retryJitterSource"];
  readonly activeExecutionServices?: RuntimeKernelConfig["activeExecutionServices"];
  readonly modelErrorClassification?:
    "aborted" | "timed_out" | "retryable" | "non_retryable" | "uncertain";
  readonly toolErrorClassification?:
    "aborted" | "timed_out" | "retryable" | "non_retryable" | "uncertain";
  readonly toolExecution?: (invocation: number, signal: AbortSignal) => Promise<JsonValue>;
}

function fixture(options: FixtureOptions = {}) {
  const registeredAgentDefinition = options.agentDefinition ?? definition;
  let id = 0;
  const ids = { generate: (kind: string) => `${kind}-${String(++id)}` };
  const clock = {
    now: options.clockNow ?? (() => now),
    monotonicMilliseconds: options.monotonicMilliseconds ?? (() => id),
  };
  const authorityIssuer = createAuthorityIssuer("test-host");
  const authority = authorityIssuer.issue({
    actor: { type: "user", id: "user-1" },
    tenant: { id: "tenant-1" },
    authenticatedAt: options.authenticatedAt ?? now,
    authenticationStrength: options.authenticationStrength ?? "multi_factor",
    decisionRoles: [...(options.decisionRoles ?? ["owner"])],
    requestCorrelationId: "request-1",
    issuedAt: "2026-08-03T11:00:00.000Z",
    expiresAt: "2026-08-03T13:00:00.000Z",
  });
  const stores = createMemoryStoreSuite({ now: clock.now });
  const effectUnitOfWork =
    options.effectStrategy === undefined && options.crashAfterTransition === undefined
      ? undefined
      : new MemoryCommandUnitOfWork(stores, {
          crashAfterTransitionKindOnce:
            options.crashAfterTransition ?? options.effectCrashAfterTransition,
        });
  const runCommandUnitOfWork =
    options.runCommandUnitOfWork ??
    effectUnitOfWork ??
    (options.atomicCommandAndWakeup === undefined
      ? stores.runCommandUnitOfWork
      : new MemoryCommandUnitOfWork(stores, {
          atomicCommandAndWakeup: options.atomicCommandAndWakeup,
        }));
  let modelInvocation = 0;
  let policyEvaluation = 0;
  const evidenceDigests = new Map<string, string>();
  const protectedValues = new Map<string, Uint8Array>();
  const inputProtector = {
    async protect(binding: Readonly<Record<string, string>>, plaintext: Uint8Array) {
      await Promise.resolve();
      const ciphertextRef = `input-${String(protectedValues.size + 1)}`;
      protectedValues.set(ciphertextRef, plaintext);
      return {
        schemaVersion: "1" as const,
        protectorId: "fixture",
        keyId: "fixture",
        ciphertextRef,
        ciphertextDigest: digestBytes(plaintext),
        aadDigest: options.inputProtectorAadMismatch ? d("0") : digestCanonicalJson(binding),
        algorithm: "fixture-process-local",
      };
    },
    async unprotect(
      _binding: Readonly<Record<string, string>>,
      reference: { ciphertextRef: string },
    ) {
      await Promise.resolve();
      const value = protectedValues.get(reference.ciphertextRef);
      if (value === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
      return value;
    },
  };
  const issuedChallenges = new Map<string, DecisionSubmissionChallenge>();
  const decisionChallengeIssuer: DecisionChallengeIssuer = {
    async issue(
      _authority: AuthorityContext,
      challengeRequest: DecisionChallengeIssueRequest,
      issuedCommand: CommandContext,
    ) {
      await Promise.resolve();
      const challengeProof = `proof:${issuedCommand.commandId}`;
      const challenge: DecisionSubmissionChallenge = {
        schemaVersion: "1",
        id: `challenge-${issuedCommand.commandId}`,
        issuerId: "fixture-challenge-issuer",
        proofDigest: options.challengeIssueMismatch
          ? d("0")
          : digestBytes(new TextEncoder().encode(challengeProof)),
        binding: challengeRequest.binding,
        requiredAuthenticationStrength: challengeRequest.requiredAuthenticationStrength,
        issuedAt: clock.now(),
        expiresAt: challengeRequest.expiresAt,
      };
      issuedChallenges.set(challengeProof, challenge);
      return {
        challengeProof,
        challenge,
      };
    },
    async verify(_authority: AuthorityContext, proof: string, binding: ProposedEffectBinding) {
      await Promise.resolve();
      const challenge = issuedChallenges.get(proof);
      if (
        challenge === undefined ||
        digestCanonicalJson(challenge.binding) !== digestCanonicalJson(binding)
      )
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH");
      return options.challengeVerifyMismatch
        ? { ...challenge, id: `${challenge.id}-changed` }
        : challenge;
    },
    async createApproval(_authority: AuthorityContext, challenge: DecisionSubmissionChallenge) {
      await Promise.resolve();
      return {
        schemaVersion: "1" as const,
        id: "approval-1",
        issuerId: "fixture-challenge-issuer",
        challengeId: challenge.id,
        challengeProofDigest: challenge.proofDigest,
        binding: challenge.binding,
        approvedBy: {
          type: "user" as const,
          id: options.approvalBindingMismatch ? "user-2" : "user-1",
        },
        authenticationStrength: "multi_factor" as const,
        createdAt: clock.now(),
        expiresAt: new Date(Date.parse(clock.now()) + 300_000).toISOString(),
        maximumUses: 1 as const,
      };
    },
  };
  let toolInvocation = 0;
  const executeTool = vi.fn(async (execution: { signal: AbortSignal }) => {
    await Promise.resolve();
    toolInvocation += 1;
    if (options.toolExecution !== undefined) {
      return options.toolExecution(toolInvocation, execution.signal);
    }
    return options.toolResult ?? { results: ["bounded result"] };
  });
  const effectServices: RuntimeEffectServices | undefined =
    options.effectStrategy === undefined || effectUnitOfWork === undefined
      ? undefined
      : {
          store: {
            async getByEffectId(_tenantId, _runId, effectId) {
              await Promise.resolve();
              return effectUnitOfWork.effectRecords.get(effectId);
            },
            async getByEffectKey(_tenantId, _runId, effectKey) {
              await Promise.resolve();
              const stored = [...effectUnitOfWork.effectRecords.values()].find(
                (record) => record.effectKey === effectKey,
              );
              return stored ?? options.effectExistingRecord?.(effectKey, _tenantId, _runId);
            },
            async getAcknowledgedResult(record) {
              await Promise.resolve();
              if (options.effectRecoveredResult !== undefined) {
                return options.effectRecoveredResult;
              }
              const protectedResult = effectUnitOfWork.effectResults.get(record.effectId);
              if (protectedResult === undefined) return undefined;
              const binding = protectedEffectResultAad(protectedResult);
              if (protectedResult.protectedValue.aadDigest !== digestCanonicalJson(binding)) {
                return undefined;
              }
              const plaintext = await inputProtector.unprotect(
                binding,
                protectedResult.protectedValue,
              );
              if (
                plaintext.byteLength !== protectedResult.byteSize ||
                digestBytes(plaintext) !== protectedResult.protectedValue.ciphertextDigest
              ) {
                return undefined;
              }
              const value = JSON.parse(new TextDecoder().decode(plaintext)) as JsonValue;
              return digestCanonicalJson(value) === protectedResult.resultDigest
                ? value
                : undefined;
            },
          },
          strategies: {
            resolve: (digest) => {
              if (options.effectStrategyUnavailable) return undefined;
              if (digest === tool.toolRegistrationDigest) return options.effectStrategy;
              return options.additionalEffectStrategies?.find(
                (entry) => entry.toolRegistrationDigest === digest,
              )?.strategy;
            },
          },
          authorization: {
            async resolve(effectRequest) {
              await Promise.resolve();
              const reservation = {
                schemaVersion: "1" as const,
                authorizationReservationId: `authorization-${effectRequest.effectId}`,
                authorizationKey: effectRequest.authorizationKey,
                tenantId: effectRequest.workOrder.tenant.id,
                runId: effectRequest.projection.runId,
                stepId: effectRequest.stepId,
                toolCallId: effectRequest.toolCallId,
                effectKey: effectRequest.effectKey,
                workOrderBindingDigest: effectRequest.workOrder.workOrderBindingDigest,
                executionDefinition: effectRequest.workOrder.executionDefinition,
                executionDefinitionDigest: effectRequest.workOrder.executionDefinitionDigest,
                toolId: effectRequest.registration.id,
                toolVersion: effectRequest.registration.implementationVersion,
                toolRegistrationDigest: effectRequest.registration.toolRegistrationDigest,
                policyRegistrationDigest: effectRequest.policyRegistrationDigest,
                argumentsDigest: effectRequest.argumentsDigest,
                normalizedTargetDigest: effectRequest.normalizedTargetDigest,
                grantId: "grant-effect",
                secretRefIds: [],
                purposeCode: effectRequest.workOrder.purpose.code,
                purposeRegistryVersion: effectRequest.workOrder.purpose.registryVersion,
                state: "reserved" as const,
                createdAt: clock.now(),
                expiresAt: "2026-08-03T12:30:00.000Z",
              };
              return (options.effectAuthorizationTransform?.(reservation) ?? reservation) as never;
            },
          },
        };
  const verifyArtifact = vi.fn(
    async (_id: string, artifact: Artifact): Promise<VerificationResult> => {
      await Promise.resolve();
      return {
        schemaVersion: "1",
        status: options.verificationStatus ?? "pass",
        verificationId: "verification-1",
        verificationDigest: d("f"),
        verifierId: d("7"),
        verifierVersion: "1",
        verifierRegistrationDigest: d("7"),
        method: "deterministic",
        artifactDigest: artifact.artifactDigest,
        findings:
          options.verificationStatus === "fail"
            ? [
                {
                  schemaVersion: "1",
                  code: "fixture_verification_failed",
                  severity: "error",
                  safeMessage: "Fixture verification failed.",
                },
              ]
            : [],
        rubricVersion: "1",
        rubricDigest: d("1"),
        verifiedAt: now,
      };
    },
  );
  const agentRegistry = {
    async register() {
      await Promise.resolve();
    },
    async resolve(agentId, version, digest) {
      await Promise.resolve();
      return options.resolveDefinition !== false &&
        agentId === registeredAgentDefinition.id &&
        version === registeredAgentDefinition.version &&
        digest === registeredAgentDefinition.agentDefinitionDigest
        ? registeredAgentDefinition
        : undefined;
    },
  };
  const runtimeConfig = {
    authorityIssuer,
    agentRegistry,
    purposeRegistry: { version: "general@1", has: (code) => code === "service_delivery" },
    acceptedWorkOrderStore: stores.acceptedWorkOrderStore,
    ...(options.commandSurface === false
      ? {}
      : {
          inputSubmissionStore: stores.inputSubmissionStore,
          inputProtector,
          typedInputRegistry: {
            validate: (inputSchemaDigest: string, inputValue: unknown) => ({
              schemaVersion: "1" as const,
              inputSchemaDigest: options.typedInputDigestOverride ?? inputSchemaDigest,
              value: inputValue as JsonValue,
            }),
          },
          decisionStore: stores.decisionStore,
          decisionChallengeIssuer,
          decisionPreviewer: {
            async preview() {
              await Promise.resolve();
              return { schemaVersion: "1" as const, previewDigest: d("a") };
            },
          },
        }),
    eventStore: stores.eventStore,
    artifactStore: stores.artifactStore,
    contextStore: stores.contextStore,
    contextProtector: inputProtector,
    contextCheckpointTransactionDomain:
      options.contextCheckpointTransactionDomain ?? runCommandUnitOfWork.transactionDomain,
    leaseStore: stores.leaseStore,
    runCommandUnitOfWork,
    ...(options.productionModelServices === undefined
      ? {}
      : { productionModelServices: options.productionModelServices }),
    ...(options.requireProductionModelBoundary === undefined
      ? {}
      : { requireProductionModelBoundary: options.requireProductionModelBoundary }),
    ...(options.killSwitches === undefined ? {} : { killSwitches: options.killSwitches }),
    ...(effectServices === undefined
      ? {}
      : {
          effectServices,
          ...(options.effectResultProtectorMode === "missing"
            ? {}
            : {
                effectResultProtector:
                  options.effectResultProtectorMode === "aad_mismatch"
                    ? {
                        ...inputProtector,
                        async protect(
                          binding: Readonly<Record<string, string>>,
                          plaintext: Uint8Array,
                        ) {
                          const protectedValue = await inputProtector.protect(binding, plaintext);
                          return { ...protectedValue, aadDigest: d("0") };
                        },
                      }
                    : inputProtector,
              }),
        }),
    ...(options.compensationServices === undefined
      ? {}
      : { compensationServices: options.compensationServices }),
    modelDriver: {
      capabilities: caps,
      ...(options.modelErrorClassification === undefined
        ? {}
        : { classifyError: () => options.modelErrorClassification! }),
      async *invoke({ input, signal }) {
        await Promise.resolve();
        modelInvocation += 1;
        if (options.modelEmission !== undefined) {
          const emission = await options.modelEmission(modelInvocation, signal, input);
          if (emission !== undefined) yield emission as never;
        } else if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          !("toolResult" in input)
        ) {
          yield {
            type: "tool_call",
            value: {
              toolRegistrationDigest: tool.toolRegistrationDigest,
              input: { query: "Pactmark" },
              targetDigest: d("2"),
            },
          };
        } else {
          yield { type: "final", value: { title: "Result", body: "Verified" } };
        }
      },
    },
    toolRegistry: {
      resolve: (digest) => {
        if (digest === tool.toolRegistrationDigest) {
          return options.toolRegistration === null ? undefined : (options.toolRegistration ?? tool);
        }
        return options.additionalToolRegistrations?.find(
          (registration) => registration.toolRegistrationDigest === digest,
        );
      },
    },
    toolCallResolver: {
      resolve: ({ workOrder, proposedInput }) =>
        Promise.resolve({
          validatedInput: proposedInput,
          resources: [
            {
              kind: "tenant",
              value: workOrder.tenant.id,
              normalizationVersion: "pactmark.policy-normalization@1",
            },
          ],
        }),
    },
    policyEngine: {
      async evaluate(input) {
        await Promise.resolve();
        const sequence = options.policyDecisionSequence;
        const sequencedDecision =
          sequence === undefined || sequence.length === 0
            ? undefined
            : sequence[Math.min(policyEvaluation, sequence.length - 1)];
        policyEvaluation += 1;
        const decision = sequencedDecision ?? options.policyDecision ?? "allow_with_grant";
        if (decision === "deny") return { decision, reasonCode: "fixture_policy" };
        return {
          decision,
          reasonCode: "fixture_policy",
          normalizedResources: input.resources,
          normalizedTargetDigest:
            options.policyTargetDigest ??
            (input.workOrder.kind === "compensation"
              ? digestCanonicalJson(`effect:${input.workOrder.originalEffectDigest}`)
              : input.tool.effectStrategyKind === "read"
                ? d("2")
                : effectTargetDigest),
        };
      },
    },
    toolExecutor: {
      capabilities: caps,
      networkPolicy: "none",
      execute: executeTool,
      ...(options.toolErrorClassification === undefined
        ? {}
        : { classifyError: () => options.toolErrorClassification! }),
    },
    verifierRegistry: {
      has: (id) => options.verifierAvailable !== false && id === d("7"),
      verify: verifyArtifact,
    },
    evidenceBuilder: {
      async build(input) {
        await Promise.resolve();
        const evidenceDigest = digestCanonicalJson(input);
        evidenceDigests.set(input.run.runId, evidenceDigest);
        return {
          evidenceRecordId: `evidence-${evidenceDigest.slice("sha256:".length)}`,
          runId: input.run.runId,
        } as never;
      },
    },
    clock,
    idGenerator: ids,
    ...(options.wakeupScheduler === undefined ? {} : { wakeupScheduler: options.wakeupScheduler }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.retryJitterSource === undefined
      ? {}
      : { retryJitterSource: options.retryJitterSource }),
    ...(options.activeExecutionServices === undefined
      ? {}
      : { activeExecutionServices: options.activeExecutionServices }),
    leaseHolderId: "test-runtime",
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    ...(options.decisionChallengeTtlMs === undefined
      ? {}
      : { decisionChallengeTtlMs: options.decisionChallengeTtlMs }),
  } satisfies RuntimeKernelConfig;
  const runtime = createRuntime(runtimeConfig);
  const command = createCommandContext({
    commandId: "kafcmd_1785758400000_00000000000000000000000000000000",
    operation: "run.start",
    payload: request,
  });
  return {
    runtime,
    restart: () => createRuntime({ ...runtimeConfig, leaseHolderId: "test-runtime-restarted" }),
    authority,
    authorityIssuer,
    stores,
    command,
    executeTool,
    verifyArtifact,
    runCommandUnitOfWork,
    effectUnitOfWork,
    effectServices,
    agentRegistry,
    getIssuedChallenge: (proof: string) => issuedChallenges.get(proof),
    getModelInvocationCount: () => modelInvocation,
    getEvidenceDigest: (runId: string) => evidenceDigests.get(runId),
  };
}

function commandFor(
  operation: string,
  payload: unknown,
  suffix = "22222222222222222222222222222222",
) {
  return createCommandContext({
    commandId: `kafcmd_1785758400002_${suffix}`,
    operation,
    payload,
  });
}

function scopedCommand(
  operation: string,
  payload: unknown,
  resources: readonly string[],
  suffix: string,
) {
  return createCommandContext({
    commandId: `kafcmd_1785758400002_${suffix}`,
    operation,
    payload,
    normalizedResourceScope: resources.map((value) => ({
      kind: "opaque",
      value,
      normalizationVersion: "fixture@1",
    })),
  });
}

async function collectEvents(store: EventStore, tenantId: string, runId: string) {
  const events: RunEvent[] = [];
  for await (const event of store.read(tenantId, runId)) events.push(event);
  return events;
}

async function seedWaitingInput(
  stores: ReturnType<typeof createMemoryStoreSuite>,
  runId: string,
  inputSchemaDigest = d("c"),
): Promise<void> {
  const accepted = (await collectEvents(stores.eventStore, "tenant-1", runId))[0]!;
  await stores.eventStore.append(
    {
      ...accepted,
      eventId: "event-planning-input",
      sequence: 2,
      eventType: "PlanningStarted",
      payload: { stepId: "step-input" },
    },
    1,
  );
  await stores.eventStore.append(
    {
      ...accepted,
      eventId: "event-input-requested",
      sequence: 3,
      eventType: "InputRequested",
      payload: {
        stepId: "step-input",
        requestId: "request-input",
        inputSchemaDigest,
        safePrompt: "Provide the bounded value.",
      },
    },
    2,
  );
}

async function parkAndIssue(value: ReturnType<typeof fixture>, suffix: string) {
  const started = await value.runtime.start(value.authority, definition, request, value.command);
  await value.runtime.execute(value.authority, started.runId);
  const decisionId = (await value.runtime.getRun(value.authority, started.runId))
    .waitingDecisionId!;
  const issued = await value.runtime.issueDecisionChallenge(
    value.authority,
    started.runId,
    decisionId,
    scopedCommand("run.issue_decision_challenge", {}, [started.runId, decisionId], suffix),
  );
  return { started, decisionId, issued };
}

const effectTarget = "urn:pactmark:fixture:effect";
const effectTargetDigest = digestCanonicalJson(effectTarget);
const writeTool: ToolRegistrationContract = {
  ...tool,
  description: "fixture governed write",
  security: {
    ...tool.security,
    riskClass: "R3",
    reversibility: "compensatable",
    requiredScopes: ["knowledge:write"],
  },
  previewStrategyRegistrationDigest: d("8"),
  effectStrategyKind: "native",
  compensationStrategyRegistrationDigest: d("9"),
};
const writePreviewRegistrationDigest = writeTool.previewStrategyRegistrationDigest;
const writeCompensationRegistrationDigest = writeTool.compensationStrategyRegistrationDigest;
if (writePreviewRegistrationDigest === undefined) {
  throw new Error("write fixture must register a preview");
}
if (writeCompensationRegistrationDigest === undefined) {
  throw new Error("write fixture must register compensation");
}
const compensationToolBase = omitProperty(writeTool, "compensationStrategyRegistrationDigest");
const compensationTool: ToolRegistrationContract = {
  ...compensationToolBase,
  id: "knowledge.undo.v1",
  description: "fixture compensation write",
  inputSchemaDigest: d("1"),
  outputSchemaDigest: d("2"),
  security: {
    ...writeTool.security,
    riskClass: "R2",
    reversibility: "irreversible",
    requiredScopes: ["knowledge:undo"],
  },
  previewStrategyRegistrationDigest: d("3"),
  effectStrategyRegistrationDigest: d("4"),
  toolRegistrationDigest: d("0"),
};
const compensationPreviewRegistrationDigest = compensationTool.previewStrategyRegistrationDigest;
if (compensationPreviewRegistrationDigest === undefined) {
  throw new Error("compensation fixture must register a preview");
}

const compensationDefinition: CompensationRunDefinition = {
  schemaVersion: "1",
  id: "knowledge-undo-compensation",
  version: "1.0.0",
  originalAgentDefinitionDigest: definition.agentDefinitionDigest,
  originalToolRegistrationDigest: writeTool.toolRegistrationDigest,
  originalEffectSchemaDigest: d("1"),
  acknowledgementSchemaDigest: d("2"),
  compensationStrategyRegistrationDigest: writeCompensationRegistrationDigest,
  compensationToolId: compensationTool.id,
  compensationToolVersion: compensationTool.implementationVersion,
  compensationToolRegistrationDigest: compensationTool.toolRegistrationDigest,
  compensationInputSchemaDigest: compensationTool.inputSchemaDigest,
  compensationOutputSchemaDigest: compensationTool.outputSchemaDigest,
  requiredVerifierRegistrationDigests: [d("7")],
  policyRegistrationDigest: definition.policyRegistrationDigest,
  purposeCode: "service_delivery",
  purposeRegistryVersion: "general@1",
  requiredCapabilities: ["knowledge:undo"],
  executorVersion: "fixture-compensation-executor@1",
  compensationRunDefinitionDigest: d("5"),
};

function effectPreview() {
  const material = {
    schemaVersion: "1" as const,
    normalizedTarget: effectTarget,
    operationClass: "fixture_write",
    contentDigest: d("a"),
    reversibility: "compensatable" as const,
    materialConsequence: "Writes one bounded fixture record.",
  };
  return { ...material, previewDigest: digestCanonicalJson(material) };
}

function acknowledgedExecution(
  context: { effectKey: string; normalizedTargetDigest: string },
  operationKey?: string,
  proofKind: "receiver_receipt" | "lookup_recovery" = "receiver_receipt",
) {
  return acknowledgedExecutionFor(writeTool, context, operationKey, proofKind);
}

function acknowledgedExecutionFor(
  registration: ToolRegistrationContract,
  context: { effectKey: string; normalizedTargetDigest: string },
  operationKey?: string,
  proofKind: "receiver_receipt" | "lookup_recovery" = "receiver_receipt",
) {
  const result = { written: true };
  const proofMaterial = {
    schemaVersion: "1" as const,
    acknowledgementId: "ack-fixture",
    proofKind,
    effectKey: context.effectKey,
    ...(operationKey === undefined ? {} : { operationKey }),
    toolRegistrationDigest: registration.toolRegistrationDigest,
    strategyRegistrationDigest: registration.effectStrategyRegistrationDigest,
    normalizedTargetDigest: context.normalizedTargetDigest,
    resultSchemaDigest: registration.outputSchemaDigest,
    resultDigest: digestCanonicalJson(result),
    safeReceiptMetadata: { receiver: "fixture" },
    acknowledgedAt: now,
  };
  return {
    schemaVersion: "1" as const,
    result,
    acknowledgement: { ...proofMaterial, proofDigest: effectProofDigest(proofMaterial) },
  };
}

function nativeEffectStrategy(dispatch: ReturnType<typeof vi.fn>): RuntimeExecutableEffectStrategy {
  return {
    kind: "native",
    registrationDigest: writeTool.effectStrategyRegistrationDigest,
    previewRegistrationDigest: writePreviewRegistrationDigest,
    preview: async () => Promise.resolve(effectPreview()),
    validateOutput: (value) => value as JsonValue,
    operationKey: (_value, binding) => `operation:${binding.effectKey}`,
    dispatch: async (_value, operationKey, context) => {
      await dispatch();
      return acknowledgedExecution(context, operationKey);
    },
  };
}

function noneEffectStrategy(dispatch: ReturnType<typeof vi.fn>): RuntimeExecutableEffectStrategy {
  return {
    kind: "none",
    registrationDigest: writeTool.effectStrategyRegistrationDigest,
    previewRegistrationDigest: writePreviewRegistrationDigest,
    preview: async () => Promise.resolve(effectPreview()),
    validateOutput: (value) => value as JsonValue,
    dispatch: async (_value, context) => {
      await dispatch();
      return acknowledgedExecution(context);
    },
  };
}

function reconcilableEffectStrategy(input: {
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly lookup: ReturnType<typeof vi.fn>;
}): RuntimeExecutableEffectStrategy {
  return {
    kind: "reconcilable",
    registrationDigest: writeTool.effectStrategyRegistrationDigest,
    previewRegistrationDigest: writePreviewRegistrationDigest,
    preview: async () => Promise.resolve(effectPreview()),
    validateOutput: (value) => value as JsonValue,
    operationKey: (_value, binding) => `operation:${binding.effectKey}`,
    lookup: async (operationKey, context) => {
      await input.lookup();
      return {
        status: "applied" as const,
        execution: acknowledgedExecution(context, operationKey, "lookup_recovery"),
      };
    },
    dispatch: async () => {
      await input.dispatch();
      throw new Error("dispatch response lost");
    },
  };
}

const existingEffectInput = { value: "existing" } as const;

function ledgerRecord(
  effectKey: string,
  tenantId: string,
  runId: string,
  state: "dispatched" | "unknown" | "needs_reconciliation" | "acknowledged" | "abandoned",
  strategy: "native" | "reconcilable" | "none" = "native",
): EffectRecord {
  const base = {
    schemaVersion: "1" as const,
    effectId: "effect-existing",
    effectDigest: d("1"),
    tenantId,
    runId,
    stepId: "step-existing",
    toolCallId: "tool-call-existing",
    effectKey,
    ...(strategy === "none" ? {} : { operationKey: `operation:${effectKey}` }),
    executionDefinition: {
      kind: "agent" as const,
      id: definition.id,
      version: definition.version,
      agentDefinitionDigest: definition.agentDefinitionDigest,
    },
    executionDefinitionDigest: d("2"),
    workOrderBindingDigest: d("3"),
    toolId: writeTool.id,
    toolVersion: writeTool.implementationVersion,
    toolRegistrationDigest: writeTool.toolRegistrationDigest,
    strategy,
    strategyRegistrationDigest: writeTool.effectStrategyRegistrationDigest,
    authorizationReservationId: "authorization-existing",
    argumentsDigest: digestCanonicalJson(existingEffectInput),
    normalizedTargetDigest: effectTargetDigest,
    createdAt: now,
    updatedAt: now,
  };
  if (state === "dispatched") return { ...base, state, dispatchedAt: now };
  if (state === "unknown") {
    return { ...base, state, dispatchedAt: now, uncertaintyCode: "response_lost" };
  }
  if (state === "needs_reconciliation") {
    return { ...base, state, uncertaintyCode: "response_lost", effectMayHaveOccurred: true };
  }
  if (state === "abandoned") {
    return {
      ...base,
      state,
      reason: "operator abandoned uncertainty",
      evidenceRefs: [],
      effectMayHaveOccurred: true,
    };
  }
  const execution = acknowledgedExecution(
    { effectKey, normalizedTargetDigest: effectTargetDigest },
    strategy === "none" ? undefined : `operation:${effectKey}`,
  );
  return {
    ...base,
    state,
    resultDigest: digestCanonicalJson(execution.result),
    acknowledgement: execution.acknowledgement,
  };
}

describe("runtime effect validation", () => {
  const context = {
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: "step-1",
    toolCallId: "tool-call-1",
    effectId: "effect-1",
    effectKey: "effect-key-1",
    normalizedTargetDigest: effectTargetDigest,
    signal: new AbortController().signal,
  };

  it("accepts an acknowledgement without an operation key, as kind-none strategies produce", () => {
    const strategy = nativeEffectStrategy(vi.fn(async () => Promise.resolve()));
    const execution = acknowledgedExecution(context);
    expect(
      validateEffectExecution({
        execution,
        strategy,
        registration: writeTool,
        effectKey: context.effectKey,
        normalizedTargetDigest: effectTargetDigest,
      }),
    ).toMatchObject({ result: execution.result });
  });

  it("rejects acknowledgement binding drift and a forged proof digest", () => {
    const strategy = nativeEffectStrategy(vi.fn(async () => Promise.resolve()));
    const operationKey = "operation:effect-key-1";
    const execution = acknowledgedExecution(context, operationKey);
    expect(
      validateEffectExecution({
        execution,
        strategy,
        registration: writeTool,
        effectKey: context.effectKey,
        operationKey,
        normalizedTargetDigest: effectTargetDigest,
      }),
    ).toMatchObject({ result: execution.result });
    expect(() =>
      validateEffectExecution({
        execution: {
          ...execution,
          acknowledgement: { ...execution.acknowledgement, effectKey: "changed" },
        },
        strategy,
        registration: writeTool,
        effectKey: context.effectKey,
        operationKey,
        normalizedTargetDigest: effectTargetDigest,
      }),
    ).toThrow(expect.objectContaining({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" }));
    expect(() =>
      validateEffectExecution({
        execution: {
          ...execution,
          acknowledgement: { ...execution.acknowledgement, proofDigest: d("0") },
        },
        strategy,
        registration: writeTool,
        effectKey: context.effectKey,
        operationKey,
        normalizedTargetDigest: effectTargetDigest,
      }),
    ).toThrow(expect.objectContaining({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" }));
  });

  it("rejects every preview registration, target, digest, and determinism drift", async () => {
    const base = nativeEffectStrategy(vi.fn(async () => Promise.resolve()));
    const registrationWithoutPreview = omitProperty(writeTool, "previewStrategyRegistrationDigest");
    const cases: ReadonlyArray<{
      registration: ToolRegistrationContract;
      strategy: RuntimeExecutableEffectStrategy;
      target: typeof effectTargetDigest;
    }> = [
      {
        registration: registrationWithoutPreview,
        strategy: base,
        target: effectTargetDigest,
      },
      {
        registration: writeTool,
        strategy: { ...base, previewRegistrationDigest: d("0") },
        target: effectTargetDigest,
      },
      { registration: writeTool, strategy: base, target: d("0") },
      {
        registration: writeTool,
        strategy: {
          ...base,
          preview: async () => Promise.resolve({ ...effectPreview(), previewDigest: d("0") }),
        },
        target: effectTargetDigest,
      },
    ];
    for (const candidate of cases) {
      await expect(
        validateEffectPreview({
          strategy: candidate.strategy,
          registration: candidate.registration,
          value: existingEffectInput,
          context,
          normalizedTargetDigest: candidate.target,
        }),
      ).rejects.toMatchObject({ code: "KAF_POLICY_DENIED" });
    }
    let invocation = 0;
    await expect(
      validateEffectPreview({
        strategy: {
          ...base,
          preview: async () => {
            await Promise.resolve();
            invocation += 1;
            const preview = effectPreview();
            return invocation === 1
              ? preview
              : { ...preview, materialConsequence: "changed consequence" };
          },
        },
        registration: writeTool,
        value: existingEffectInput,
        context,
        normalizedTargetDigest: effectTargetDigest,
      }),
    ).rejects.toMatchObject({ code: "KAF_POLICY_DENIED" });
  });

  it("accepts a deterministic diff preview and binds optional receipt metadata", async () => {
    const diffMaterial = { ...effectPreview(), diffDigest: d("f") };
    const material = omitProperty(diffMaterial, "previewDigest");
    const strategy = {
      ...nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
      preview: async () =>
        Promise.resolve({ ...diffMaterial, previewDigest: digestCanonicalJson(material) }),
    };
    await expect(
      validateEffectPreview({
        strategy,
        registration: writeTool,
        value: existingEffectInput,
        context,
        normalizedTargetDigest: effectTargetDigest,
      }),
    ).resolves.toMatchObject({ diffDigest: d("f") });
    const withoutOptionalReceipt = {
      ...acknowledgedExecution(context, "operation:effect-key-1").acknowledgement,
      safeReceiptMetadata: undefined,
    };
    const proofMaterial = omitProperty(
      omitProperty(withoutOptionalReceipt, "proofDigest"),
      "safeReceiptMetadata",
    );
    expect(effectProofDigest(proofMaterial)).toMatch(/^sha256:/u);
    const noOperationAcknowledgement = acknowledgedExecution(context).acknowledgement;
    expect(
      effectProofDigest(
        omitProperty(
          omitProperty(noOperationAcknowledgement, "proofDigest"),
          "safeReceiptMetadata",
        ),
      ),
    ).toMatch(/^sha256:/u);
  });

  it("validates authorization timing and rejects binding, expiry, and secret claims", async () => {
    const value = fixture();
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    const projection = await value.runtime.getRun(value.authority, started.runId);
    const workOrder = await value.stores.acceptedWorkOrderStore.get(
      "tenant-1",
      started.workOrderId,
    );
    expect(workOrder?.kind).toBe("agent");
    if (workOrder?.kind !== "agent") throw new Error("fixture WorkOrder missing");
    const authorizationRequest = {
      workOrder,
      projection,
      registration: writeTool,
      stepId: "step-auth",
      toolCallId: "tool-call-auth",
      effectId: "effect-auth",
      effectKey: "effect-key-auth",
      argumentsDigest: digestCanonicalJson(existingEffectInput),
      normalizedTargetDigest: effectTargetDigest,
      authorizationKey: "authorization-key-auth",
      policyRegistrationDigest: definition.policyRegistrationDigest,
    };
    const reservation = {
      schemaVersion: "1" as const,
      authorizationReservationId: "authorization-auth",
      authorizationKey: authorizationRequest.authorizationKey,
      tenantId: workOrder.tenant.id,
      runId: projection.runId,
      stepId: authorizationRequest.stepId,
      toolCallId: authorizationRequest.toolCallId,
      effectKey: authorizationRequest.effectKey,
      workOrderBindingDigest: workOrder.workOrderBindingDigest,
      executionDefinition: workOrder.executionDefinition,
      executionDefinitionDigest: workOrder.executionDefinitionDigest,
      toolId: writeTool.id,
      toolVersion: writeTool.implementationVersion,
      toolRegistrationDigest: writeTool.toolRegistrationDigest,
      policyRegistrationDigest: definition.policyRegistrationDigest,
      argumentsDigest: authorizationRequest.argumentsDigest,
      normalizedTargetDigest: effectTargetDigest,
      grantId: "grant-auth",
      secretRefIds: [],
      purposeCode: workOrder.purpose.code,
      purposeRegistryVersion: workOrder.purpose.registryVersion,
      state: "reserved" as const,
      createdAt: now,
      expiresAt: "2026-08-03T12:30:00.000Z",
    };
    expect(
      validateAuthorizationReservation({ reservation, request: authorizationRequest, now }),
    ).toMatchObject({ authorizationReservationId: "authorization-auth" });
    for (const invalid of [
      { ...reservation, authorizationKey: "changed" },
      { ...reservation, createdAt: "2026-08-03T12:00:00.001Z" },
      { ...reservation, expiresAt: now },
      { ...reservation, secretRefIds: ["secret-ref"] },
    ]) {
      expect(() =>
        validateAuthorizationReservation({
          reservation: invalid,
          request: authorizationRequest,
          now,
        }),
      ).toThrow(expect.objectContaining({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" }));
    }
  });

  it("rejects effect ledger lookup drift", () => {
    const record = ledgerRecord("effect-key", "tenant-1", "run-1", "dispatched");
    const expected = {
      tenantId: "tenant-1",
      runId: "run-1",
      effectKey: "effect-key",
      toolRegistrationDigest: writeTool.toolRegistrationDigest,
      argumentsDigest: digestCanonicalJson(existingEffectInput),
      normalizedTargetDigest: effectTargetDigest,
    };
    expect(assertEffectRecordBinding(record, expected)).toEqual(record);
    expect(() => assertEffectRecordBinding(record, { ...expected, runId: "run-2" })).toThrow(
      expect.objectContaining({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" }),
    );
  });
});

describe("AgentRuntime", () => {
  const effectRequest = { ...request, requestedCapabilities: ["knowledge:write"] };
  const effectEmission = (invocation: number) =>
    invocation === 1
      ? {
          type: "tool_call" as const,
          value: {
            toolRegistrationDigest: writeTool.toolRegistrationDigest,
            input: existingEffectInput,
            targetDigest: effectTargetDigest,
          },
        }
      : { type: "final" as const, value: { ok: true } };
  const recoveredResolution = {
    schemaVersion: "1" as const,
    kind: "recovered_acknowledgement" as const,
  };
  const abandonResolution = {
    schemaVersion: "1" as const,
    kind: "abandon_uncertain" as const,
    reason: "operator cannot prove the remote outcome",
    evidenceRefs: ["incident-coverage"],
    effectMayHaveOccurred: true as const,
  };

  async function parkedEffect(options: FixtureOptions = {}) {
    const value = fixture({
      decisionRoles: ["effect:reconcile"],
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(
        vi.fn(async () => Promise.reject(new Error("receiver response lost"))),
      ),
      modelEmission: effectEmission,
      ...options,
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "edededededededededededededededed"),
    );
    await value.runtime.execute(value.authority, started.runId);
    const effectId = (await value.runtime.getRun(value.authority, started.runId)).activeEffectId;
    if (effectId === null) throw new Error("fixture did not park at an effect");
    return { value, started, effectId };
  }

  it.each([
    "RunAccepted",
    "PlanningStarted",
    "ModelCallStarted",
    "ModelCallCompleted",
    "ExecutionStarted",
    "ToolCallRequested",
    "ToolCallCompleted",
    "PlanningStarted#2",
    "ModelCallStarted#2",
    "ModelCallCompleted#2",
    "ExecutionStarted#2",
    "ArtifactProduced",
    "VerificationStarted",
    "VerificationRecorded",
    "RunCompleted",
  ])("recovers R0-R1 execution from a fresh runtime after committed %s", async (crashBoundary) => {
    async function proof(value: ReturnType<typeof fixture>, runId: string) {
      const projection = await value.runtime.getRun(value.authority, runId);
      const events = await collectEvents(value.stores.eventStore, "tenant-1", runId);
      const artifactId = projection.artifactIds[0];
      if (artifactId === undefined) throw new Error("completed run did not produce an artifact");
      const artifact = await value.stores.artifactStore.get("tenant-1", artifactId);
      if (artifact === undefined) throw new Error("completed artifact is unavailable");
      const evidenceDigest = value.getEvidenceDigest(runId);
      if (evidenceDigest === undefined) throw new Error("completed evidence digest is unavailable");
      return {
        projectionDigest: digestCanonicalJson(projection),
        eventDigest: digestCanonicalJson(events),
        artifactDigest: artifact.artifact.artifactDigest,
        artifactContentDigest: digestBytes(artifact.content),
        evidenceDigest,
      };
    }

    const baseline = fixture();
    const baselineStarted = await baseline.runtime.start(
      baseline.authority,
      definition,
      request,
      baseline.command,
    );
    await expect(
      baseline.runtime.execute(baseline.authority, baselineStarted.runId),
    ).resolves.toEqual({ runId: baselineStarted.runId, status: "completed" });
    const baselineProof = await proof(baseline, baselineStarted.runId);

    const crashed = fixture({ crashAfterTransition: crashBoundary });
    let runId = "run-1";
    if (crashBoundary === "RunAccepted") {
      await expect(
        crashed.runtime.start(crashed.authority, definition, request, crashed.command),
      ).rejects.toThrow("simulated crash after committed RunAccepted");
    } else {
      const started = await crashed.runtime.start(
        crashed.authority,
        definition,
        request,
        crashed.command,
      );
      runId = started.runId;
      const committedBoundary = crashBoundary.split("#")[0] ?? crashBoundary;
      await expect(crashed.runtime.execute(crashed.authority, runId)).rejects.toThrow(
        `simulated crash after committed ${committedBoundary}`,
      );
    }

    const restarted = crashed.restart();
    await expect(restarted.execute(crashed.authority, runId)).resolves.toEqual({
      runId,
      status: "completed",
    });
    expect(await proof(crashed, runId)).toEqual(baselineProof);
    expect(crashed.executeTool).toHaveBeenCalledOnce();
    expect(crashed.verifyArtifact).toHaveBeenCalledOnce();
  });

  it("fails the run when a protected context checkpoint exceeds its byte budget", async () => {
    const value = fixture();
    const boundedRequest = {
      ...request,
      budget: { ...request.budget, maxContextSnapshotBytes: 1 },
    };
    const started = await value.runtime.start(
      value.authority,
      definition,
      boundedRequest,
      commandFor("run.start", boundedRequest, "30303030303030303030303030303030"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "failed",
    });
  });

  it("retries classified local model and R0-R1 tool failures with deterministic backoff", async () => {
    const modelSleeps: number[] = [];
    const model = fixture({
      modelErrorClassification: "retryable",
      retryPolicy: {
        maximumAttempts: () => 2,
        backoffMilliseconds: ({ jitter }) => 25 + Math.round(jitter * 10),
      },
      retryJitterSource: { next: () => 0.5 },
      sleep: (milliseconds) => {
        modelSleeps.push(milliseconds);
        return Promise.resolve();
      },
      modelEmission: (invocation) => {
        if (invocation === 1) throw new Error("retryable model failure");
        return { type: "final", value: { recovered: true } };
      },
    });
    const modelRun = await model.runtime.start(model.authority, definition, request, model.command);
    await expect(model.runtime.execute(model.authority, modelRun.runId)).resolves.toEqual({
      runId: modelRun.runId,
      status: "completed",
    });
    expect(modelSleeps).toEqual([30]);
    const modelEvents = await collectEvents(model.stores.eventStore, "tenant-1", modelRun.runId);
    expect(modelEvents.filter((event) => event.eventType === "ModelCallStarted")).toHaveLength(2);
    expect(modelEvents.filter((event) => event.eventType === "RetryScheduled")).toHaveLength(1);
    expect(modelEvents.filter((event) => event.eventType === "RetryResumed")).toHaveLength(1);

    const toolSleeps: number[] = [];
    const retriedTool = fixture({
      toolErrorClassification: "timed_out",
      retryPolicy: {
        maximumAttempts: () => 2,
        backoffMilliseconds: () => 10,
      },
      sleep: (milliseconds) => {
        toolSleeps.push(milliseconds);
        return Promise.resolve();
      },
      toolExecution: (invocation) =>
        invocation === 1
          ? Promise.reject(new Error("tool timeout"))
          : Promise.resolve({ results: ["recovered"] }),
    });
    const toolRun = await retriedTool.runtime.start(
      retriedTool.authority,
      definition,
      request,
      retriedTool.command,
    );
    await expect(
      retriedTool.runtime.execute(retriedTool.authority, toolRun.runId),
    ).resolves.toEqual({
      runId: toolRun.runId,
      status: "completed",
    });
    expect(toolSleeps).toEqual([10]);
    expect(retriedTool.executeTool).toHaveBeenCalledTimes(2);
    const toolEvents = await collectEvents(
      retriedTool.stores.eventStore,
      "tenant-1",
      toolRun.runId,
    );
    expect(toolEvents.filter((event) => event.eventType === "ToolCallRequested")).toHaveLength(1);
    expect(toolEvents.filter((event) => event.eventType === "RetryScheduled")).toHaveLength(1);
  });

  it("recovers a persisted scheduled backoff on a fresh runtime", async () => {
    let wallClock = Date.parse(now);
    const sleeps: number[] = [];
    const value = fixture({
      crashAfterTransition: "RetryScheduled",
      clockNow: () => new Date(wallClock).toISOString(),
      modelErrorClassification: "retryable",
      retryPolicy: {
        maximumAttempts: () => 2,
        backoffMilliseconds: () => 40,
      },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        wallClock += milliseconds;
        return Promise.resolve();
      },
      modelEmission: (invocation) => {
        if (invocation === 1) throw new Error("host lost before backoff");
        return { type: "final", value: { recovered: true } };
      },
    });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
      "simulated crash after committed RetryScheduled",
    );
    await expect(value.restart().execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "completed",
    });
    expect(sleeps).toEqual([40]);
  });

  it("closes an interrupted active execution at its maximum before a new attempt", async () => {
    const holder: { value?: ReturnType<typeof fixture> } = {};
    const activeExecutionServices: NonNullable<RuntimeKernelConfig["activeExecutionServices"]> = {
      transactionDomain: "memory.process-local",
      durable: true,
      reader: {
        get(tenantId, runId, stepId, boundary, boundaryKey) {
          const value = holder.value;
          if (value === undefined) throw new Error("fixture unavailable");
          return Promise.resolve(
            value.stores.activeExecutionReservationStore.get(
              tenantId,
              runId,
              stepId,
              boundary,
              boundaryKey,
            ),
          );
        },
      },
      maximumChargeMilliseconds: () => 100,
    };
    const value = fixture({
      activeExecutionServices,
      crashAfterTransition: "active_execution_reservation",
      retryPolicy: {
        maximumAttempts: () => 2,
        backoffMilliseconds: () => 0,
      },
      retryJitterSource: { next: () => 0 },
      modelEmission: () => ({ type: "final", value: { recovered: true } }),
    });
    holder.value = value;
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
      "simulated crash after committed active_execution_reservation",
    );
    expect(value.getModelInvocationCount()).toBe(0);

    await expect(value.restart().execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "completed",
    });
    expect(value.getModelInvocationCount()).toBe(1);
    const modelReservations = value.stores.activeExecutionReservationStore
      .snapshot()
      .map(([, reservation]) => reservation)
      .filter((reservation) => reservation.boundary === "model");
    expect(modelReservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          boundaryKey: "model:step-1:1",
          state: "closed_uncertain",
          settledChargeMs: 100,
          refundedMs: 0,
        }),
        expect.objectContaining({ boundaryKey: "model:step-1:2", state: "settled" }),
      ]),
    );
  });

  it("settles failed boundaries and safely resumes a completed scheduled-backoff reservation", async () => {
    const holder: { value?: ReturnType<typeof fixture> } = {};
    const activeExecutionServices: NonNullable<RuntimeKernelConfig["activeExecutionServices"]> = {
      transactionDomain: "memory.process-local",
      durable: true,
      reader: {
        get(tenantId, runId, stepId, boundary, boundaryKey) {
          const value = holder.value;
          if (value === undefined) throw new Error("fixture unavailable");
          return Promise.resolve(
            value.stores.activeExecutionReservationStore.get(
              tenantId,
              runId,
              stepId,
              boundary,
              boundaryKey,
            ),
          );
        },
      },
      maximumChargeMilliseconds: () => 100,
    };
    const sleeps: number[] = [];
    const value = fixture({
      activeExecutionServices,
      crashAfterTransition: "active_execution_reservation#4",
      modelErrorClassification: "retryable",
      retryPolicy: {
        maximumAttempts: () => 2,
        backoffMilliseconds: () => 40,
      },
      retryJitterSource: { next: () => 0 },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      modelEmission: (invocation) => {
        if (invocation === 1) throw new Error("retryable provider failure");
        return { type: "final", value: { recovered: true } };
      },
    });
    holder.value = value;
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
      "simulated crash after committed active_execution_reservation",
    );
    await expect(value.restart().execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "completed",
    });
    expect(sleeps).toEqual([40, 40]);
    const reservations = value.stores.activeExecutionReservationStore
      .snapshot()
      .map(([, reservation]) => reservation);
    expect(
      reservations.find((reservation) => reservation.boundary === "scheduled_backoff"),
    ).toMatchObject({ state: "settled" });
    expect(
      reservations.find(
        (reservation) => reservation.boundary === "model" && reservation.boundaryKey.endsWith(":1"),
      ),
    ).toMatchObject({ state: "settled" });
  });

  it.each([
    ["invalid maximum", "memory.process-local", 0, "KAF_SCHEMA_INVALID"],
    ["transaction-domain mismatch", "other-domain", 100, "KAF_RUNTIME_NOT_READY"],
  ])("fails closed for %s active-execution configuration", async (_name, domain, maximum, code) => {
    const value = fixture({
      activeExecutionServices: {
        transactionDomain: domain,
        durable: true,
        reader: { get: () => Promise.resolve(undefined) },
        maximumChargeMilliseconds: () => maximum,
      },
      modelEmission: () => ({ type: "final", value: { unreachable: true } }),
    });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toMatchObject({
      code,
    });
    expect(value.getModelInvocationCount()).toBe(0);
  });

  it("caps active-execution maximum charge at the absolute deadline", async () => {
    const holder: { value?: ReturnType<typeof fixture> } = {};
    const value = fixture({
      activeExecutionServices: {
        transactionDomain: "memory.process-local",
        durable: true,
        reader: {
          get(tenantId, runId, stepId, boundary, boundaryKey) {
            const current = holder.value;
            if (current === undefined) throw new Error("fixture unavailable");
            return Promise.resolve(
              current.stores.activeExecutionReservationStore.get(
                tenantId,
                runId,
                stepId,
                boundary,
                boundaryKey,
              ),
            );
          },
        },
        maximumChargeMilliseconds: () => 100,
      },
      modelEmission: () => ({ type: "final", value: { bounded: true } }),
    });
    holder.value = value;
    const deadlineRequest = { ...request, deadline: "2026-08-03T12:00:00.050Z" };
    const started = await value.runtime.start(
      value.authority,
      definition,
      deadlineRequest,
      commandFor("run.start", deadlineRequest, "a5".repeat(16)),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(
      value.stores.activeExecutionReservationStore
        .snapshot()
        .map(([, reservation]) => reservation.maxChargeMs),
    ).toEqual(expect.arrayContaining([50]));
  });

  it.each([
    ["invalid maximum", "a0".repeat(16), 0, 0, 0, undefined, "KAF_SCHEMA_INVALID"],
    ["excessive maximum", "af".repeat(16), 101, 0, 0, undefined, "KAF_SCHEMA_INVALID"],
    ["exhausted attempts", "a1".repeat(16), 1, 0, 0, undefined, undefined],
    ["invalid jitter", "a2".repeat(16), 2, 2, 0, undefined, "KAF_SCHEMA_INVALID"],
    ["invalid delay", "a3".repeat(16), 2, 0, -1, undefined, "KAF_SCHEMA_INVALID"],
    ["deadline-crossing delay", "a4".repeat(16), 2, 0, 100, "2026-08-03T12:00:00.050Z", undefined],
  ])(
    "fails closed for %s retry policy output",
    async (_name, suffix, maximumAttempts, jitter, delay, deadline, code) => {
      const boundedRequest = deadline === undefined ? request : { ...request, deadline };
      const value = fixture({
        modelErrorClassification: "retryable",
        retryPolicy: {
          maximumAttempts: () => maximumAttempts,
          backoffMilliseconds: () => delay,
        },
        retryJitterSource: { next: () => jitter },
        modelEmission: () => {
          throw new Error("classified retry failure");
        },
      });
      const started = await value.runtime.start(
        value.authority,
        definition,
        boundedRequest,
        commandFor("run.start", boundedRequest, suffix),
      );
      const execution = value.runtime.execute(value.authority, started.runId);
      if (code === undefined) await expect(execution).rejects.toThrow("classified retry failure");
      else await expect(execution).rejects.toMatchObject({ code });
    },
  );

  it("fails before commit when the context protector returns a mismatched AAD digest", async () => {
    const value = fixture({ inputProtectorAadMismatch: true });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toMatchObject({
      code: "KAF_AUTHORIZATION_BINDING_MISMATCH",
      details: { reason: "context_protector_aad_mismatch" },
    });
    expect(await collectEvents(value.stores.eventStore, "tenant-1", started.runId)).toHaveLength(1);
  });

  it("does not claim checkpoint recovery across transaction domains", async () => {
    const value = fixture({ contextCheckpointTransactionDomain: "other-domain" });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "completed",
    });
    await expect(value.stores.contextStore.getLatest("tenant-1", started.runId)).resolves.toBe(
      undefined,
    );
    expect(value.runtime.getCapabilities().protectedContext).toBe(false);
    const readiness = value.runtime.evaluateReadiness({ profile: "production" });
    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks.some((check) => check.id === "protected-context" && check.status === "fail"),
    ).toBe(true);
  });

  it.each([
    ["binding", "KAF_STORAGE_CONCURRENCY_CONFLICT", "context_checkpoint_binding_changed"],
    ["aad", "KAF_AUTHORIZATION_BINDING_MISMATCH", "context_checkpoint_aad_changed"],
    ["payload", "KAF_STORAGE_CONCURRENCY_CONFLICT", "context_checkpoint_payload_changed"],
    ["suffix", "KAF_STORAGE_CONCURRENCY_CONFLICT", "context_checkpoint_suffix_invalid"],
  ] as const)("fails closed for a changed context checkpoint %s", async (kind, code, reason) => {
    const value = fixture({ crashAfterTransition: "PlanningStarted" });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
      "simulated crash after committed PlanningStarted",
    );
    if (kind === "suffix") {
      const accepted = (await collectEvents(value.stores.eventStore, "tenant-1", started.runId))[0];
      if (accepted === undefined) throw new Error("accepted event is unavailable");
      await value.stores.eventStore.append(
        {
          ...accepted,
          eventId: "event-unexpected-checkpoint-suffix",
          sequence: 3,
          eventType: "ModelCallStarted",
          payload: {
            stepId: "step-1",
            modelCallReservationId: "unexpected-model-call",
            requestDigest: d("0"),
          },
        },
        2,
      );
    } else {
      const snapshot = await value.stores.contextStore.getLatest("tenant-1", started.runId);
      if (snapshot === undefined) throw new Error("context checkpoint is unavailable");
      await value.stores.contextStore.delete("tenant-1", started.runId);
      await value.stores.contextStore.put({
        ...snapshot,
        ...(kind === "binding" ? { executionDefinitionDigest: d("0") } : {}),
        ...(kind === "payload" ? { byteSize: snapshot.byteSize + 1 } : {}),
        ...(kind === "aad"
          ? { protectedValue: { ...snapshot.protectedValue, aadDigest: d("0") } }
          : {}),
      });
    }
    await expect(value.restart().execute(value.authority, started.runId)).rejects.toMatchObject({
      code,
      details: { reason },
    });
  });

  it("reports only aggregate safe capabilities and applies one pure readiness ruleset", () => {
    const { runtime } = fixture();
    expect(runtime.getCapabilities()).toEqual(
      expect.objectContaining({
        executionProfile: "ephemeral",
        durableStorage: false,
        protectedContext: true,
        protectedInputSubmissions: true,
        humanDecisions: true,
        typedInput: true,
        backgroundWakeup: false,
        transactionDomains: ["memory.process-local"],
      }),
    );
    expect(runtime.evaluateReadiness({ profile: "local" })).toMatchObject({
      ready: true,
      profile: "local",
      rulesVersion: "pactmark.runtime-readiness@1",
    });
    const production = runtime.evaluateReadiness({ profile: "production" });
    expect(production.ready).toBe(false);
    expect(
      production.checks.filter((check) => check.status === "fail").map((check) => check.id),
    ).toEqual(expect.arrayContaining(["durable-storage", "model-call-reservations"]));
    expect(JSON.stringify(production)).not.toMatch(/secret-value|https:\/\/|tenant-1/u);
  });

  it("reports absent command capabilities and fails closed before run mutation", async () => {
    const value = fixture({ commandSurface: false });
    expect(value.runtime.getCapabilities()).toMatchObject({
      protectedInputSubmissions: false,
      humanDecisions: false,
      typedInput: false,
    });
    const input = { answer: "value" };
    await expect(
      value.runtime.submitInput(
        value.authority,
        "run-missing",
        "request-missing",
        input,
        scopedCommand(
          "run.submit_input",
          input,
          ["run-missing", "request-missing"],
          "01010101010101010101010101010101",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
    await expect(
      value.runtime.issueDecisionChallenge(
        value.authority,
        "run-missing",
        "decision-missing",
        scopedCommand(
          "run.issue_decision_challenge",
          {},
          ["run-missing", "decision-missing"],
          "02020202020202020202020202020202",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
  });

  it("constructs production models only after a bound reservation and credential reference", async () => {
    const holder: { value?: ReturnType<typeof fixture> } = {};
    let workOrderExistedBeforeIssue = false;
    const model = productionModelServicesFixture({
      async onIssue(issueRequest) {
        if (holder.value === undefined) throw new Error("runtime fixture unavailable");
        const run = await holder.value.runtime.getRun(
          holder.value.authority,
          issueRequest.reservation.runId,
        );
        workOrderExistedBeforeIssue =
          (await holder.value.stores.acceptedWorkOrderStore.get("tenant-1", run.workOrderId)) !==
          undefined;
      },
    });
    const value = fixture({
      agentDefinition: productionDefinition,
      productionModelServices: model.services,
      modelEmission: () => {
        throw new Error("arbitrary model driver must remain unreachable");
      },
    });
    holder.value = value;
    const productionRequest = {
      ...request,
      agent: { id: productionDefinition.id, version: productionDefinition.version },
    };
    const started = await value.runtime.start(
      value.authority,
      productionDefinition,
      productionRequest,
      commandFor("run.start", productionRequest, "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(value.getModelInvocationCount()).toBe(0);
    expect(model.issue).toHaveBeenCalledOnce();
    expect(workOrderExistedBeforeIssue).toBe(true);
    expect(model.resolve).toHaveBeenCalledOnce();
    expect(model.getAdapterCalls()).toBe(1);
    expect(model.getExportContainedSecret()).toBe(false);
    expect(model.reserve).toHaveBeenCalledOnce();
    const reservedCall = model.reserve.mock.calls[0]?.[1];
    if (reservedCall === undefined) throw new Error("model reservation missing");
    expect(reservedCall.reservationId).toMatch(/^model-call-reservation:sha256:/u);
    await expect(
      model.services.reservations.reserve({} as RunCommandTransaction, reservedCall),
    ).resolves.toMatchObject({ reservationId: reservedCall.reservationId, status: "settled" });
    expect(model.reservations.size).toBe(1);
    expect(model.markDispatched).toHaveBeenCalledOnce();
    expect(model.settle).toHaveBeenCalledOnce();
    expect(model.markUncertain).not.toHaveBeenCalled();
    expect(model.getObservedSettlement()).toMatchObject({
      trustedProviderUsage: { inputTokens: 12, outputTokens: 3 },
    });
    const issueRequest = model.issue.mock.calls[0]?.[0];
    if (issueRequest === undefined) throw new Error("credential issue request missing");
    const persistedWorkOrder = await value.stores.acceptedWorkOrderStore.get(
      "tenant-1",
      (await value.runtime.getRun(value.authority, started.runId)).workOrderId,
    );
    expect(persistedWorkOrder?.workOrderBindingDigest).toBe(
      issueRequest.binding.workOrderBindingDigest,
    );
    expect(issueRequest.reservation.status).toBe("accepted");
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["ModelCallStarted", "ModelCallCompleted"]),
    );
    expect(JSON.stringify(events)).not.toContain("credential-canary-value");
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(model.settle).toHaveBeenCalledOnce();
  });

  it.each([
    ["model_adapter", definition.modelAdapterRegistrationDigest],
    ["model_profile", definition.modelSecurityProfileDigest],
    ["model_profile", definition.modelResourceProfileDigest],
  ] as const)("blocks a killed %s registration before model invocation", async (kind, digest) => {
    const value = fixture({
      killSwitches: {
        isKilled: (candidateKind, candidateDigest) =>
          candidateKind === kind && candidateDigest === digest,
      },
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      request,
      commandFor("run.start", request, "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toMatchObject({
      code: "KAF_RUNTIME_NOT_READY",
      details: { reason: "model_registration_killed" },
    });
    expect(value.getModelInvocationCount()).toBe(0);
  });

  it("closes a dispatched production reservation uncertain and retries with a new attempt", async () => {
    const model = productionModelServicesFixture();
    const value = fixture({
      agentDefinition: productionDefinition,
      productionModelServices: model.services,
      crashAfterTransition: "model_call_reservation",
      retryPolicy: {
        maximumAttempts: () => 2,
        backoffMilliseconds: () => 0,
      },
      retryJitterSource: { next: () => 0 },
      modelEmission: () => {
        throw new Error("arbitrary model driver must remain unreachable");
      },
    });
    const productionRequest = {
      ...request,
      agent: { id: productionDefinition.id, version: productionDefinition.version },
    };
    const started = await value.runtime.start(
      value.authority,
      productionDefinition,
      productionRequest,
      commandFor("run.start", productionRequest, "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
      "simulated crash after committed model_call_reservation",
    );
    expect(model.getAdapterCalls()).toBe(0);

    await expect(value.restart().execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(model.markUncertain).toHaveBeenCalledOnce();
    expect(model.getAdapterCalls()).toBe(1);
    expect([...model.reservations.values()].map((entry) => entry.status).sort()).toEqual([
      "settled",
      "uncertain",
    ]);
  });

  it.each(["missing", "expired"] as const)(
    "parks a resumed production call whose reservation is %s",
    async (state) => {
      const model = productionModelServicesFixture();
      const value = fixture({
        agentDefinition: productionDefinition,
        productionModelServices: model.services,
        crashAfterTransition: "ModelCallStarted",
        modelEmission: () => {
          throw new Error("arbitrary model driver must remain unreachable");
        },
      });
      const productionRequest = {
        ...request,
        agent: { id: productionDefinition.id, version: productionDefinition.version },
      };
      const started = await value.runtime.start(
        value.authority,
        productionDefinition,
        productionRequest,
        commandFor(
          "run.start",
          productionRequest,
          state === "missing" ? "a6".repeat(16) : "a7".repeat(16),
        ),
      );
      await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
        "simulated crash after committed ModelCallStarted",
      );
      const entry = [...model.reservations.entries()][0];
      if (entry === undefined) throw new Error("accepted reservation missing");
      if (state === "missing") model.reservations.clear();
      else model.reservations.set(entry[0], { ...entry[1], status: "expired" });

      await expect(value.restart().execute(value.authority, started.runId)).resolves.toEqual({
        runId: started.runId,
        status: "parked",
      });
      expect(model.getAdapterCalls()).toBe(0);
    },
  );

  it.each([
    ["tenant", (ref: ModelCredentialRef) => ({ ...ref, tenantId: "tenant-other" })],
    ["issuer", (ref: ModelCredentialRef) => ({ ...ref, issuerId: "issuer-other" })],
    ["purpose", (ref: ModelCredentialRef) => ({ ...ref, purpose: "purpose-other" })],
    [
      "security profile",
      (ref: ModelCredentialRef) => ({ ...ref, modelSecurityProfileDigest: d("6") }),
    ],
    [
      "resource profile",
      (ref: ModelCredentialRef) => ({ ...ref, modelResourceProfileDigest: d("6") }),
    ],
    [
      "adapter digest",
      (ref: ModelCredentialRef) => ({ ...ref, modelAdapterRegistrationDigest: d("6") }),
    ],
    ["reservation", (ref: ModelCredentialRef) => ({ ...ref, reservationId: "reservation-other" })],
    [
      "endpoint",
      (ref: ModelCredentialRef) => ({ ...ref, providerEndpointOrigin: "https://other.invalid" }),
    ],
    ["expiry", (ref: ModelCredentialRef) => ({ ...ref, expiresAt: ref.issuedAt })],
    [
      "cross-port tool reference",
      (ref: ModelCredentialRef) => ({ ...ref, credentialKind: "tool" }),
    ],
  ] as const)(
    "fails closed before resolution or model export on %s replay",
    async (_name, transformRef) => {
      const model = productionModelServicesFixture({ transformRef });
      const value = fixture({
        agentDefinition: productionDefinition,
        productionModelServices: model.services,
        modelEmission: () => {
          throw new Error("arbitrary model driver must remain unreachable");
        },
      });
      const productionRequest = {
        ...request,
        agent: { id: productionDefinition.id, version: productionDefinition.version },
      };
      const started = await value.runtime.start(
        value.authority,
        productionDefinition,
        productionRequest,
        commandFor("run.start", productionRequest, `b${"0".repeat(31)}`),
      );
      await expect(value.runtime.execute(value.authority, started.runId)).rejects.toBeDefined();
      expect(model.resolve).not.toHaveBeenCalled();
      expect(model.getAdapterCalls()).toBe(0);
      expect(value.getModelInvocationCount()).toBe(0);
    },
  );

  it("sanitizes model credential issuance failures before events or public errors", async () => {
    const model = productionModelServicesFixture({
      onIssue: () => Promise.reject(new Error("credential-canary-value")),
    });
    const value = fixture({
      agentDefinition: productionDefinition,
      productionModelServices: model.services,
    });
    const productionRequest = {
      ...request,
      agent: { id: productionDefinition.id, version: productionDefinition.version },
    };
    const started = await value.runtime.start(
      value.authority,
      productionDefinition,
      productionRequest,
      commandFor("run.start", productionRequest, "bdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbd"),
    );
    let publicError: unknown;
    try {
      await value.runtime.execute(value.authority, started.runId);
    } catch (error) {
      publicError = error;
    }
    expect(publicError).toMatchObject({ code: "KAF_MODEL_CREDENTIAL_REQUIRED" });
    expect(JSON.stringify(publicError)).not.toContain("credential-canary-value");
    expect(model.resolve).not.toHaveBeenCalled();
    expect(model.getAdapterCalls()).toBe(0);
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(JSON.stringify(events)).not.toContain("credential-canary-value");
  });

  it("rejects unregistered adapters and non-durable reservation services with zero model access", async () => {
    const arbitraryOnly = fixture({
      agentDefinition: productionDefinition,
      requireProductionModelBoundary: true,
      modelEmission: () => {
        throw new Error("arbitrary credential-observing closure must remain unreachable");
      },
    });
    const arbitraryRequest = {
      ...request,
      agent: { id: productionDefinition.id, version: productionDefinition.version },
    };
    const arbitraryStarted = await arbitraryOnly.runtime.start(
      arbitraryOnly.authority,
      productionDefinition,
      arbitraryRequest,
      commandFor("run.start", arbitraryRequest, "bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc"),
    );
    await expect(
      arbitraryOnly.runtime.execute(arbitraryOnly.authority, arbitraryStarted.runId),
    ).rejects.toMatchObject({ code: "KAF_MODEL_CREDENTIAL_REQUIRED" });
    expect(arbitraryOnly.getModelInvocationCount()).toBe(0);

    for (const [index, options] of [
      { registeredAdapter: false },
      { durable: false },
      { transactionDomain: "memory.other-domain" },
    ].entries()) {
      const model = productionModelServicesFixture(options);
      const value = fixture({
        agentDefinition: productionDefinition,
        productionModelServices: model.services,
        modelEmission: () => {
          throw new Error("arbitrary model driver must remain unreachable");
        },
      });
      expect(value.runtime.getCapabilities().modelCredentials).toBe(index === 0);
      if (index > 0) {
        expect(
          value.runtime
            .evaluateReadiness({ profile: "production" })
            .checks.find((check) => check.id === "model-call-reservations"),
        ).toMatchObject({ status: "fail" });
      }
      const productionRequest = {
        ...request,
        agent: { id: productionDefinition.id, version: productionDefinition.version },
      };
      const started = await value.runtime.start(
        value.authority,
        productionDefinition,
        productionRequest,
        commandFor("run.start", productionRequest, (index + 12).toString(16).repeat(32)),
      );
      await expect(value.runtime.execute(value.authority, started.runId)).rejects.toBeDefined();
      expect(model.issue).not.toHaveBeenCalled();
      expect(model.resolve).not.toHaveBeenCalled();
      expect(model.getAdapterCalls()).toBe(0);
      expect(value.getModelInvocationCount()).toBe(0);
    }
  });

  it("retains the maximum reservation after uncertain model dispatch without leaking secrets", async () => {
    const model = productionModelServicesFixture({ throwAfterResolution: true });
    const value = fixture({
      agentDefinition: productionDefinition,
      productionModelServices: model.services,
      modelEmission: () => {
        throw new Error("arbitrary model driver must remain unreachable");
      },
    });
    const productionRequest = {
      ...request,
      agent: { id: productionDefinition.id, version: productionDefinition.version },
    };
    const started = await value.runtime.start(
      value.authority,
      productionDefinition,
      productionRequest,
      commandFor("run.start", productionRequest, "efefefefefefefefefefefefefefefef"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(model.resolve).toHaveBeenCalledOnce();
    expect(model.markUncertain).toHaveBeenCalledOnce();
    expect(model.settle).not.toHaveBeenCalled();
    expect(value.getModelInvocationCount()).toBe(0);
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(JSON.stringify(events)).not.toContain("credential-canary-value");
    expect(events.at(-1)).toMatchObject({
      eventType: "RunFailed",
      payload: { errorCode: "KAF_RUNTIME_CAPABILITY_MISSING" },
    });
  });

  it.each([
    ["missing credential resolution", { skipResolution: true }],
    ["repeated credential resolution", { repeatResolution: true }],
  ] as const)("marks sealed-adapter protocol fault uncertain for %s", async (_name, options) => {
    const model = productionModelServicesFixture(options);
    const value = fixture({
      agentDefinition: productionDefinition,
      productionModelServices: model.services,
    });
    const productionRequest = {
      ...request,
      agent: { id: productionDefinition.id, version: productionDefinition.version },
    };
    const started = await value.runtime.start(
      value.authority,
      productionDefinition,
      productionRequest,
      commandFor("run.start", productionRequest, "abababababababababababababababab"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(model.markUncertain).toHaveBeenCalledOnce();
    expect(model.settle).not.toHaveBeenCalled();
  });

  it("settles an empty credential-bound response once without trusted provider usage", async () => {
    const model = productionModelServicesFixture({ emptyEmission: true, trustedUsage: false });
    const value = fixture({
      agentDefinition: productionDefinition,
      productionModelServices: model.services,
    });
    const productionRequest = {
      ...request,
      agent: { id: productionDefinition.id, version: productionDefinition.version },
    };
    const started = await value.runtime.start(
      value.authority,
      productionDefinition,
      productionRequest,
      commandFor("run.start", productionRequest, "acacacacacacacacacacacacacacacac"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(model.resolve).toHaveBeenCalledOnce();
    expect(model.settle).toHaveBeenCalledOnce();
    expect(model.markUncertain).not.toHaveBeenCalled();
    expect(model.getObservedSettlement()).not.toHaveProperty("trustedProviderUsage");
  });

  it("rejects invalid decision timing configuration and command resource scopes", async () => {
    expect(() => fixture({ decisionChallengeTtlMs: 0 })).toThrow(
      expect.objectContaining({ code: "KAF_SCHEMA_INVALID" }),
    );
    const value = fixture();
    await expect(
      value.runtime.issueDecisionChallenge(
        value.authority,
        "run-missing",
        "decision-missing",
        commandFor("run.issue_decision_challenge", {}),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    await expect(
      value.runtime.issueDecisionChallenge(
        value.authority,
        "run-missing",
        "decision-missing",
        scopedCommand(
          "run.issue_decision_challenge",
          {},
          ["run-missing", "decision-missing"],
          "03030303030303030303030303030303",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_NOT_FOUND" });
  });

  it("runs an authority-bound deterministic tool loop to verified completion", async () => {
    const { runtime, authority, command, executeTool, verifyArtifact } = fixture();
    const started = await runtime.start(authority, definition, request, command);
    await expect(runtime.execute(authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "completed",
    });
    expect((await runtime.getRun(authority, started.runId)).status).toBe("completed");
    expect(executeTool).toHaveBeenCalledOnce();
    expect(verifyArtifact).toHaveBeenCalledOnce();
    const events = [];
    for await (const event of runtime.events(authority, started.runId))
      events.push(event.eventType);
    expect(events).toEqual([
      "RunAccepted",
      "PlanningStarted",
      "ModelCallStarted",
      "ModelCallCompleted",
      "ExecutionStarted",
      "ToolCallRequested",
      "ToolCallCompleted",
      "PlanningStarted",
      "ModelCallStarted",
      "ModelCallCompleted",
      "ExecutionStarted",
      "ArtifactProduced",
      "VerificationStarted",
      "VerificationRecorded",
      "RunCompleted",
    ]);
  });

  it("persists prepare, dispatch, and validated acknowledgement before completing a write", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const strategy = nativeEffectStrategy(dispatch);
    const effectRequest = {
      ...request,
      requestedCapabilities: ["knowledge:write"],
    };
    const value = fixture({
      toolRegistration: writeTool,
      effectStrategy: strategy,
      modelEmission: (invocation) =>
        invocation === 1
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: writeTool.toolRegistrationDigest,
                input: { value: "bounded" },
                targetDigest: effectTargetDigest,
              },
            }
          : { type: "final", value: { ok: true } },
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "completed",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["EffectPrepared", "EffectDispatched", "EffectAcknowledged"]),
    );
    const acknowledgement = events.find((event) => event.eventType === "EffectAcknowledged");
    expect(acknowledgement).toBeDefined();
  });

  it.each([
    ["missing protector", "missing", "public", "failed", undefined],
    [
      "mismatched protector AAD",
      "aad_mismatch",
      "public",
      undefined,
      "KAF_AUTHORIZATION_BINDING_MISMATCH",
    ],
  ] as const)(
    "fails closed for %s effect-result persistence",
    async (_name, protectorMode, dataClass, status, code) => {
      const effectRequest = {
        ...request,
        dataClass,
        requestedCapabilities: ["knowledge:write"],
      };
      const value = fixture({
        toolRegistration: writeTool,
        effectStrategy: nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
        effectResultProtectorMode: protectorMode,
        modelEmission: () => ({
          type: "tool_call",
          value: {
            toolRegistrationDigest: writeTool.toolRegistrationDigest,
            input: { value: "protected" },
            targetDigest: effectTargetDigest,
          },
        }),
      });
      const started = await value.runtime.start(
        value.authority,
        definition,
        effectRequest,
        commandFor(
          "run.start",
          effectRequest,
          protectorMode === "missing" ? "b2".repeat(16) : "b3".repeat(16),
        ),
      );
      const execution = value.runtime.execute(value.authority, started.runId);
      if (status !== undefined) await expect(execution).resolves.toMatchObject({ status });
      else await expect(execution).rejects.toMatchObject({ code });
    },
  );

  it("recovers a protected acknowledged result without repeating the receiver call", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const value = fixture({
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(dispatch),
      effectRecoveredResult: { written: true },
      effectExistingRecord: (key, tenantId, runId) =>
        ledgerRecord(key, tenantId, runId, "acknowledged"),
      modelEmission: effectEmission,
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("parks acknowledged ledger state when its protected result is absent or mismatched", async () => {
    for (const recovered of [undefined, { written: false }] as const) {
      const value = fixture({
        toolRegistration: writeTool,
        effectStrategy: nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
        ...(recovered === undefined ? {} : { effectRecoveredResult: recovered }),
        effectExistingRecord: (key, tenantId, runId) =>
          ledgerRecord(key, tenantId, runId, "acknowledged"),
        modelEmission: effectEmission,
      });
      const started = await value.runtime.start(
        value.authority,
        definition,
        effectRequest,
        commandFor(
          "run.start",
          effectRequest,
          recovered === undefined
            ? "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"
            : "d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2",
        ),
      );
      await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
        status: "parked",
      });
    }
  });

  it("continues conservative parking from unknown and needs-reconciliation ledger states", async () => {
    for (const state of ["unknown", "needs_reconciliation"] as const) {
      const value = fixture({
        toolRegistration: writeTool,
        effectStrategy: nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
        effectExistingRecord: (key, tenantId, runId) => ledgerRecord(key, tenantId, runId, state),
        modelEmission: effectEmission,
      });
      const started = await value.runtime.start(
        value.authority,
        definition,
        effectRequest,
        commandFor(
          "run.start",
          effectRequest,
          state === "unknown"
            ? "d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3"
            : "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
        ),
      );
      await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
        status: "parked",
      });
      expect(await value.runtime.getRun(value.authority, started.runId)).toMatchObject({
        status: "suspended",
        activeEffectId: "effect-existing",
      });
    }
  });

  it("fails closed for abandoned, missing, drifted, or keyless executable strategies", async () => {
    const candidates: ReadonlyArray<{
      suffix: string;
      options: FixtureOptions;
      expectedStatus?: "failed";
    }> = [
      {
        suffix: "d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5",
        options: {
          effectStrategy: nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
          effectExistingRecord: (key, tenantId, runId) =>
            ledgerRecord(key, tenantId, runId, "abandoned"),
        },
      },
      {
        suffix: "d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6",
        options: {
          effectStrategy: nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
          effectStrategyUnavailable: true,
        },
        expectedStatus: "failed",
      },
      {
        suffix: "d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7",
        options: { effectStrategy: noneEffectStrategy(vi.fn(async () => Promise.resolve())) },
        expectedStatus: "failed",
      },
      {
        suffix: "d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8",
        options: {
          effectStrategy: {
            ...nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
            operationKey: () => "",
          },
        },
      },
    ];
    for (const candidate of candidates) {
      const value = fixture({
        toolRegistration: writeTool,
        modelEmission: effectEmission,
        ...candidate.options,
      });
      const started = await value.runtime.start(
        value.authority,
        definition,
        effectRequest,
        commandFor("run.start", effectRequest, candidate.suffix),
      );
      if (candidate.expectedStatus === "failed") {
        await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
          status: "failed",
        });
      } else {
        await expect(value.runtime.execute(value.authority, started.runId)).rejects.toBeDefined();
      }
    }
  });

  it("rejects authorization binding, secret, and missing R4 approval before dispatch", async () => {
    const r4Tool = { ...writeTool, security: { ...writeTool.security, riskClass: "R4" as const } };
    const transforms = [
      (reservation: Record<string, unknown>) => ({ ...reservation, authorizationKey: "changed" }),
      (reservation: Record<string, unknown>) => ({
        ...reservation,
        secretRefIds: ["secret-ref"],
      }),
      (reservation: Record<string, unknown>) => reservation,
    ];
    for (const [index, transform] of transforms.entries()) {
      const dispatch = vi.fn(async () => Promise.resolve());
      const value = fixture({
        toolRegistration: index === 2 ? r4Tool : writeTool,
        effectStrategy: nativeEffectStrategy(dispatch),
        effectAuthorizationTransform: transform,
        modelEmission: effectEmission,
      });
      const suffix = String(index + 1).repeat(32);
      const started = await value.runtime.start(
        value.authority,
        definition,
        effectRequest,
        commandFor("run.start", effectRequest, suffix),
      );
      await expect(value.runtime.execute(value.authority, started.runId)).rejects.toMatchObject({
        code: "KAF_AUTHORIZATION_BINDING_MISMATCH",
      });
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it("atomically claims a configured approval with the effect authorization", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const r4Tool = { ...writeTool, security: { ...writeTool.security, riskClass: "R4" as const } };
    const value = fixture({
      toolRegistration: r4Tool,
      effectStrategy: nativeEffectStrategy(dispatch),
      effectAuthorizationTransform: (reservation) => ({
        ...reservation,
        approvalId: "approval-bound",
      }),
      modelEmission: effectEmission,
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "dddddddddddddddddddddddddddddddd"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("creates and executes a separately authorized model-less compensation run", async () => {
    const intents = new Map<string, Parameters<RuntimeCompensationServices["putIntentOnce"]>[1]>();
    let bindingAvailable = true;
    let bindingDefinition: CompensationRunDefinition = compensationDefinition;
    let registeredDefinition: CompensationRunDefinition | undefined = compensationDefinition;
    let killedCompensationRegistration:
      | Readonly<{
          kind: "compensation_definition" | "compensation_strategy";
          digest: string;
        }>
      | undefined;
    const compensationServices: RuntimeCompensationServices = {
      transactionDomain: "memory.process-local",
      registry: {
        register: () => Promise.resolve(),
        resolve: async (id, version, digest) => {
          await Promise.resolve();
          return registeredDefinition !== undefined &&
            id === compensationDefinition.id &&
            version === compensationDefinition.version &&
            digest === compensationDefinition.compensationRunDefinitionDigest
            ? registeredDefinition
            : undefined;
        },
      },
      resolve: async (toolDigest) => {
        await Promise.resolve();
        return bindingAvailable && toolDigest === writeTool.toolRegistrationDigest
          ? {
              definition: bindingDefinition,
              deriveInput: (original) => ({
                originalResultDigest: digestCanonicalJson(original.result),
                acknowledgementId: original.acknowledgement.acknowledgementId,
              }),
              validateInput: (input) => input as JsonValue,
            }
          : undefined;
      },
      putIntentOnce: async (_transaction, intent) => {
        await Promise.resolve();
        const key = `${intent.originalTenantId}\u0000${intent.originalRunId}\u0000${intent.originalEffectId}`;
        const existing = intents.get(key);
        if (existing !== undefined) return existing;
        intents.set(key, intent);
        return intent;
      },
    };
    let compensationTarget = "";
    const compensationDispatch = vi.fn(async () => Promise.resolve());
    const compensationStrategy: RuntimeExecutableEffectStrategy = {
      kind: "native",
      registrationDigest: compensationTool.effectStrategyRegistrationDigest,
      previewRegistrationDigest: compensationPreviewRegistrationDigest,
      preview: async () => {
        await Promise.resolve();
        const material = {
          schemaVersion: "1" as const,
          normalizedTarget: compensationTarget,
          operationClass: "compensate_fixture_write",
          contentDigest: d("a"),
          reversibility: "irreversible" as const,
          materialConsequence: "Reverses the bounded fixture write.",
        };
        return { ...material, previewDigest: digestCanonicalJson(material) };
      },
      validateOutput: (value) => value as JsonValue,
      operationKey: (_value, binding) => `compensation:${binding.effectKey}`,
      dispatch: async (_value, operationKey, context) => {
        await compensationDispatch();
        return acknowledgedExecutionFor(compensationTool, context, operationKey);
      },
    };
    const originalDispatch = vi.fn(async () => Promise.resolve());
    const value = fixture({
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(originalDispatch),
      effectRecoveredResult: { written: true },
      additionalToolRegistrations: [compensationTool],
      additionalEffectStrategies: [
        {
          toolRegistrationDigest: compensationTool.toolRegistrationDigest,
          strategy: compensationStrategy,
        },
      ],
      compensationServices,
      killSwitches: {
        isKilled: (kind, digest) =>
          kind === killedCompensationRegistration?.kind &&
          digest === killedCompensationRegistration.digest,
      },
      modelEmission: effectEmission,
    });
    const original = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "cececececececececececececececece"),
    );
    await expect(value.runtime.execute(value.authority, original.runId)).resolves.toMatchObject({
      status: "completed",
    });
    const originalEffectEntry = [...(value.effectUnitOfWork?.effectRecords.entries() ?? [])].find(
      ([, record]) => record.runId === original.runId && record.state === "acknowledged",
    );
    if (originalEffectEntry === undefined) throw new Error("acknowledged original effect missing");
    const [originalEffectStoreKey, originalEffect] = originalEffectEntry;
    compensationTarget = `effect:${originalEffect.effectDigest}`;
    const compensationAuthority = value.authorityIssuer.issue({
      actor: { type: "user", id: "operator-2" },
      tenant: { id: "tenant-1" },
      authenticatedAt: now,
      authenticationStrength: "phishing_resistant",
      decisionRoles: ["effect:compensate"],
      requestCorrelationId: "compensation-request",
      issuedAt: "2026-08-03T11:00:00.000Z",
      expiresAt: "2026-08-03T13:00:00.000Z",
    });
    const compensationRequest = {
      schemaVersion: "1" as const,
      reason: "Reverse the acknowledged fixture effect",
      budget: {
        maxTurns: 1,
        maxModelCalls: 1,
        maxToolCalls: 1,
        maxActiveExecutionMs: 10_000,
      },
    };
    await expect(
      value.runtime.requestCompensation(
        value.authority,
        original.runId,
        originalEffect.effectId,
        compensationRequest,
        scopedCommand(
          "run.request_compensation",
          compensationRequest,
          [original.runId, originalEffect.effectId],
          "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    await expect(
      value.runtime.requestCompensation(
        compensationAuthority,
        original.runId,
        "missing-effect",
        compensationRequest,
        scopedCommand(
          "run.request_compensation",
          compensationRequest,
          [original.runId, "missing-effect"],
          "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_INVALID_TRANSITION" });
    value.effectUnitOfWork?.effectRecords.set(originalEffectStoreKey, {
      ...originalEffect,
      resultDigest: d("6"),
    });
    await expect(
      value.runtime.requestCompensation(
        compensationAuthority,
        original.runId,
        originalEffect.effectId,
        compensationRequest,
        scopedCommand(
          "run.request_compensation",
          compensationRequest,
          [original.runId, originalEffect.effectId],
          "c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
    value.effectUnitOfWork?.effectRecords.set(originalEffectStoreKey, originalEffect);
    value.effectUnitOfWork?.effectRecords.set(originalEffectStoreKey, {
      ...originalEffect,
      toolRegistrationDigest: d("6"),
    });
    await expect(
      value.runtime.requestCompensation(
        compensationAuthority,
        original.runId,
        originalEffect.effectId,
        compensationRequest,
        scopedCommand(
          "run.request_compensation",
          compensationRequest,
          [original.runId, originalEffect.effectId],
          "c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
    value.effectUnitOfWork?.effectRecords.set(originalEffectStoreKey, originalEffect);
    bindingAvailable = false;
    await expect(
      value.runtime.requestCompensation(
        compensationAuthority,
        original.runId,
        originalEffect.effectId,
        compensationRequest,
        scopedCommand(
          "run.request_compensation",
          compensationRequest,
          [original.runId, originalEffect.effectId],
          "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
    bindingAvailable = true;
    registeredDefinition = undefined;
    await expect(
      value.runtime.requestCompensation(
        compensationAuthority,
        original.runId,
        originalEffect.effectId,
        compensationRequest,
        scopedCommand(
          "run.request_compensation",
          compensationRequest,
          [original.runId, originalEffect.effectId],
          "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    registeredDefinition = { ...compensationDefinition, executorVersion: "drifted-executor@1" };
    await expect(
      value.runtime.requestCompensation(
        compensationAuthority,
        original.runId,
        originalEffect.effectId,
        compensationRequest,
        scopedCommand(
          "run.request_compensation",
          compensationRequest,
          [original.runId, originalEffect.effectId],
          "c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    const bindingDrifts: readonly CompensationRunDefinition[] = [
      { ...compensationDefinition, originalAgentDefinitionDigest: d("6") },
      { ...compensationDefinition, originalToolRegistrationDigest: d("6") },
      { ...compensationDefinition, compensationStrategyRegistrationDigest: d("6") },
      { ...compensationDefinition, compensationToolId: "knowledge.wrong.v1" },
      { ...compensationDefinition, compensationToolVersion: "9.0.0" },
      { ...compensationDefinition, compensationToolRegistrationDigest: d("6") },
      { ...compensationDefinition, purposeCode: "unregistered_purpose" },
    ];
    for (const [index, drifted] of bindingDrifts.entries()) {
      bindingDefinition = drifted;
      registeredDefinition = drifted;
      const suffix = (index + 5).toString(16).repeat(32);
      await expect(
        value.runtime.requestCompensation(
          compensationAuthority,
          original.runId,
          originalEffect.effectId,
          compensationRequest,
          scopedCommand(
            "run.request_compensation",
            compensationRequest,
            [original.runId, originalEffect.effectId],
            suffix,
          ),
        ),
      ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    }
    bindingDefinition = compensationDefinition;
    registeredDefinition = compensationDefinition;
    for (const killed of [
      {
        kind: "compensation_definition" as const,
        digest: compensationDefinition.compensationRunDefinitionDigest,
      },
      {
        kind: "compensation_strategy" as const,
        digest: compensationDefinition.compensationStrategyRegistrationDigest,
      },
    ]) {
      killedCompensationRegistration = killed;
      const suffix = killed.kind === "compensation_definition" ? "a5" : "a6";
      await expect(
        value.runtime.requestCompensation(
          compensationAuthority,
          original.runId,
          originalEffect.effectId,
          compensationRequest,
          scopedCommand(
            "run.request_compensation",
            compensationRequest,
            [original.runId, originalEffect.effectId],
            suffix.repeat(16),
          ),
        ),
      ).rejects.toMatchObject({
        code: "KAF_RUNTIME_NOT_READY",
        details: { reason: "compensation_registration_killed" },
      });
    }
    killedCompensationRegistration = undefined;
    const requested = await value.runtime.requestCompensation(
      compensationAuthority,
      original.runId,
      originalEffect.effectId,
      compensationRequest,
      scopedCommand(
        "run.request_compensation",
        compensationRequest,
        [original.runId, originalEffect.effectId],
        "cfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcf",
      ),
    );
    const acceptedCompensation = await value.runtime.getRun(
      compensationAuthority,
      requested.compensationRunId,
    );
    const storedWorkOrder = await value.stores.acceptedWorkOrderStore.get(
      "tenant-1",
      acceptedCompensation.workOrderId,
    );
    expect(storedWorkOrder).toMatchObject({
      kind: "compensation",
      principal: { id: "operator-2" },
      originalRunId: original.runId,
      originalEffectId: originalEffect.effectId,
      executionDefinition: {
        kind: "compensation",
        compensationRunDefinitionDigest: compensationDefinition.compensationRunDefinitionDigest,
      },
    });
    const modelCallsBeforeCompensation = value.getModelInvocationCount();
    killedCompensationRegistration = {
      kind: "compensation_strategy",
      digest: compensationDefinition.compensationStrategyRegistrationDigest,
    };
    await expect(
      value.runtime.execute(compensationAuthority, requested.compensationRunId),
    ).rejects.toMatchObject({
      code: "KAF_RUNTIME_NOT_READY",
      details: { reason: "compensation_registration_killed" },
    });
    expect(compensationDispatch).not.toHaveBeenCalled();
    killedCompensationRegistration = undefined;
    registeredDefinition = undefined;
    await expect(
      value.runtime.execute(compensationAuthority, requested.compensationRunId),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    registeredDefinition = { ...compensationDefinition, compensationToolId: "knowledge.wrong.v1" };
    await expect(
      value.runtime.execute(compensationAuthority, requested.compensationRunId),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    registeredDefinition = compensationDefinition;
    vi.spyOn(value.stores.leaseStore, "acquire").mockResolvedValueOnce(undefined);
    await expect(
      value.runtime.execute(compensationAuthority, requested.compensationRunId),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    const aborted = new AbortController();
    aborted.abort("fixture cancellation");
    await expect(
      value.runtime.execute(compensationAuthority, requested.compensationRunId, {
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      value.runtime.execute(compensationAuthority, requested.compensationRunId),
    ).resolves.toMatchObject({ status: "completed" });
    expect(value.getModelInvocationCount()).toBe(modelCallsBeforeCompensation);
    expect(compensationDispatch).toHaveBeenCalledOnce();
    const events = await collectEvents(
      value.stores.eventStore,
      "tenant-1",
      requested.compensationRunId,
    );
    expect(events.map((event) => event.eventType)).toContain("CompensationRequested");
    expect(events.some((event) => event.eventType.startsWith("Model"))).toBe(false);
    expect(events.some((event) => event.eventType === "PlanningStarted")).toBe(false);
  });

  it("fails compensation readiness closed without one transactional storage domain", async () => {
    const compensationServices: RuntimeCompensationServices = {
      transactionDomain: "memory.separate-domain",
      registry: {
        register: () => Promise.resolve(),
        resolve: () => Promise.resolve(undefined),
      },
      resolve: () => Promise.resolve(undefined),
      putIntentOnce: (_transaction, intent) => Promise.resolve(intent),
    };
    const value = fixture({
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
      compensationServices,
    });
    const authority = value.authorityIssuer.issue({
      actor: { type: "user", id: "operator-2" },
      tenant: { id: "tenant-1" },
      authenticatedAt: now,
      authenticationStrength: "phishing_resistant",
      decisionRoles: ["effect:compensate"],
      requestCorrelationId: "compensation-readiness",
      issuedAt: "2026-08-03T11:00:00.000Z",
      expiresAt: "2026-08-03T13:00:00.000Z",
    });
    const compensationRequest = {
      schemaVersion: "1" as const,
      reason: "Prove transaction-domain readiness",
      budget: {
        maxTurns: 1,
        maxModelCalls: 1,
        maxToolCalls: 1,
        maxActiveExecutionMs: 10_000,
      },
    };
    const unavailable = fixture();
    const unavailableAuthority = unavailable.authorityIssuer.issue({
      actor: { type: "user", id: "operator-2" },
      tenant: { id: "tenant-1" },
      authenticatedAt: now,
      authenticationStrength: "phishing_resistant",
      decisionRoles: ["effect:compensate"],
      requestCorrelationId: "compensation-unavailable",
      issuedAt: "2026-08-03T11:00:00.000Z",
      expiresAt: "2026-08-03T13:00:00.000Z",
    });
    await expect(
      unavailable.runtime.requestCompensation(
        unavailableAuthority,
        "missing-run",
        "missing-effect",
        compensationRequest,
        scopedCommand(
          "run.request_compensation",
          compensationRequest,
          ["missing-run", "missing-effect"],
          "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
    expect(value.runtime.getCapabilities().compensation).toBe(false);
    expect(
      value.runtime
        .evaluateReadiness({ profile: "production" })
        .checks.find((check) => check.id === "compensation-transaction-domain"),
    ).toMatchObject({ status: "fail" });
    await expect(
      value.runtime.requestCompensation(
        authority,
        "missing-run",
        "missing-effect",
        compensationRequest,
        scopedCommand(
          "run.request_compensation",
          compensationRequest,
          ["missing-run", "missing-effect"],
          "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_NOT_READY" });
  });

  it("runs reconcilable lookup before retry and dispatches only after not-applied", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const lookup = vi.fn(async () => Promise.resolve());
    const reconcilableTool = { ...writeTool, effectStrategyKind: "reconcilable" as const };
    const base = reconcilableEffectStrategy({ dispatch, lookup });
    const strategy: RuntimeExecutableEffectStrategy = {
      ...base,
      dispatch: async (_value, operationKey, context) => {
        await dispatch();
        return acknowledgedExecution(context, operationKey);
      },
      lookup: async () => {
        await lookup();
        return { status: "not_applied" as const };
      },
    };
    const value = fixture({
      toolRegistration: reconcilableTool,
      effectStrategy: strategy,
      effectExistingRecord: (key, tenantId, runId) =>
        ledgerRecord(key, tenantId, runId, "dispatched", "reconcilable"),
      modelEmission: effectEmission,
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "dadadadadadadadadadadadadadadada"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("parks unknown reconcilable lookup and recovers applied lookup without redispatch", async () => {
    for (const status of ["unknown", "applied"] as const) {
      const dispatch = vi.fn(async () => Promise.resolve());
      const lookup = vi.fn(async () => Promise.resolve());
      const reconcilableTool = { ...writeTool, effectStrategyKind: "reconcilable" as const };
      const base = reconcilableEffectStrategy({ dispatch, lookup });
      const strategy: RuntimeExecutableEffectStrategy = {
        ...base,
        lookup: async (operationKey, context) => {
          await lookup();
          return status === "unknown"
            ? { status: "unknown" as const }
            : {
                status: "applied" as const,
                execution: acknowledgedExecution(context, operationKey, "lookup_recovery"),
              };
        },
      };
      const value = fixture({
        toolRegistration: reconcilableTool,
        effectStrategy: strategy,
        effectExistingRecord: (key, tenantId, runId) =>
          ledgerRecord(key, tenantId, runId, "dispatched", "reconcilable"),
        modelEmission: effectEmission,
      });
      const started = await value.runtime.start(
        value.authority,
        definition,
        effectRequest,
        commandFor(
          "run.start",
          effectRequest,
          status === "unknown"
            ? "dbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdb"
            : "dcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdc",
        ),
      );
      await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
        status: status === "unknown" ? "parked" : "completed",
      });
      expect(lookup).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it("does not repeat an acknowledged effect after commit succeeds but the worker loses the response", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const effectRequest = { ...request, requestedCapabilities: ["knowledge:write"] };
    const value = fixture({
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(dispatch),
      effectCrashAfterTransition: "EffectAcknowledged",
      modelEmission: (_invocation, _signal, input) =>
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        "toolResult" in input
          ? { type: "final", value: { title: "Recovered", body: "Continued" } }
          : {
              type: "tool_call",
              value: {
                toolRegistrationDigest: writeTool.toolRegistrationDigest,
                input: { value: "one-shot" },
                targetDigest: effectTargetDigest,
              },
            },
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
      "simulated crash after committed EffectAcknowledged",
    );
    expect(dispatch).toHaveBeenCalledOnce();

    const restarted = value.restart();
    await expect(restarted.execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "completed",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.filter((event) => event.eventType === "EffectAcknowledged")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ eventType: "RunCompleted" });
  });

  it("parks an acknowledged effect when its protected result record is unavailable", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const effectRequest = { ...request, requestedCapabilities: ["knowledge:write"] };
    const value = fixture({
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(dispatch),
      effectCrashAfterTransition: "EffectAcknowledged",
      modelEmission: () => ({
        type: "tool_call",
        value: {
          toolRegistrationDigest: writeTool.toolRegistrationDigest,
          input: { value: "one-shot" },
          targetDigest: effectTargetDigest,
        },
      }),
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "c3".repeat(16)),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
      "simulated crash after committed EffectAcknowledged",
    );
    value.effectUnitOfWork?.effectResults.clear();

    await expect(value.restart().execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "parked",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("parks a none-strategy effect after a dispatch-boundary crash without dispatching again", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const noneTool = { ...writeTool, effectStrategyKind: "none" as const };
    const effectRequest = { ...request, requestedCapabilities: ["knowledge:write"] };
    const value = fixture({
      toolRegistration: noneTool,
      effectStrategy: noneEffectStrategy(dispatch),
      effectCrashAfterTransition: "EffectDispatched",
      modelEmission: () => ({
        type: "tool_call",
        value: {
          toolRegistrationDigest: noneTool.toolRegistrationDigest,
          input: { value: "uncertain" },
          targetDigest: effectTargetDigest,
        },
      }),
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
      "simulated crash after committed EffectDispatched",
    );
    expect(dispatch).not.toHaveBeenCalled();

    await expect(value.restart().execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "parked",
    });
    expect(dispatch).not.toHaveBeenCalled();
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.slice(-3).map((event) => event.eventType)).toEqual([
      "EffectUncertain",
      "RunSuspended",
      "EffectNeedsReconciliation",
    ]);
  });

  it("treats a lost or invalid dispatch acknowledgement as uncertain instead of success", async () => {
    const dispatch = vi.fn(async () => Promise.reject(new Error("receiver response lost")));
    const effectRequest = { ...request, requestedCapabilities: ["knowledge:write"] };
    const value = fixture({
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(dispatch),
      modelEmission: () => ({
        type: "tool_call",
        value: {
          toolRegistrationDigest: writeTool.toolRegistrationDigest,
          input: { value: "uncertain" },
          targetDigest: effectTargetDigest,
        },
      }),
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "parked",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await value.runtime.getRun(value.authority, started.runId)).toMatchObject({
      status: "suspended",
      resumeTarget: "running",
    });
  });

  it("allows only an effect:reconcile authority to abandon uncertainty and fails the run", async () => {
    const dispatch = vi.fn(async () => Promise.reject(new Error("receiver response lost")));
    const effectRequest = { ...request, requestedCapabilities: ["knowledge:write"] };
    const value = fixture({
      decisionRoles: ["owner", "effect:reconcile"],
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(dispatch),
      modelEmission: () => ({
        type: "tool_call",
        value: {
          toolRegistrationDigest: writeTool.toolRegistrationDigest,
          input: { value: "uncertain" },
          targetDigest: effectTargetDigest,
        },
      }),
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5"),
    );
    await value.runtime.execute(value.authority, started.runId);
    const effectId = (await value.runtime.getRun(value.authority, started.runId)).activeEffectId!;
    const resolution = {
      schemaVersion: "1" as const,
      kind: "abandon_uncertain" as const,
      reason: "operator cannot prove the remote outcome",
      evidenceRefs: ["incident-42"],
      effectMayHaveOccurred: true as const,
    };
    await expect(
      value.runtime.reconcileEffect(
        value.authority,
        started.runId,
        effectId,
        resolution,
        scopedCommand(
          "run.reconcile_effect",
          resolution,
          [started.runId, effectId],
          "c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6",
        ),
      ),
    ).resolves.toEqual({ runId: started.runId, effectId, status: "abandoned" });
    expect(await value.runtime.getRun(value.authority, started.runId)).toMatchObject({
      status: "failed",
      terminalErrorCode: "KAF_EFFECT_ABANDONED_UNCERTAIN",
    });

    const unauthorized = fixture({
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
    });
    await expect(
      unauthorized.runtime.reconcileEffect(
        unauthorized.authority,
        "run-x",
        "effect-x",
        resolution,
        scopedCommand(
          "run.reconcile_effect",
          resolution,
          ["run-x", "effect-x"],
          "c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
  });

  it("recovers an acknowledgement only through the registered reconcilable lookup", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const lookup = vi.fn(async () => Promise.resolve());
    const reconcilableTool = { ...writeTool, effectStrategyKind: "reconcilable" as const };
    const effectRequest = { ...request, requestedCapabilities: ["knowledge:write"] };
    const value = fixture({
      decisionRoles: ["effect:reconcile"],
      toolRegistration: reconcilableTool,
      effectStrategy: reconcilableEffectStrategy({ dispatch, lookup }),
      modelEmission: () => ({
        type: "tool_call",
        value: {
          toolRegistrationDigest: reconcilableTool.toolRegistrationDigest,
          input: { value: "recoverable" },
          targetDigest: effectTargetDigest,
        },
      }),
    });
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8"),
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "parked",
    });
    const effectId = (await value.runtime.getRun(value.authority, started.runId)).activeEffectId!;
    const resolution = { schemaVersion: "1" as const, kind: "recovered_acknowledgement" as const };
    await expect(
      value.runtime.reconcileEffect(
        value.authority,
        started.runId,
        effectId,
        resolution,
        scopedCommand(
          "run.reconcile_effect",
          resolution,
          [started.runId, effectId],
          "c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9",
        ),
      ),
    ).resolves.toEqual({ runId: started.runId, effectId, status: "recovered" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    expect(await value.runtime.getRun(value.authority, started.runId)).toMatchObject({
      status: "suspended",
      activeEffectId: null,
    });
  });

  it("fails reconciliation before storage when services are unavailable", async () => {
    const value = fixture({ decisionRoles: ["effect:reconcile"] });
    await expect(
      value.runtime.reconcileEffect(
        value.authority,
        "run-missing",
        "effect-missing",
        abandonResolution,
        scopedCommand(
          "run.reconcile_effect",
          abandonResolution,
          ["run-missing", "effect-missing"],
          "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
  });

  it("rejects reconciliation for an active run, missing ledger, or missing definition", async () => {
    const active = fixture({
      decisionRoles: ["effect:reconcile"],
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(vi.fn(async () => Promise.resolve())),
      modelEmission: effectEmission,
    });
    const activeStart = await active.runtime.start(
      active.authority,
      definition,
      effectRequest,
      commandFor("run.start", effectRequest, "efefefefefefefefefefefefefefefef"),
    );
    await expect(
      active.runtime.reconcileEffect(
        active.authority,
        activeStart.runId,
        "effect-missing",
        abandonResolution,
        scopedCommand(
          "run.reconcile_effect",
          abandonResolution,
          [activeStart.runId, "effect-missing"],
          "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_INVALID_TRANSITION" });

    const missingLedger = await parkedEffect();
    missingLedger.value.effectUnitOfWork?.effectRecords.clear();
    await expect(
      missingLedger.value.runtime.reconcileEffect(
        missingLedger.value.authority,
        missingLedger.started.runId,
        missingLedger.effectId,
        abandonResolution,
        scopedCommand(
          "run.reconcile_effect",
          abandonResolution,
          [missingLedger.started.runId, missingLedger.effectId],
          "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_INVALID_TRANSITION" });

    const missingDefinition = await parkedEffect();
    vi.spyOn(missingDefinition.value.agentRegistry, "resolve").mockResolvedValue(undefined);
    await expect(
      missingDefinition.value.runtime.reconcileEffect(
        missingDefinition.value.authority,
        missingDefinition.started.runId,
        missingDefinition.effectId,
        abandonResolution,
        scopedCommand(
          "run.reconcile_effect",
          abandonResolution,
          [missingDefinition.started.runId, missingDefinition.effectId],
          "f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_AGENT_DEFINITION_MISMATCH" });
  });

  it("rejects reconciliation registration drift and non-reconcilable recovery", async () => {
    const unavailable = await parkedEffect();
    if (unavailable.value.effectServices === undefined) throw new Error("effect services missing");
    vi.spyOn(unavailable.value.effectServices.strategies, "resolve").mockReturnValue(undefined);
    await expect(
      unavailable.value.runtime.reconcileEffect(
        unavailable.value.authority,
        unavailable.started.runId,
        unavailable.effectId,
        abandonResolution,
        scopedCommand(
          "run.reconcile_effect",
          abandonResolution,
          [unavailable.started.runId, unavailable.effectId],
          "f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });

    const native = await parkedEffect();
    await expect(
      native.value.runtime.reconcileEffect(
        native.value.authority,
        native.started.runId,
        native.effectId,
        recoveredResolution,
        scopedCommand(
          "run.reconcile_effect",
          recoveredResolution,
          [native.started.runId, native.effectId],
          "f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
  });

  it("rejects reconcilable recovery when the durable operation key is missing", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const lookup = vi.fn(async () => Promise.resolve());
    const reconcilableTool = { ...writeTool, effectStrategyKind: "reconcilable" as const };
    const parked = await parkedEffect({
      toolRegistration: reconcilableTool,
      effectStrategy: reconcilableEffectStrategy({ dispatch, lookup }),
    });
    const record = parked.value.effectUnitOfWork?.effectRecords.get(parked.effectId);
    if (record === undefined) throw new Error("effect record missing");
    parked.value.effectUnitOfWork?.effectRecords.set(
      parked.effectId,
      omitProperty(record, "operationKey") as EffectRecord,
    );
    await expect(
      parked.value.runtime.reconcileEffect(
        parked.value.authority,
        parked.started.runId,
        parked.effectId,
        recoveredResolution,
        scopedCommand(
          "run.reconcile_effect",
          recoveredResolution,
          [parked.started.runId, parked.effectId],
          "f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects unknown lookup status and non-recovery proof during reconciliation", async () => {
    for (const mode of ["unknown", "wrong_proof"] as const) {
      const dispatch = vi.fn(async () => Promise.resolve());
      const lookup = vi.fn(async () => Promise.resolve());
      const reconcilableTool = { ...writeTool, effectStrategyKind: "reconcilable" as const };
      const base = reconcilableEffectStrategy({ dispatch, lookup });
      const strategy: RuntimeExecutableEffectStrategy = {
        ...base,
        lookup: async (operationKey, context) => {
          await lookup();
          return mode === "unknown"
            ? { status: "unknown" as const }
            : {
                status: "applied" as const,
                execution: acknowledgedExecution(context, operationKey, "receiver_receipt"),
              };
        },
      };
      const parked = await parkedEffect({
        toolRegistration: reconcilableTool,
        effectStrategy: strategy,
      });
      await expect(
        parked.value.runtime.reconcileEffect(
          parked.value.authority,
          parked.started.runId,
          parked.effectId,
          recoveredResolution,
          scopedCommand(
            "run.reconcile_effect",
            recoveredResolution,
            [parked.started.runId, parked.effectId],
            mode === "unknown"
              ? "f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5"
              : "f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6",
          ),
        ),
      ).rejects.toBeDefined();
    }
  });

  it("rejects forged authority before any store read", async () => {
    const { runtime, stores } = fixture();
    const read = vi.spyOn(stores.eventStore, "getProjection");
    await expect(runtime.getRun({} as unknown as AuthorityContext, "run-1")).rejects.toMatchObject({
      code: "KAF_AUTHORIZATION_BINDING_MISMATCH",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns the command-unit-of-work result for an identical start command", async () => {
    const { runtime, authority, command, agentRegistry } = fixture();
    const first = await runtime.start(authority, definition, request, command);
    vi.spyOn(agentRegistry, "resolve").mockRejectedValue(new Error("registry unavailable"));
    const second = await runtime.start(authority, definition, request, command);
    expect(second).toEqual(first);
  });

  it("cancels a non-terminal run with an authenticated command", async () => {
    const { runtime, authority, command } = fixture();
    const started = await runtime.start(authority, definition, request, command);
    const cancel = createCommandContext({
      commandId: "kafcmd_1785758400001_11111111111111111111111111111111",
      operation: "run.cancel",
      payload: { runId: started.runId },
    });
    await expect(runtime.cancel(authority, started.runId, cancel)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("accepts only a bounded safe cancellation reason in the stable four-argument surface", async () => {
    const value = fixture();
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    const reason = "caller_requested";
    await expect(
      value.runtime.cancel(
        value.authority,
        started.runId,
        reason,
        commandFor("run.cancel", { runId: started.runId, reason }),
      ),
    ).resolves.toMatchObject({ status: "cancelled" });

    const second = fixture();
    const secondStart = await second.runtime.start(
      second.authority,
      definition,
      request,
      second.command,
    );
    await expect(
      second.runtime.cancel(
        second.authority,
        secondStart.runId,
        "unsafe reason with spaces",
        commandFor("run.cancel", {
          runId: secondStart.runId,
          reason: "unsafe reason with spaces",
        }),
      ),
    ).rejects.toMatchObject({ code: "KAF_SCHEMA_INVALID" });
  });

  it("fails closed on policy denial without calling the tool executor", async () => {
    const { runtime, authority, command, executeTool } = fixture({ policyDecision: "deny" });
    const started = await runtime.start(authority, definition, request, command);
    await expect(runtime.execute(authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "failed",
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect((await runtime.getRun(authority, started.runId)).terminalErrorCode).toBe(
      "KAF_POLICY_DENIED",
    );
  });

  it("parks an approval-required request before tool dispatch", async () => {
    const { runtime, authority, command, executeTool } = fixture({
      policyDecision: "require_approval",
    });
    const started = await runtime.start(authority, definition, request, command);
    await expect(runtime.execute(authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "parked",
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect((await runtime.getRun(authority, started.runId)).status).toBe("waiting_for_approval");
  });

  it("binds approval to the host policy target instead of the model-proposed digest", async () => {
    const modelTarget = d("9");
    const policyTarget = d("2");
    const value = fixture({
      policyDecision: "require_approval",
      policyTargetDigest: policyTarget,
      modelEmission: () => ({
        type: "tool_call",
        value: {
          toolRegistrationDigest: tool.toolRegistrationDigest,
          input: { query: "Pactmark" },
          targetDigest: modelTarget,
        },
      }),
    });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
      status: "parked",
    });
    const decisionId = (await value.runtime.getRun(value.authority, started.runId))
      .waitingDecisionId;
    if (decisionId === null) throw new Error("approval decision is unavailable");
    const issued = await value.runtime.issueDecisionChallenge(
      value.authority,
      started.runId,
      decisionId,
      scopedCommand(
        "run.issue_decision_challenge",
        {},
        [started.runId, decisionId],
        "31313131313131313131313131313131",
      ),
    );
    const challenge = value.getIssuedChallenge(issued.challengeProof);
    expect(challenge?.binding.targetDigest).toBe(policyTarget);
    expect(challenge?.binding.targetDigest).not.toBe(modelTarget);
  });

  it("resumes an approved effect from a fresh runtime through the exact approval suffix", async () => {
    const dispatch = vi.fn(async () => Promise.resolve());
    const value = fixture({
      policyDecisionSequence: ["require_approval", "allow_with_grant"],
      toolRegistration: writeTool,
      effectStrategy: nativeEffectStrategy(dispatch),
      modelEmission: effectEmission,
    });
    const startCommand = commandFor("run.start", effectRequest, "32323232323232323232323232323232");
    const started = await value.runtime.start(
      value.authority,
      definition,
      effectRequest,
      startCommand,
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "parked",
    });
    const decisionId = (await value.runtime.getRun(value.authority, started.runId))
      .waitingDecisionId;
    if (decisionId === null) throw new Error("approval decision is unavailable");
    const issued = await value.runtime.issueDecisionChallenge(
      value.authority,
      started.runId,
      decisionId,
      scopedCommand(
        "run.issue_decision_challenge",
        {},
        [started.runId, decisionId],
        "33323232323232323232323232323232",
      ),
    );
    const submission = {
      decision: "approve" as const,
      decisionId,
      challengeProof: issued.challengeProof,
    };
    await value.runtime.approve(
      value.authority,
      started.runId,
      submission,
      scopedCommand(
        "run.approve",
        submission,
        [started.runId, decisionId],
        "34323232323232323232323232323232",
      ),
    );

    await expect(value.restart().execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "completed",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.filter((event) => event.eventType === "ApprovalRequested")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "ApprovalRecorded")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "EffectAcknowledged")).toHaveLength(1);
  });

  it("issues one proof, consumes it once, replays one approval, and never emits the proof", async () => {
    const value = fixture({ policyDecision: "require_approval" });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await value.runtime.execute(value.authority, started.runId);
    const projection = await value.runtime.getRun(value.authority, started.runId);
    const decisionId = projection.waitingDecisionId!;
    const challengeCommand = scopedCommand(
      "run.issue_decision_challenge",
      {},
      [started.runId, decisionId],
      "33333333333333333333333333333333",
    );
    const issued = await value.runtime.issueDecisionChallenge(
      value.authority,
      started.runId,
      decisionId,
      challengeCommand,
    );
    await expect(
      value.runtime.issueDecisionChallenge(
        value.authority,
        started.runId,
        decisionId,
        challengeCommand,
      ),
    ).resolves.toEqual(issued);
    const submission = {
      decision: "approve" as const,
      decisionId,
      challengeProof: issued.challengeProof,
    };
    const approveCommand = scopedCommand(
      "run.approve",
      submission,
      [started.runId, decisionId],
      "44444444444444444444444444444444",
    );
    const [first, concurrentReplay] = await Promise.all([
      value.runtime.approve(value.authority, started.runId, submission, approveCommand),
      value.runtime.approve(value.authority, started.runId, submission, approveCommand),
    ]);
    expect(concurrentReplay).toEqual(first);
    await expect(
      value.runtime.approve(value.authority, started.runId, submission, approveCommand),
    ).resolves.toEqual(first);
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.filter((event) => event.eventType === "ApprovalRecorded")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(issued.challengeProof);

    const altered = { ...submission, challengeProof: `${issued.challengeProof}:changed` };
    await expect(
      value.runtime.approve(
        value.authority,
        started.runId,
        altered,
        scopedCommand(
          "run.approve",
          altered,
          [started.runId, decisionId],
          "44444444444444444444444444444444",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_HTTP_IDEMPOTENCY_CONFLICT" });
  });

  it("fails closed for an expired, replaced, or cross-tenant decision challenge", async () => {
    let currentTime = now;
    const expired = fixture({
      policyDecision: "require_approval",
      decisionChallengeTtlMs: 1_000,
      clockNow: () => currentTime,
    });
    const started = await expired.runtime.start(
      expired.authority,
      definition,
      request,
      expired.command,
    );
    await expired.runtime.execute(expired.authority, started.runId);
    const decisionId = (await expired.runtime.getRun(expired.authority, started.runId))
      .waitingDecisionId!;
    const challengeCommand = scopedCommand(
      "run.issue_decision_challenge",
      {},
      [started.runId, decisionId],
      "55555555555555555555555555555555",
    );
    const issued = await expired.runtime.issueDecisionChallenge(
      expired.authority,
      started.runId,
      decisionId,
      challengeCommand,
    );
    currentTime = "2026-08-03T12:00:01.000Z";
    const submission = {
      decision: "approve" as const,
      decisionId,
      challengeProof: issued.challengeProof,
    };
    await expect(
      expired.runtime.approve(
        expired.authority,
        started.runId,
        submission,
        scopedCommand(
          "run.approve",
          submission,
          [started.runId, decisionId],
          "66666666666666666666666666666666",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });

    const otherAuthority = expired.authorityIssuer.issue({
      actor: { type: "user", id: "user-1" },
      tenant: { id: "tenant-2" },
      authenticatedAt: now,
      authenticationStrength: "multi_factor",
      decisionRoles: ["owner"],
      requestCorrelationId: "request-other",
      issuedAt: "2026-08-03T11:00:00.000Z",
      expiresAt: "2026-08-03T13:00:00.000Z",
    });
    await expect(
      expired.runtime.issueDecisionChallenge(
        otherAuthority,
        started.runId,
        decisionId,
        scopedCommand(
          "run.issue_decision_challenge",
          {},
          [started.runId, decisionId],
          "77777777777777777777777777777777",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_NOT_FOUND" });
  });

  it("rejects a replaced challenge whose proposed-effect binding changed", async () => {
    const value = fixture({ policyDecision: "require_approval" });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await value.runtime.execute(value.authority, started.runId);
    const decisionId = (await value.runtime.getRun(value.authority, started.runId))
      .waitingDecisionId!;
    const issued = await value.runtime.issueDecisionChallenge(
      value.authority,
      started.runId,
      decisionId,
      scopedCommand(
        "run.issue_decision_challenge",
        {},
        [started.runId, decisionId],
        "abababababababababababababababab",
      ),
    );
    const active = await value.stores.decisionStore.getActiveChallenge(
      "tenant-1",
      started.runId,
      decisionId,
    );
    await value.stores.decisionStore.putChallenge({
      ...active!,
      id: "challenge-replaced",
      proofDigest: digestBytes(new TextEncoder().encode("replacement-proof")),
      binding: { ...active!.binding, targetDigest: d("f") },
    });
    const submission = {
      decision: "approve" as const,
      decisionId,
      challengeProof: issued.challengeProof,
    };
    await expect(
      value.runtime.approve(
        value.authority,
        started.runId,
        submission,
        scopedCommand(
          "run.approve",
          submission,
          [started.runId, decisionId],
          "acacacacacacacacacacacacacacacac",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.filter((event) => event.eventType === "ApprovalRecorded")).toHaveLength(0);
  });

  it("consumes a challenge into a durable rejection without creating an Approval", async () => {
    const value = fixture({ policyDecision: "require_approval" });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await value.runtime.execute(value.authority, started.runId);
    const decisionId = (await value.runtime.getRun(value.authority, started.runId))
      .waitingDecisionId!;
    const issued = await value.runtime.issueDecisionChallenge(
      value.authority,
      started.runId,
      decisionId,
      scopedCommand(
        "run.issue_decision_challenge",
        {},
        [started.runId, decisionId],
        "adadadadadadadadadadadadadadadad",
      ),
    );
    const submission = {
      decision: "reject" as const,
      decisionId,
      challengeProof: issued.challengeProof,
      reasonCode: "operator_rejected",
    };
    await expect(
      value.runtime.reject(
        value.authority,
        started.runId,
        submission,
        scopedCommand(
          "run.reject",
          submission,
          [started.runId, decisionId],
          "aeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae",
        ),
      ),
    ).resolves.toMatchObject({ decisionId, automaticResume: false });
    expect((await value.runtime.getRun(value.authority, started.runId)).status).toBe("failed");
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.filter((event) => event.eventType === "ApprovalRejected")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "ApprovalRecorded")).toHaveLength(0);
  });

  it("resumes a protected model input request on a fresh runtime", async () => {
    const observedInputs: JsonValue[] = [];
    const value = fixture({
      modelEmission: (_invocation, _signal, input) => {
        if (input !== undefined) observedInputs.push(input);
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          !("submittedInput" in input)
        ) {
          return {
            type: "input_request",
            value: {
              inputSchemaDigest: d("c"),
              safePrompt: "Provide the bounded value.",
            },
          };
        }
        return { type: "final", value: { acceptedInput: input.submittedInput } };
      },
    });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "parked",
    });
    const waiting = await value.runtime.getRun(value.authority, started.runId);
    const requestId = waiting.waitingRequestId;
    if (requestId === null) throw new Error("input request is unavailable");
    const submittedInput = { answer: "secret-input-canary" };
    await value.runtime.submitInput(
      value.authority,
      started.runId,
      requestId,
      submittedInput,
      scopedCommand(
        "run.submit_input",
        submittedInput,
        [started.runId, requestId],
        "87878787878787878787878787878787",
      ),
    );
    await expect(value.restart().execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "completed",
    });
    expect(observedInputs.at(-1)).toMatchObject({ submittedInput });
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.filter((event) => event.eventType === "InputRequested")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "InputSubmitted")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("secret-input-canary");
  });

  it("protects typed input, commits one reference event, and scopes replay to the exact value", async () => {
    const value = fixture();
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    const accepted = (await collectEvents(value.stores.eventStore, "tenant-1", started.runId))[0]!;
    await value.stores.eventStore.append(
      {
        ...accepted,
        eventId: "event-planning-input",
        sequence: 2,
        eventType: "PlanningStarted",
        payload: { stepId: "step-input" },
      },
      1,
    );
    await value.stores.eventStore.append(
      {
        ...accepted,
        eventId: "event-input-requested",
        sequence: 3,
        eventType: "InputRequested",
        payload: {
          stepId: "step-input",
          requestId: "request-input",
          inputSchemaDigest: d("c"),
          safePrompt: "Provide the bounded value.",
        },
      },
      2,
    );
    const inputValue = { answer: "protected-value" };
    const command = scopedCommand(
      "run.submit_input",
      inputValue,
      [started.runId, "request-input"],
      "88888888888888888888888888888888",
    );
    const [first, concurrentReplay] = await Promise.all([
      value.runtime.submitInput(
        value.authority,
        started.runId,
        "request-input",
        inputValue,
        command,
      ),
      value.runtime.submitInput(
        value.authority,
        started.runId,
        "request-input",
        inputValue,
        command,
      ),
    ]);
    expect(concurrentReplay).toEqual(first);
    const stored = await value.stores.inputSubmissionStore.get(
      "tenant-1",
      started.runId,
      "request-input",
    );
    expect(stored).toMatchObject({
      inputSubmissionRecordId: first.inputSubmissionRecordId,
      inputSchemaDigest: d("c"),
      valueDigest: digestCanonicalJson(inputValue),
      submittingPrincipalId: "user-1",
    });
    expect(JSON.stringify(stored)).not.toContain("protected-value");
    const events = await collectEvents(value.stores.eventStore, "tenant-1", started.runId);
    expect(events.filter((event) => event.eventType === "InputSubmitted")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("protected-value");

    const replacementCommand = scopedCommand(
      "run.submit_input",
      inputValue,
      [started.runId, "request-input"],
      "99999999999999999999999999999999",
    );
    await expect(
      value.runtime.submitInput(
        value.authority,
        started.runId,
        "request-input",
        inputValue,
        replacementCommand,
      ),
    ).resolves.toMatchObject({ inputSubmissionRecordId: first.inputSubmissionRecordId });

    const changedValue = { answer: "changed" };
    await expect(
      value.runtime.submitInput(
        value.authority,
        started.runId,
        "request-input",
        changedValue,
        scopedCommand(
          "run.submit_input",
          changedValue,
          [started.runId, "request-input"],
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_HTTP_IDEMPOTENCY_CONFLICT" });
  });

  it("fails typed input on state, schema, or protector binding drift", async () => {
    const input = { answer: "value" };
    const notWaiting = fixture();
    const notWaitingRun = await notWaiting.runtime.start(
      notWaiting.authority,
      definition,
      request,
      notWaiting.command,
    );
    await expect(
      notWaiting.runtime.submitInput(
        notWaiting.authority,
        notWaitingRun.runId,
        "request-input",
        input,
        scopedCommand(
          "run.submit_input",
          input,
          [notWaitingRun.runId, "request-input"],
          "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_INVALID_TRANSITION" });

    const schemaDrift = fixture({ typedInputDigestOverride: d("d") });
    const schemaRun = await schemaDrift.runtime.start(
      schemaDrift.authority,
      definition,
      request,
      schemaDrift.command,
    );
    await seedWaitingInput(schemaDrift.stores, schemaRun.runId);
    await expect(
      schemaDrift.runtime.submitInput(
        schemaDrift.authority,
        schemaRun.runId,
        "request-input",
        input,
        scopedCommand(
          "run.submit_input",
          input,
          [schemaRun.runId, "request-input"],
          "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });

    const aadDrift = fixture({ inputProtectorAadMismatch: true });
    const aadRun = await aadDrift.runtime.start(
      aadDrift.authority,
      definition,
      request,
      aadDrift.command,
    );
    await seedWaitingInput(aadDrift.stores, aadRun.runId);
    await expect(
      aadDrift.runtime.submitInput(
        aadDrift.authority,
        aadRun.runId,
        "request-input",
        input,
        scopedCommand(
          "run.submit_input",
          input,
          [aadRun.runId, "request-input"],
          "b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_SECURITY_PROFILE" });
  });

  it("requires an issued challenge and sufficient authentication strength", async () => {
    const value = fixture({
      policyDecision: "require_approval",
      authenticationStrength: "single_factor",
    });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await value.runtime.execute(value.authority, started.runId);
    const decisionId = (await value.runtime.getRun(value.authority, started.runId))
      .waitingDecisionId!;
    const noChallenge = {
      decision: "approve" as const,
      decisionId,
      challengeProof: "proof-without-issued-challenge",
    };
    await expect(
      value.runtime.approve(
        value.authority,
        started.runId,
        noChallenge,
        scopedCommand(
          "run.approve",
          noChallenge,
          [started.runId, decisionId],
          "b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_NOT_FOUND" });
    const issued = await value.runtime.issueDecisionChallenge(
      value.authority,
      started.runId,
      decisionId,
      scopedCommand(
        "run.issue_decision_challenge",
        {},
        [started.runId, decisionId],
        "b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5",
      ),
    );
    const submission = {
      decision: "approve" as const,
      decisionId,
      challengeProof: issued.challengeProof,
    };
    await expect(
      value.runtime.approve(
        value.authority,
        started.runId,
        submission,
        scopedCommand(
          "run.approve",
          submission,
          [started.runId, decisionId],
          "b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
  });

  it("rejects challenge-issuer and Approval output drift before state mutation", async () => {
    await expect(
      parkAndIssue(
        fixture({ policyDecision: "require_approval", challengeIssueMismatch: true }),
        "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });

    const verifyDrift = fixture({
      policyDecision: "require_approval",
      challengeVerifyMismatch: true,
    });
    const verifyValue = await parkAndIssue(verifyDrift, "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2");
    const approve = {
      decision: "approve" as const,
      decisionId: verifyValue.decisionId,
      challengeProof: verifyValue.issued.challengeProof,
    };
    await expect(
      verifyDrift.runtime.approve(
        verifyDrift.authority,
        verifyValue.started.runId,
        approve,
        scopedCommand(
          "run.approve",
          approve,
          [verifyValue.started.runId, verifyValue.decisionId],
          "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    const reject = {
      decision: "reject" as const,
      decisionId: verifyValue.decisionId,
      challengeProof: verifyValue.issued.challengeProof,
      reasonCode: "operator_rejected",
    };
    await expect(
      verifyDrift.runtime.reject(
        verifyDrift.authority,
        verifyValue.started.runId,
        reject,
        scopedCommand(
          "run.reject",
          reject,
          [verifyValue.started.runId, verifyValue.decisionId],
          "c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });

    const approvalDrift = fixture({
      policyDecision: "require_approval",
      approvalBindingMismatch: true,
    });
    const approvalValue = await parkAndIssue(approvalDrift, "c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5");
    const changedApproval = {
      decision: "approve" as const,
      decisionId: approvalValue.decisionId,
      challengeProof: approvalValue.issued.challengeProof,
    };
    await expect(
      approvalDrift.runtime.approve(
        approvalDrift.authority,
        approvalValue.started.runId,
        changedApproval,
        scopedCommand(
          "run.approve",
          changedApproval,
          [approvalValue.started.runId, approvalValue.decisionId],
          "c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6",
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
  });

  it("rejects mismatched definitions, unknown purposes, and registry drift before mutation", async () => {
    const first = fixture();
    const wrongAgent = { ...request, agent: { id: "other", version: definition.version } };
    await expect(
      first.runtime.start(
        first.authority,
        definition,
        wrongAgent,
        commandFor("run.start", wrongAgent),
      ),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_AGENT_DEFINITION_MISMATCH" });

    const unknownPurpose = {
      ...request,
      purpose: { code: "unknown", registryVersion: "general@1" },
    };
    await expect(
      first.runtime.start(
        first.authority,
        definition,
        unknownPurpose,
        commandFor("run.start", unknownPurpose, "33333333333333333333333333333333"),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });

    const drift = fixture({ resolveDefinition: false });
    await expect(
      drift.runtime.start(drift.authority, definition, request, drift.command),
    ).rejects.toMatchObject({ code: "KAF_RUNTIME_AGENT_DEFINITION_MISMATCH" });
  });

  it("persists optional accepted-work-order bindings through the command transaction", async () => {
    const value = {
      ...request,
      decisionOwner: { mode: "registered_role" as const, role: "owner" },
      workflowContext: { workflow: "release" },
      deadline: "2026-08-03T12:30:00.000Z",
      region: "eu-west",
      jurisdiction: "TR",
    };
    const { runtime, authority, stores } = fixture();
    const started = await runtime.start(
      authority,
      definition,
      value,
      commandFor("run.start", value),
    );
    await expect(
      stores.acceptedWorkOrderStore.get("tenant-1", started.workOrderId),
    ).resolves.toMatchObject({
      decisionOwner: { mode: "registered_role", role: "owner" },
      workflowContext: { workflow: "release" },
      deadline: value.deadline,
      region: value.region,
      jurisdiction: value.jurisdiction,
    });
  });

  it("enforces the command time window and durable changed-digest conflict", async () => {
    const fixtureValue = fixture();
    const transact = vi.spyOn(fixtureValue.runCommandUnitOfWork, "transactCommand");
    const expired = createCommandContext({
      commandId: "kafcmd_1785671999999_44444444444444444444444444444444",
      operation: "run.start",
      payload: request,
    });
    await expect(
      fixtureValue.runtime.start(fixtureValue.authority, definition, request, expired),
    ).rejects.toMatchObject({ code: "KAF_COMMAND_IDEMPOTENCY_EXPIRED" });
    expect(transact).not.toHaveBeenCalled();

    await fixtureValue.runtime.start(
      fixtureValue.authority,
      definition,
      request,
      fixtureValue.command,
    );
    const changed = { ...request, goal: "Changed goal" };
    const replay = createCommandContext({
      commandId: fixtureValue.command.commandId,
      operation: "run.start",
      payload: changed,
    });
    await expect(
      fixtureValue.runtime.start(fixtureValue.authority, definition, changed, replay),
    ).rejects.toMatchObject({ code: "KAF_HTTP_IDEMPOTENCY_CONFLICT" });
  });

  it("rejects non-atomic durable scheduling at construction", () => {
    const durableScheduler: WakeupScheduler = {
      capabilities: { ...caps, backgroundWakeup: true, atomicCommandAndWakeup: true },
      schedule: vi.fn(),
      cancel: vi.fn(),
    };
    expect(() => fixture({ wakeupScheduler: durableScheduler })).toThrow(
      expect.objectContaining({ code: "KAF_RUNTIME_NOT_READY" }),
    );
  });

  it("schedules inline wakeups only after a newly committed start", async () => {
    const schedule = vi.fn(() =>
      Promise.resolve({
        schemaVersion: "1" as const,
        receiptId: "receipt-1",
        schedulerId: "fixture",
        requestDigest: d("1"),
        durable: false,
        atomicWithCommand: false,
        createdAt: now,
      }),
    );
    const scheduler: WakeupScheduler = { capabilities: caps, schedule, cancel: vi.fn() };
    const value = fixture({ wakeupScheduler: scheduler });
    const first = await value.runtime.start(value.authority, definition, request, value.command);
    await value.runtime.start(value.authority, definition, request, value.command);
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ runId: first.runId }));
  });

  it("resumes an accepted run, and reports terminal and waiting runs without dispatch", async () => {
    const accepted = fixture();
    const started = await accepted.runtime.start(
      accepted.authority,
      definition,
      request,
      accepted.command,
    );
    const resume = commandFor("run.resume", { runId: started.runId });
    await expect(
      accepted.runtime.resume(accepted.authority, started.runId, resume),
    ).resolves.toMatchObject({
      status: "completed",
    });
    await expect(
      accepted.runtime.resume(accepted.authority, started.runId, resume),
    ).resolves.toMatchObject({ status: "completed" });

    const waiting = fixture({ policyDecision: "require_approval" });
    const waitingStarted = await waiting.runtime.start(
      waiting.authority,
      definition,
      request,
      waiting.command,
    );
    await waiting.runtime.execute(waiting.authority, waitingStarted.runId);
    await expect(
      waiting.runtime.resume(
        waiting.authority,
        waitingStarted.runId,
        commandFor(
          "run.resume",
          { runId: waitingStarted.runId },
          "55555555555555555555555555555555",
        ),
      ),
    ).resolves.toEqual({ runId: waitingStarted.runId, status: "parked" });
  });

  it("fails closed on exhausted turn, model, active-time, and byte budgets", async () => {
    const cases = [
      { budget: { ...request.budget, maxTurns: 1 }, reason: "turn" },
      { budget: { ...request.budget, maxModelCalls: 1 }, reason: "model" },
      {
        budget: { ...request.budget, maxModelInputBytesPerCall: 1 },
        reason: "input bytes",
      },
      {
        budget: { ...request.budget, maxStreamedOutputBytesPerCall: 1 },
        reason: "output bytes",
      },
      {
        budget: { ...request.budget, maxToolResultContextBytesPerCall: 1 },
        reason: "tool bytes",
      },
    ];
    const suffixes = ["6", "7", "8", "9", "a"];
    for (const [index, testCase] of cases.entries()) {
      const value = { ...request, budget: testCase.budget };
      const current = fixture();
      const started = await current.runtime.start(
        current.authority,
        definition,
        value,
        commandFor("run.start", value, suffixes[index]!.repeat(32)),
      );
      await expect(
        current.runtime.execute(current.authority, started.runId),
        testCase.reason,
      ).resolves.toMatchObject({
        status: "failed",
      });
    }

    let monotonic = 0;
    const active = fixture({ monotonicMilliseconds: () => (monotonic += 100) });
    const activeRequest = {
      ...request,
      budget: { ...request.budget, maxActiveExecutionMs: 50 },
    };
    const activeStarted = await active.runtime.start(
      active.authority,
      definition,
      activeRequest,
      commandFor("run.start", activeRequest, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    );
    await expect(
      active.runtime.execute(active.authority, activeStarted.runId),
    ).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("enforces deadline, tool registration, scope, risk, global and per-tool call limits", async () => {
    const deadlineRequest = { ...request, deadline: now };
    const deadline = fixture();
    const deadlineStarted = await deadline.runtime.start(
      deadline.authority,
      definition,
      deadlineRequest,
      commandFor("run.start", deadlineRequest),
    );
    await expect(
      deadline.runtime.execute(deadline.authority, deadlineStarted.runId),
    ).resolves.toMatchObject({
      status: "failed",
    });

    for (const [index, options] of [
      { toolRegistration: null },
      { toolRegistration: { ...tool, security: { ...tool.security, riskClass: "R2" as const } } },
      { toolRegistration: { ...tool, effectStrategyKind: "native" as const } },
    ].entries()) {
      const value = fixture(options);
      const started = await value.runtime.start(
        value.authority,
        definition,
        request,
        value.command,
      );
      await expect(
        value.runtime.execute(value.authority, started.runId),
        String(index),
      ).resolves.toMatchObject({
        status: "failed",
      });
      expect(value.executeTool).not.toHaveBeenCalled();
    }

    const noScopeRequest = { ...request, requestedCapabilities: [] };
    const noScope = fixture();
    const noScopeStarted = await noScope.runtime.start(
      noScope.authority,
      definition,
      noScopeRequest,
      commandFor("run.start", noScopeRequest, "cccccccccccccccccccccccccccccccc"),
    );
    await expect(
      noScope.runtime.execute(noScope.authority, noScopeStarted.runId),
    ).resolves.toMatchObject({
      status: "failed",
    });

    const loopingEmission = () => ({
      type: "tool_call",
      value: {
        toolRegistrationDigest: tool.toolRegistrationDigest,
        input: {},
        targetDigest: d("2"),
      },
    });
    const perTool = fixture({
      modelEmission: loopingEmission,
      toolRegistration: { ...tool, security: { ...tool.security, maxCallsPerRun: 1 } },
    });
    const perToolStarted = await perTool.runtime.start(
      perTool.authority,
      definition,
      request,
      perTool.command,
    );
    await expect(
      perTool.runtime.execute(perTool.authority, perToolStarted.runId),
    ).resolves.toMatchObject({
      status: "failed",
    });
    expect(perTool.executeTool).toHaveBeenCalledOnce();

    const globalRequest = { ...request, budget: { ...request.budget, maxToolCalls: 1 } };
    const global = fixture({ modelEmission: loopingEmission });
    const globalStarted = await global.runtime.start(
      global.authority,
      definition,
      globalRequest,
      commandFor("run.start", globalRequest, "dddddddddddddddddddddddddddddddd"),
    );
    await expect(
      global.runtime.execute(global.authority, globalStarted.runId),
    ).resolves.toMatchObject({
      status: "failed",
    });
    expect(global.executeTool).toHaveBeenCalledOnce();
  });

  it("fails an empty model stream and verifier denial, and rejects unsupported artifact storage", async () => {
    const empty = fixture({ modelEmission: () => undefined });
    const emptyStarted = await empty.runtime.start(
      empty.authority,
      definition,
      request,
      empty.command,
    );
    await expect(empty.runtime.execute(empty.authority, emptyStarted.runId)).resolves.toMatchObject(
      {
        status: "failed",
      },
    );

    for (const options of [{ verifierAvailable: false }, { verificationStatus: "fail" as const }]) {
      const value = fixture(options);
      const started = await value.runtime.start(
        value.authority,
        definition,
        request,
        value.command,
      );
      await expect(value.runtime.execute(value.authority, started.runId)).resolves.toMatchObject({
        status: "failed",
      });
    }

    const restrictedRequest = { ...request, dataClass: "highly_restricted" as const };
    const restricted = fixture({ modelEmission: () => ({ type: "final", value: {} }) });
    await expect(
      restricted.runtime.start(
        restricted.authority,
        definition,
        restrictedRequest,
        commandFor("run.start", restrictedRequest, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_SECURITY_PROFILE" });
  });

  it("propagates cancellation to the active model and records one terminal cancellation", async () => {
    let entered: (() => void) | undefined;
    const modelEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const value = fixture({
      modelEmission: async (_invocation, signal) => {
        entered?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("aborted", "AbortError"));
            },
            {
              once: true,
            },
          );
        });
        return undefined;
      },
    });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    const executing = value.runtime.execute(value.authority, started.runId);
    await modelEntered;
    const cancel = commandFor("run.cancel", { runId: started.runId });
    await value.runtime.cancel(value.authority, started.runId, cancel);
    await expect(executing).resolves.toEqual({ runId: started.runId, status: "cancelled" });
    await expect(
      value.runtime.cancel(value.authority, started.runId, cancel),
    ).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("uses a lease for exclusivity and parks an interrupted boundary instead of repeating it", async () => {
    const occupied = fixture();
    const occupiedStarted = await occupied.runtime.start(
      occupied.authority,
      definition,
      request,
      occupied.command,
    );
    const lease = await occupied.stores.leaseStore.acquire(
      "tenant-1",
      occupiedStarted.runId,
      "other-worker",
      30_000,
    );
    await expect(
      occupied.runtime.execute(occupied.authority, occupiedStarted.runId),
    ).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    if (lease !== undefined) await occupied.stores.leaseStore.release(lease);

    const interrupted = fixture({
      modelEmission: async () => Promise.reject(new Error("host disappeared")),
    });
    const interruptedStarted = await interrupted.runtime.start(
      interrupted.authority,
      definition,
      request,
      interrupted.command,
    );
    await expect(
      interrupted.runtime.execute(interrupted.authority, interruptedStarted.runId),
    ).rejects.toThrow("host disappeared");
    await expect(
      interrupted.runtime.execute(interrupted.authority, interruptedStarted.runId),
    ).resolves.toEqual({ runId: interruptedStarted.runId, status: "parked" });
    expect(
      (await interrupted.runtime.getRun(interrupted.authority, interruptedStarted.runId)).status,
    ).toBe("suspended");
  });

  it("reconstructs completed model/tool active time from events before parking a later crash", async () => {
    const value = fixture({
      modelEmission: (invocation) => {
        if (invocation === 1) {
          return {
            type: "tool_call",
            value: {
              toolRegistrationDigest: tool.toolRegistrationDigest,
              input: { query: "bounded" },
              targetDigest: d("2"),
            },
          };
        }
        return Promise.reject(new Error("second host boundary disappeared"));
      },
    });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toThrow(
      "second host boundary disappeared",
    );
    await expect(value.runtime.execute(value.authority, started.runId)).resolves.toEqual({
      runId: started.runId,
      status: "parked",
    });
    expect(value.executeTool).toHaveBeenCalledOnce();
  });

  it("aborts an external boundary on heartbeat lease loss before committing its result", async () => {
    const value = fixture({
      leaseTtlMs: 3,
      modelEmission: async (_invocation, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("lease lost", "AbortError"));
            },
            { once: true },
          );
        });
        return { type: "final", value: {} };
      },
    });
    const originalRenew = value.stores.leaseStore.renew.bind(value.stores.leaseStore);
    let renewals = 0;
    vi.spyOn(value.stores.leaseStore, "renew").mockImplementation(async (lease, ttlMs) => {
      renewals += 1;
      if (renewals >= 3) throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT");
      return originalRenew(lease, ttlMs);
    });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(value.runtime.execute(value.authority, started.runId)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    expect((await value.runtime.getRun(value.authority, started.runId)).status).toBe("planning");
  });

  it("tails events after a sequence with bounded polling and stops at terminal state", async () => {
    const value = fixture();
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    const observed: string[] = [];
    const stream = (async () => {
      for await (const event of value.runtime.events(value.authority, started.runId, {
        afterSequence: 1,
      })) {
        observed.push(event.eventType);
      }
    })();
    await value.runtime.execute(value.authority, started.runId);
    await stream;
    expect(observed.at(0)).toBe("PlanningStarted");
    expect(observed.at(-1)).toBe("RunCompleted");
    expect(observed).not.toContain("RunAccepted");
  });

  it("returns not-found only after valid authority for run and event reads", async () => {
    const value = fixture();
    await expect(value.runtime.getRun(value.authority, "missing")).rejects.toMatchObject({
      code: "KAF_STORAGE_NOT_FOUND",
    });
    const stream = value.runtime.events(value.authority, "missing")[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toMatchObject({ code: "KAF_STORAGE_NOT_FOUND" });
  });

  it("atomically enqueues durable starts and resumes without calling a scheduler out of band", async () => {
    const schedule = vi.fn();
    const scheduler: WakeupScheduler = {
      capabilities: { ...caps, backgroundWakeup: true, atomicCommandAndWakeup: true },
      schedule,
      cancel: vi.fn(),
    };
    const value = fixture({ wakeupScheduler: scheduler, atomicCommandAndWakeup: true });
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    await expect(
      value.runtime.resume(
        value.authority,
        started.runId,
        commandFor("run.resume", { runId: started.runId }),
      ),
    ).resolves.toEqual({ runId: started.runId, status: "parked" });
    await seedWaitingInput(value.stores, started.runId);
    const input = { answer: "wake" };
    await expect(
      value.runtime.submitInput(
        value.authority,
        started.runId,
        "request-input",
        input,
        scopedCommand(
          "run.submit_input",
          input,
          [started.runId, "request-input"],
          "dededededededededededededededede",
        ),
      ),
    ).resolves.toMatchObject({ automaticResume: true });
    expect(schedule).not.toHaveBeenCalled();
    expect((value.runCommandUnitOfWork as MemoryCommandUnitOfWork).enqueuedWakeups).toHaveLength(3);
  });

  it("atomically couples an approved decision to its durable wake-up", async () => {
    const scheduler: WakeupScheduler = {
      capabilities: { ...caps, backgroundWakeup: true, atomicCommandAndWakeup: true },
      schedule: vi.fn(),
      cancel: vi.fn(),
    };
    const value = fixture({
      policyDecision: "require_approval",
      wakeupScheduler: scheduler,
      atomicCommandAndWakeup: true,
    });
    const gated = await parkAndIssue(value, "dfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdf");
    const submission = {
      decision: "approve" as const,
      decisionId: gated.decisionId,
      challengeProof: gated.issued.challengeProof,
    };
    await expect(
      value.runtime.approve(
        value.authority,
        gated.started.runId,
        submission,
        scopedCommand(
          "run.approve",
          submission,
          [gated.started.runId, gated.decisionId],
          "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0",
        ),
      ),
    ).resolves.toMatchObject({ automaticResume: true });
    expect((value.runCommandUnitOfWork as MemoryCommandUnitOfWork).enqueuedWakeups).toHaveLength(2);
  });

  it("atomically couples a rejected decision to its durable wake-up", async () => {
    const scheduler: WakeupScheduler = {
      capabilities: { ...caps, backgroundWakeup: true, atomicCommandAndWakeup: true },
      schedule: vi.fn(),
      cancel: vi.fn(),
    };
    const value = fixture({
      policyDecision: "require_approval",
      wakeupScheduler: scheduler,
      atomicCommandAndWakeup: true,
    });
    const gated = await parkAndIssue(value, "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1");
    const submission = {
      decision: "reject" as const,
      decisionId: gated.decisionId,
      challengeProof: gated.issued.challengeProof,
      reasonCode: "operator_rejected",
    };
    await expect(
      value.runtime.reject(
        value.authority,
        gated.started.runId,
        submission,
        scopedCommand(
          "run.reject",
          submission,
          [gated.started.runId, gated.decisionId],
          "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2",
        ),
      ),
    ).resolves.toMatchObject({ automaticResume: true });
  });

  it("maps host-policy input retention and requires fresh presence for R5", async () => {
    const retained = fixture();
    const retainedRequest = {
      ...request,
      retention: { mode: "host_policy" as const, policyId: "retention-1" },
    };
    const retainedRun = await retained.runtime.start(
      retained.authority,
      definition,
      retainedRequest,
      commandFor("run.start", retainedRequest),
    );
    await seedWaitingInput(retained.stores, retainedRun.runId);
    const input = { answer: "retained" };
    await retained.runtime.submitInput(
      retained.authority,
      retainedRun.runId,
      "request-input",
      input,
      scopedCommand(
        "run.submit_input",
        input,
        [retainedRun.runId, "request-input"],
        "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3",
      ),
    );
    await expect(
      retained.stores.inputSubmissionStore.get("tenant-1", retainedRun.runId, "request-input"),
    ).resolves.toMatchObject({ retention: { mode: "policy", policyId: "retention-1" } });

    const r5 = fixture({
      policyDecision: "require_approval",
      authenticationStrength: "user_presence",
      authenticatedAt: "2026-08-03T11:00:00.000Z",
      toolRegistration: {
        ...tool,
        security: {
          ...tool.security,
          riskClass: "R5",
          reversibility: "irreversible",
        },
        effectStrategyKind: "none",
      },
    });
    const gated = await parkAndIssue(r5, "e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4");
    const approval = {
      decision: "approve" as const,
      decisionId: gated.decisionId,
      challengeProof: gated.issued.challengeProof,
    };
    await expect(
      r5.runtime.approve(
        r5.authority,
        gated.started.runId,
        approval,
        scopedCommand(
          "run.approve",
          approval,
          [gated.started.runId, gated.decisionId],
          "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
        ),
      ),
    ).rejects.toMatchObject({
      code: "KAF_AUTHORIZATION_EXPIRED",
      details: { reason: "fresh_authentication_required" },
    });
  });

  it("covers terminal cancel/resume/execute mappings without creating another event", async () => {
    const completed = fixture();
    const completedStart = await completed.runtime.start(
      completed.authority,
      definition,
      request,
      completed.command,
    );
    await completed.runtime.execute(completed.authority, completedStart.runId);
    const cancelCompleted = commandFor("run.cancel", { runId: completedStart.runId });
    await expect(
      completed.runtime.cancel(completed.authority, completedStart.runId, cancelCompleted),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      completed.runtime.execute(completed.authority, completedStart.runId),
    ).resolves.toEqual({
      runId: completedStart.runId,
      status: "completed",
    });

    const cancelled = fixture();
    const cancelledStart = await cancelled.runtime.start(
      cancelled.authority,
      definition,
      request,
      cancelled.command,
    );
    await cancelled.runtime.cancel(
      cancelled.authority,
      cancelledStart.runId,
      commandFor("run.cancel", { runId: cancelledStart.runId }, "ffffffffffffffffffffffffffffffff"),
    );
    await expect(
      cancelled.runtime.execute(cancelled.authority, cancelledStart.runId),
    ).resolves.toEqual({
      runId: cancelledStart.runId,
      status: "cancelled",
    });
    await expect(
      cancelled.runtime.resume(
        cancelled.authority,
        cancelledStart.runId,
        commandFor("run.resume", { runId: cancelledStart.runId }),
      ),
    ).resolves.toEqual({ runId: cancelledStart.runId, status: "cancelled" });

    const failed = fixture({ policyDecision: "deny" });
    const failedStart = await failed.runtime.start(
      failed.authority,
      definition,
      request,
      failed.command,
    );
    await failed.runtime.execute(failed.authority, failedStart.runId);
    await expect(failed.runtime.execute(failed.authority, failedStart.runId)).resolves.toEqual({
      runId: failedStart.runId,
      status: "failed",
    });
    await expect(
      failed.runtime.resume(
        failed.authority,
        failedStart.runId,
        commandFor("run.resume", { runId: failedStart.runId }, "abababababababababababababababab"),
      ),
    ).resolves.toEqual({ runId: failedStart.runId, status: "failed" });
  });

  it("rejects wrong command bindings and future command IDs before a command transaction", async () => {
    const value = fixture();
    const wrongOperation = createCommandContext({
      commandId: "kafcmd_1785758400002_acacacacacacacacacacacacacacacac",
      operation: "run.resume",
      payload: request,
    });
    await expect(
      value.runtime.start(value.authority, definition, request, wrongOperation),
    ).rejects.toMatchObject({ code: "KAF_HTTP_IDEMPOTENCY_CONFLICT" });
    const wrongDigest = commandFor(
      "run.start",
      { unrelated: true },
      "adadadadadadadadadadadadadadadad",
    );
    await expect(
      value.runtime.start(value.authority, definition, request, wrongDigest),
    ).rejects.toMatchObject({ code: "KAF_HTTP_IDEMPOTENCY_CONFLICT" });
    const future = createCommandContext({
      commandId: "kafcmd_1785759000001_aeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae",
      operation: "run.start",
      payload: request,
    });
    await expect(
      value.runtime.start(value.authority, definition, request, future),
    ).rejects.toMatchObject({
      code: "KAF_HTTP_IDEMPOTENCY_CONFLICT",
      details: { reason: "KAF_COMMAND_ID_FUTURE_SKEW" },
    });
  });

  it("honors already-aborted and mid-boundary AbortSignals", async () => {
    const before = fixture();
    const beforeStart = await before.runtime.start(
      before.authority,
      definition,
      request,
      before.command,
    );
    const alreadyAborted = new AbortController();
    alreadyAborted.abort("caller_cancelled");
    await expect(
      before.runtime.execute(before.authority, beforeStart.runId, {
        signal: alreadyAborted.signal,
      }),
    ).resolves.toEqual({ runId: beforeStart.runId, status: "cancelled" });

    let entered: (() => void) | undefined;
    const modelEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const during = fixture({
      modelEmission: async (_invocation, signal) => {
        entered?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("aborted", "AbortError"));
            },
            {
              once: true,
            },
          );
        });
        return undefined;
      },
    });
    const duringStart = await during.runtime.start(
      during.authority,
      definition,
      request,
      during.command,
    );
    const controller = new AbortController();
    const running = during.runtime.execute(during.authority, duringStart.runId, {
      signal: controller.signal,
    });
    await modelEntered;
    controller.abort("caller_cancelled");
    await expect(running).resolves.toEqual({ runId: duringStart.runId, status: "cancelled" });
  });

  it("stops event polling on abort and propagates non-abort poll failures", async () => {
    const value = fixture();
    const started = await value.runtime.start(value.authority, definition, request, value.command);
    const controller = new AbortController();
    const iterator = value.runtime
      .events(value.authority, started.runId, { signal: controller.signal })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { eventType: "RunAccepted" } });
    const waiting = iterator.next();
    globalThis.setTimeout(() => {
      controller.abort();
    }, 0);
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });

    const aborted = new AbortController();
    aborted.abort();
    const preAborted = value.runtime
      .events(value.authority, started.runId, { signal: aborted.signal })
      [Symbol.asyncIterator]();
    await expect(preAborted.next()).resolves.toEqual({ done: true, value: undefined });

    const pollError = fixture({ sleep: async () => Promise.reject(new Error("poll failed")) });
    const pollStart = await pollError.runtime.start(
      pollError.authority,
      definition,
      request,
      pollError.command,
    );
    const failedIterator = pollError.runtime
      .events(pollError.authority, pollStart.runId)
      [Symbol.asyncIterator]();
    await failedIterator.next();
    await expect(failedIterator.next()).rejects.toThrow("poll failed");
  });

  it("fails closed when accepted work or the registered definition disappears", async () => {
    const missingWork = fixture();
    const missingWorkStart = await missingWork.runtime.start(
      missingWork.authority,
      definition,
      request,
      missingWork.command,
    );
    await missingWork.stores.acceptedWorkOrderStore.delete(
      "tenant-1",
      missingWorkStart.workOrderId,
    );
    await expect(
      missingWork.runtime.execute(missingWork.authority, missingWorkStart.runId),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_NOT_FOUND" });

    const drift = fixture();
    const driftStart = await drift.runtime.start(
      drift.authority,
      definition,
      request,
      drift.command,
    );
    vi.spyOn(drift.agentRegistry, "resolve").mockResolvedValue(undefined);
    await expect(drift.runtime.execute(drift.authority, driftStart.runId)).rejects.toMatchObject({
      code: "KAF_RUNTIME_AGENT_DEFINITION_MISMATCH",
    });
  });

  it("normalizes host-policy artifact retention", async () => {
    const value = fixture({ modelEmission: () => ({ type: "final", value: { ok: true } }) });
    const hostPolicyRequest = {
      ...request,
      retention: { mode: "host_policy" as const, policyId: "retention-30d" },
    };
    const started = await value.runtime.start(
      value.authority,
      definition,
      hostPolicyRequest,
      commandFor("run.start", hostPolicyRequest, "afafafafafafafafafafafafafafafaf"),
    );
    await value.runtime.execute(value.authority, started.runId);
    const projection = await value.runtime.getRun(value.authority, started.runId);
    const stored = await value.stores.artifactStore.get("tenant-1", projection.artifactIds[0]!);
    expect(stored?.artifact.retention).toEqual({ mode: "policy", policyId: "retention-30d" });
  });
});
