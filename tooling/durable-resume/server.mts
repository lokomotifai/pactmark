import { once } from "node:events";

import {
  createAuthorityIssuer,
  defineModelAdapterRegistration,
  defineModelResourceProfile,
  defineModelSecurityProfile,
  digestCanonicalJson,
  type AgentDefinition,
  type AuthorityContext,
  type CapabilityGrant,
  type DataProtector,
  type EvidenceBuilder,
  type JsonValue,
  KafError,
  ModelCredentialRefSchema,
  ResolvedModelCredential,
  type ProtectedValueRef,
  ProtectedValueRefSchema,
  type RunCommandTransaction,
  type RunCommandUnitOfWork,
  type RunTransitionKey,
  type RuntimeCapabilities,
  type ToolRegistrationContract,
  type VerificationResult,
  type WorkOrderRequest,
} from "@pactmark/core";
import {
  buildEvidenceRecord,
  verificationResultIdentity,
} from "../../packages/evidence/src/index.js";
import { createAgentFetchHandler, type HttpRuntimeSurface } from "../../packages/http/src/index.js";
import { closeNodeServer, createPactmarkNodeServer } from "../../packages/node/src/index.js";
import {
  createRuntime,
  effectProofDigest,
  type RuntimeEffectServices,
  type RuntimeExecutableEffectStrategy,
  type RuntimeProductionModelServices,
} from "../../packages/runtime/src/index.js";
import {
  Aes256GcmDataProtector,
  PostgresMigrationManager,
  PostgresProtectionNonceRegistry,
  createPostgresDatabase,
  createPostgresStorageSecurityProfile,
  createPostgresStoreSuite,
  toPgPoolConfig,
} from "../../packages/store-postgres/src/index.js";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`KAF_DURABLE_ENV_REQUIRED:${name}`);
  return value;
}

const connectionString = requireEnvironment("PACTMARK_TEST_POSTGRES_URL");
const rawPhase = process.env["PACTMARK_DURABLE_PHASE"];
const scenarioId = requireEnvironment("PACTMARK_DURABLE_SCENARIO_ID");
if (rawPhase !== "A" && rawPhase !== "B") throw new Error("KAF_DURABLE_PHASE_INVALID");
const phase: "A" | "B" = rawPhase;
if (!/^[a-z0-9]{12}$/u.test(scenarioId)) throw new Error("KAF_DURABLE_SCENARIO_ID_INVALID");

const tenantId = `durable-tenant-${scenarioId}`;
const otherTenantId = `durable-other-${scenarioId}`;
const principalId = `durable-principal-${scenarioId}`;
const now = () => new Date().toISOString();
const d = (value: unknown) => digestCanonicalJson(value);
const effectTarget = `urn:pactmark:durable-receiver:${scenarioId}`;
const effectTargetDigest = d(effectTarget);
const keyRecord = {
  keyId: `durable-test-key-${scenarioId}`,
  key: new Uint8Array(32).fill(37),
};

function emitControl(message: Readonly<Record<string, unknown>>): void {
  if (process.send === undefined) throw new Error("KAF_DURABLE_IPC_REQUIRED");
  process.send(message);
}

const capabilities: RuntimeCapabilities = {
  schemaVersion: "1",
  executionProfile: "durable",
  durableStorage: true,
  protectedContext: true,
  protectedWorkOrders: true,
  protectedInputSubmissions: true,
  streaming: true,
  cancellation: true,
  sandbox: "unsafe_local",
  networkPolicy: "none",
  backgroundWakeup: false,
  atomicCommandAndWakeup: true,
  humanDecisions: false,
  typedInput: true,
  effectReconciliation: true,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: ["postgres.main"],
};

const writeTool: ToolRegistrationContract = {
  schemaVersion: "1",
  id: "durable.receiver.write@1",
  implementationVersion: "1.0.0",
  description: "Write exactly one deterministic durable receiver record.",
  inputSchemaDigest: d("durable-input-schema"),
  outputSchemaDigest: d("durable-output-schema"),
  security: {
    schemaVersion: "1",
    riskClass: "R3",
    dataClasses: ["internal"],
    reversibility: "irreversible",
    requiredScopes: ["durable:write"],
    egress: { mode: "none" },
    networkEnforcement: "declared_ok",
    maxCallsPerRun: 1,
    timeoutMs: 5_000,
  },
  effectStrategyKind: "native",
  previewStrategyRegistrationDigest: d("durable-preview-strategy"),
  effectStrategyRegistrationDigest: d("durable-effect-strategy"),
  executorKind: "durable-test-receiver",
  executorVersion: "1.0.0",
  toolRegistrationDigest: d("durable-tool-registration"),
};

const modelSecurity = defineModelSecurityProfile({
  id: "durable.fixture-model@1",
  provider: "pactmark-fixture",
  model: "durable-deterministic",
  endpointOrigin: "https://model.fixture.invalid",
  credentialSlot: "durable.fixture-model-key",
  allowedTenants: [tenantId],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["internal"],
  processingRegion: "fixture-local",
  retention: "none",
  logging: "none",
  training: "none",
  contractReference: "pactmark-durable-fixture@1",
});
const modelResource = defineModelResourceProfile({
  id: "durable.fixture-resource@1",
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
  estimator: "durable-conservative-estimator@1",
  providerOutputCap: "enforced",
});
const modelRegistration = defineModelAdapterRegistration({
  id: "durable.sealed-model-adapter@1",
  implementationVersion: "1.0.0",
  securityProfile: modelSecurity,
  resourceProfile: modelResource,
  credentialSlot: modelSecurity.credentialSlot,
  endpointOrigin: modelSecurity.endpointOrigin,
  endpointNormalizerVersion: "whatwg-origin@1",
  adapterArtifact: {
    packageName: "@pactmark/testing",
    exportName: "durableSealedModelAdapter",
    packageVersion: "0.1.0",
    artifactDigest: d("durable-adapter-artifact"),
  },
  providerArtifact: {
    packageName: "@pactmark/testing",
    exportName: "durableFixtureProvider",
    packageVersion: "0.1.0",
    artifactDigest: d("durable-provider-artifact"),
  },
  executorIdentity: { kind: "sealed-durable-fixture" },
  egressEnforcementIdentity: { mode: "fixture-no-network" },
  conservativeEstimatorIdentity: { id: "durable-conservative-estimator@1" },
  providerOutputCapIdentity: { setting: "maxOutputTokens", enforcement: "required" },
  streamCounterIdentity: { id: "durable-stream-counter@1" },
  usageTrustIdentity: { id: "durable-local-usage@1" },
  capabilityContract: { streaming: true, tools: true },
});

const definition: AgentDefinition = {
  schemaVersion: "1",
  id: "durable-resume-agent",
  version: "1.0.0",
  description: "Deterministic process-level durable resume acceptance agent.",
  instructions: {
    schemaVersion: "1",
    entries: [
      {
        schemaVersion: "1",
        sourceName: "durable-resume",
        text: "Perform one governed write, then emit a verified artifact.",
        contentDigest: d("durable-instructions"),
      },
    ],
    bundleDigest: d("durable-instruction-bundle"),
  },
  skillManifestDigests: [],
  inputSchemaDigest: d("durable-agent-input"),
  outputSchemaDigest: d("durable-agent-output"),
  toolRegistrationDigests: [writeTool.toolRegistrationDigest],
  policyRegistrationDigest: d("durable-policy"),
  verifierRegistrationDigests: [d("durable-verifier")],
  modelSecurityProfileDigest: modelSecurity.modelSecurityProfileDigest,
  modelResourceProfileDigest: modelResource.modelResourceProfileDigest,
  modelAdapterRegistrationDigest: modelRegistration.modelAdapterRegistrationDigest,
  modelConfig: { mode: "deterministic-fixture" },
  requiredRuntimeCapabilities: ["durableStorage", "protectedContext"],
  agentDefinitionDigest: d("durable-agent-definition"),
};

export const durableWorkOrder: WorkOrderRequest = {
  schemaVersion: "1",
  agent: { id: definition.id, version: definition.version },
  goal: "Prove one acknowledged effect survives a process crash.",
  input: { scenarioId },
  context: { roleFamily: "testing", workflowId: "durable-resume", riskClass: "medium" },
  workMode: "automate",
  autonomyMode: "delegate_review",
  decisionOwner: { mode: "requesting_principal" },
  purpose: { code: "service_delivery", registryVersion: "general@1" },
  dataClass: "internal",
  retention: { mode: "session" },
  requestedCapabilities: ["durable:write"],
  resourceScopeCeiling: [
    { kind: "urn", value: effectTarget, normalizationVersion: "durable-fixture@1" },
  ],
  budget: {
    maxTurns: 4,
    maxModelCalls: 3,
    maxToolCalls: 1,
    maxActiveExecutionMs: 10_000,
    maxToolResultContextBytesPerCall: 8_192,
    maxContextSnapshotBytes: 65_536,
  },
};

const database = createPostgresDatabase(
  toPgPoolConfig({
    profile: "development",
    connectionString,
    ssl: { mode: "disable" },
    maxConnections: 8,
    applicationName: `pactmark-durable-${phase.toLowerCase()}`,
  }),
);
await new PostgresMigrationManager(database).migrate();
await database.query(
  `CREATE TABLE IF NOT EXISTS pactmark_test_effect_receiver (
     scenario_id text PRIMARY KEY,
     effect_key text NOT NULL,
     call_count integer NOT NULL CHECK (call_count > 0),
     receipt_digest text NOT NULL,
     acknowledged_at timestamptz NOT NULL
   )`,
);
await database.query(
  `CREATE TABLE IF NOT EXISTS pactmark_test_protected_payloads (
     scenario_id text NOT NULL,
     ciphertext_ref text NOT NULL,
     reference_json jsonb NOT NULL,
     PRIMARY KEY (scenario_id, ciphertext_ref)
   )`,
);

const securityProfile = createPostgresStorageSecurityProfile({
  id: `pactmark.durable-resume.${scenarioId}`,
  allowedTenants: [tenantId, otherTenantId],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["internal"],
  transportMode: "development-plaintext",
});
const inlineProtector = new Aes256GcmDataProtector({
  keyProvider: {
    current: () => Promise.resolve(keyRecord),
    resolve: (keyId) => Promise.resolve(keyId === keyRecord.keyId ? keyRecord : undefined),
  },
  nonceRegistry: new PostgresProtectionNonceRegistry(database),
  namespace: `durable-resume-${scenarioId}`,
});
function normalizedProtectionBinding(
  binding: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (binding["storeKind"] !== "accepted_work_order") return binding;
  return Object.fromEntries(
    Object.entries(binding).filter(([name]) => name !== "purposeRegistryVersion"),
  );
}
const protector: DataProtector = {
  async protect(binding, plaintext): Promise<ProtectedValueRef> {
    const reference = await inlineProtector.protect(
      normalizedProtectionBinding(binding),
      plaintext,
    );
    const ciphertextRef = `pactmark:durable-ref:${d(reference)}`;
    await database.query(
      `INSERT INTO pactmark_test_protected_payloads
       (scenario_id,ciphertext_ref,reference_json) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (scenario_id,ciphertext_ref) DO NOTHING`,
      [scenarioId, ciphertextRef, JSON.stringify(reference)],
    );
    return ProtectedValueRefSchema.parse({ ...reference, ciphertextRef });
  },
  async unprotect(binding, referenceInput): Promise<Uint8Array> {
    const reference = ProtectedValueRefSchema.parse(referenceInput);
    const stored = await database.query<{ reference_json: unknown }>(
      `SELECT reference_json FROM pactmark_test_protected_payloads
       WHERE scenario_id=$1 AND ciphertext_ref=$2`,
      [scenarioId, reference.ciphertextRef],
    );
    const original = ProtectedValueRefSchema.parse(stored.rows[0]?.reference_json);
    if (
      original.keyId !== reference.keyId ||
      original.ciphertextDigest !== reference.ciphertextDigest ||
      original.aadDigest !== reference.aadDigest ||
      original.protectorId !== reference.protectorId ||
      original.algorithm !== reference.algorithm
    )
      throw new Error("KAF_DURABLE_PROTECTED_REFERENCE_MISMATCH");
    return inlineProtector.unprotect(normalizedProtectionBinding(binding), original);
  },
};
const suite = createPostgresStoreSuite(database, {
  securityProfile,
  dataProtector: protector,
  now,
  generateLeaseId: () => `lease-${phase.toLowerCase()}-${scenarioId}`,
});

const baseUnitOfWork = suite.runCommandUnitOfWork;
const unitOfWork: RunCommandUnitOfWork = {
  transactionDomain: baseUnitOfWork.transactionDomain,
  atomicCommandAndWakeup: baseUnitOfWork.atomicCommandAndWakeup,
  transactCommand: (scope, command, callback) =>
    baseUnitOfWork.transactCommand(scope, command, callback),
  async transactTransition<T>(
    key: RunTransitionKey,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await baseUnitOfWork.transactTransition(key, callback);
    if (phase === "A" && key.transitionKind === "EffectAcknowledged") {
      emitControl({ type: "ACK_COMMITTED" });
      await new Promise<never>(() => undefined);
    }
    return result;
  },
};

let idSequence = 0;
const ids = {
  generate(kind: string): string {
    idSequence += 1;
    return `${kind}-${phase.toLowerCase()}-${scenarioId}-${String(idSequence)}`;
  },
};
const authorityIssuer = createAuthorityIssuer(`durable-http-${phase.toLowerCase()}`);

function issueAuthority(issuedTenantId: string): AuthorityContext {
  const issuedAt = now();
  return authorityIssuer.issue({
    actor: { type: "service", id: principalId },
    tenant: { id: issuedTenantId },
    authenticatedAt: issuedAt,
    authenticationStrength: "multi_factor",
    decisionRoles: ["operator"],
    requestCorrelationId: `http-${phase.toLowerCase()}-${scenarioId}`,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
  });
}

const effectStrategy: RuntimeExecutableEffectStrategy = {
  kind: "native",
  registrationDigest: writeTool.effectStrategyRegistrationDigest,
  previewRegistrationDigest: writeTool.previewStrategyRegistrationDigest ?? d("missing-preview"),
  preview: () => {
    const material = {
      schemaVersion: "1" as const,
      normalizedTarget: effectTarget,
      operationClass: "durable_fixture_write",
      contentDigest: d("durable-content"),
      reversibility: "irreversible" as const,
      materialConsequence: "Writes one process-external durable receiver record.",
    };
    return Promise.resolve({ ...material, previewDigest: d(material) });
  },
  validateOutput: (value) => value as JsonValue,
  operationKey: (_input, binding) => `durable-operation:${binding.effectKey}`,
  async dispatch(_input, operationKey, context) {
    const acknowledgedAt = now();
    const result = { receiverReceipt: `receipt-${scenarioId}`, accepted: true };
    const receiptDigest = d(result);
    const receiver = await database.query<{ call_count: number }>(
      `INSERT INTO pactmark_test_effect_receiver
       (scenario_id,effect_key,call_count,receipt_digest,acknowledged_at)
       VALUES ($1,$2,1,$3,$4::timestamptz)
       ON CONFLICT (scenario_id) DO UPDATE
       SET call_count=pactmark_test_effect_receiver.call_count+1
       RETURNING call_count`,
      [scenarioId, context.effectKey, receiptDigest, acknowledgedAt],
    );
    if (receiver.rows[0]?.call_count !== 1) throw new Error("KAF_DURABLE_EFFECT_REPEATED");
    const proofMaterial = {
      schemaVersion: "1" as const,
      acknowledgementId: `ack-${scenarioId}`,
      proofKind: "receiver_receipt" as const,
      effectKey: context.effectKey,
      operationKey,
      toolRegistrationDigest: writeTool.toolRegistrationDigest,
      strategyRegistrationDigest: writeTool.effectStrategyRegistrationDigest,
      normalizedTargetDigest: context.normalizedTargetDigest,
      resultSchemaDigest: writeTool.outputSchemaDigest,
      resultDigest: d(result),
      safeReceiptMetadata: { receiver: "durable-fixture", process: phase },
      acknowledgedAt,
    };
    return {
      schemaVersion: "1" as const,
      result,
      acknowledgement: { ...proofMaterial, proofDigest: effectProofDigest(proofMaterial) },
    };
  },
};

const effectStore = {
  getByEffectId: (requestedTenantId: string, runId: string, effectId: string) =>
    suite.effectLedger.getByEffectId(requestedTenantId, runId, effectId),
  getByEffectKey: (requestedTenantId: string, runId: string, effectKey: string) =>
    suite.effectLedger.getByEffectKey(requestedTenantId, runId, effectKey),
  async getAcknowledgedResult(
    record: Parameters<typeof suite.effectLedger.getAcknowledgedResult>[0],
  ) {
    const value = await suite.effectLedger.getAcknowledgedResult(record);
    if (phase === "B" && value !== undefined) emitControl({ type: "PROTECTED_RESULT_LOADED" });
    return value;
  },
};

const effectServices: RuntimeEffectServices = {
  store: effectStore,
  strategies: {
    resolve: (digest) => (digest === writeTool.toolRegistrationDigest ? effectStrategy : undefined),
  },
  authorization: {
    resolve(request) {
      const createdAt = now();
      return Promise.resolve({
        schemaVersion: "1",
        authorizationReservationId: `authorization-${scenarioId}`,
        authorizationKey: request.authorizationKey,
        tenantId: request.workOrder.tenant.id,
        runId: request.projection.runId,
        stepId: request.stepId,
        toolCallId: request.toolCallId,
        effectKey: request.effectKey,
        workOrderBindingDigest: request.workOrder.workOrderBindingDigest,
        executionDefinition: request.workOrder.executionDefinition,
        executionDefinitionDigest: request.workOrder.executionDefinitionDigest,
        toolId: request.registration.id,
        toolVersion: request.registration.implementationVersion,
        toolRegistrationDigest: request.registration.toolRegistrationDigest,
        policyRegistrationDigest: request.policyRegistrationDigest,
        argumentsDigest: request.argumentsDigest,
        normalizedTargetDigest: request.normalizedTargetDigest,
        grantId: `grant-${scenarioId}`,
        secretRefIds: [],
        purposeCode: request.workOrder.purpose.code,
        purposeRegistryVersion: request.workOrder.purpose.registryVersion,
        state: "reserved",
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 60_000).toISOString(),
      });
    },
  },
};

const evidenceBuilder: EvidenceBuilder = {
  async build(input) {
    const workOrder = await suite.acceptedWorkOrderStore.get(
      input.run.tenantId,
      input.run.workOrderId,
    );
    if (workOrder === undefined || workOrder.kind !== "agent")
      throw new Error("KAF_DURABLE_WORK_ORDER_MISSING");
    const createdAt = now();
    const verifierReferences = input.verifications.map(verificationResultIdentity);
    const record = buildEvidenceRecord({
      material: {
        schemaVersion: "1",
        evidenceRecordId: `evidence-${input.run.runId}`,
        tenantId: input.run.tenantId,
        runId: input.run.runId,
        executionDefinition: input.run.executionDefinition,
        executionDefinitionDigest: input.run.executionDefinitionDigest,
        workOrderBindingDigest: input.run.workOrderBindingDigest,
        claim: {
          statement: "One acknowledged governed effect resumed across fresh Node processes.",
          claimType: "durable_resume",
          scope: "this exact run",
        },
        supports: ["The artifact passed its registered deterministic verifier."],
        doesNotProve: ["External SaaS behavior or exactly-once delivery."],
        context: {
          roleFamily: workOrder.context.roleFamily,
          workflowId: workOrder.context.workflowId,
          riskClass: workOrder.context.riskClass,
          purposeCode: workOrder.purpose.code,
        },
        workSplit: {
          ai: { kind: "unavailable", reason: "not_collected" },
          human: { kind: "unavailable", reason: "not_collected" },
          description: "The required path uses no live model or human decision.",
        },
        permission: {
          purposeCode: workOrder.purpose.code,
          purposeRegistryVersion: workOrder.purpose.registryVersion,
          visibility: "private",
          dataClass:
            workOrder.dataClass === "highly_restricted" ? "restricted" : workOrder.dataClass,
          retention: { mode: "session" },
        },
        freshness: { observedAt: createdAt, validAt: createdAt },
        observation: {
          firstObservedAt: createdAt,
          lastObservedAt: createdAt,
          count: 1,
          repetitionStatus: "single",
          independentObservationIds: [],
        },
        createdAt,
      },
      artifacts: input.artifacts,
      events: input.events,
      verifications: input.verifications,
      verifierReferences,
    });
    await suite.evidenceRecordStore.putImmutable(record);
    return record;
  },
};

const productionModelServices: RuntimeProductionModelServices = {
  profiles: {
    resolveSecurity: (digest) =>
      digest === modelSecurity.modelSecurityProfileDigest ? modelSecurity : undefined,
    resolveResource: (digest) =>
      digest === modelResource.modelResourceProfileDigest ? modelResource : undefined,
  },
  adapters: {
    resolve: (digest) =>
      digest === modelRegistration.modelAdapterRegistrationDigest
        ? {
            registration: modelRegistration,
            estimateInputTokens: ({ inputBytes }) => inputBytes,
            async *invoke(input) {
              const credential = await input.resolveCredential();
              credential.use((value) => {
                if (value !== "durable-fixture-credential")
                  throw new Error("KAF_DURABLE_MODEL_CREDENTIAL_INVALID");
              });
              const providerInput = input.providerRequest;
              if (
                phase === "B" ||
                (typeof providerInput === "object" &&
                  providerInput !== null &&
                  !Array.isArray(providerInput) &&
                  "toolResult" in providerInput)
              ) {
                yield {
                  type: "final" as const,
                  value: { status: "completed", receiverReceipt: `receipt-${scenarioId}` },
                };
              } else {
                yield {
                  type: "tool_call" as const,
                  value: {
                    toolRegistrationDigest: writeTool.toolRegistrationDigest,
                    input: { scenarioId, value: "one-shot" },
                    targetDigest: effectTargetDigest,
                  },
                };
              }
            },
            trustedUsage: () => ({ inputTokens: 1, outputTokens: 1 }),
          }
        : undefined,
  },
  credentialIssuer: {
    issuerId: "durable-model-issuer@1",
    issue(request) {
      return Promise.resolve(
        ModelCredentialRefSchema.parse({
          ...request.binding,
          credentialKind: "model",
          refId: `model-ref-${request.reservation.reservationId}`,
          issuerId: "durable-model-issuer@1",
          issuedAt: request.reservation.createdAt,
          expiresAt: request.expiresAt,
        }),
      );
    },
  },
  credentialResolver: {
    resolverId: "durable-model-resolver@1",
    resolve: () =>
      Promise.resolve(ResolvedModelCredential.fromAdapter("durable-fixture-credential")),
  },
  reservations: suite.modelCallReservationServices,
  reservationReader: suite.modelCallReservationStore,
};

const kernel = createRuntime({
  authorityIssuer,
  agentRegistry: {
    register: () => Promise.resolve(),
    resolve: (id, version, digest) =>
      Promise.resolve(
        id === definition.id &&
          version === definition.version &&
          digest === definition.agentDefinitionDigest
          ? definition
          : undefined,
      ),
  },
  purposeRegistry: { version: "general@1", has: (code) => code === "service_delivery" },
  acceptedWorkOrderStore: suite.acceptedWorkOrderStore,
  eventStore: suite.eventStore,
  artifactStore: suite.artifactStore,
  contextStore: suite.contextStore,
  contextProtector: protector,
  contextCheckpointTransactionDomain: unitOfWork.transactionDomain,
  leaseStore: suite.leaseStore,
  runCommandUnitOfWork: unitOfWork,
  effectServices,
  effectResultProtector: protector,
  modelDriver: {
    capabilities,
    async *invoke({ input }) {
      await Promise.resolve();
      if (
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        "toolResult" in input
      ) {
        yield {
          type: "final" as const,
          value: { status: "completed", receiverReceipt: `receipt-${scenarioId}` },
        };
      } else {
        yield {
          type: "tool_call" as const,
          value: {
            toolRegistrationDigest: writeTool.toolRegistrationDigest,
            input: { scenarioId, value: "one-shot" },
            targetDigest: effectTargetDigest,
          },
        };
      }
    },
  },
  productionModelServices,
  toolRegistry: {
    resolve: (digest) => (digest === writeTool.toolRegistrationDigest ? writeTool : undefined),
  },
  policyEngine: {
    evaluate: () => Promise.resolve({ decision: "allow_with_grant", reasonCode: "fixture_allow" }),
  },
  toolExecutor: {
    capabilities,
    networkPolicy: "none",
    execute: () => Promise.reject(new Error("KAF_DURABLE_READ_EXECUTOR_UNEXPECTED")),
  },
  verifierRegistry: {
    has: (id) => id === definition.verifierRegistrationDigests[0],
    verify: (_id, artifact): Promise<VerificationResult> => {
      const material = {
        schemaVersion: "1" as const,
        status: "pass" as const,
        verificationId: `verification-${scenarioId}`,
        verifierId: definition.verifierRegistrationDigests[0] ?? d("missing-verifier"),
        verifierVersion: "1.0.0",
        verifierRegistrationDigest:
          definition.verifierRegistrationDigests[0] ?? d("missing-verifier"),
        method: "deterministic" as const,
        artifactDigest: artifact.artifactDigest,
        findings: [],
        rubricVersion: "durable-resume@1",
        rubricDigest: d("durable-rubric"),
        verifiedAt: now(),
      };
      return Promise.resolve({ ...material, verificationDigest: d(material) });
    },
  },
  evidenceBuilder,
  clock: { now, monotonicMilliseconds: () => performance.now() },
  idGenerator: ids,
  leaseHolderId: `process-${phase.toLowerCase()}-${scenarioId}`,
  leaseTtlMs: 2_000,
  eventStreamPollIntervalMs: 10,
});

async function issueEffectGrant(authority: AuthorityContext, runId: string, workOrderId: string) {
  const workOrder = await suite.acceptedWorkOrderStore.get(tenantId, workOrderId);
  if (workOrder === undefined) throw new Error("KAF_DURABLE_WORK_ORDER_MISSING");
  const issuedAt = now();
  const grant: CapabilityGrant = {
    schemaVersion: "1",
    id: `grant-${scenarioId}`,
    issuerId: `durable-grant-issuer-${scenarioId}`,
    principal: workOrder.principal,
    tenant: workOrder.tenant,
    workOrderId,
    workOrderBindingDigest: workOrder.workOrderBindingDigest,
    executionDefinition: workOrder.executionDefinition,
    executionDefinitionDigest: workOrder.executionDefinitionDigest,
    capability: "durable:write",
    action: "write",
    toolId: writeTool.id,
    toolVersion: writeTool.implementationVersion,
    toolRegistrationDigest: writeTool.toolRegistrationDigest,
    normalizedResources: durableWorkOrder.resourceScopeCeiling,
    purpose: workOrder.purpose,
    policyRegistrationDigest: definition.policyRegistrationDigest,
    maximumUses: 1,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
  };
  await unitOfWork.transactTransition(
    {
      schemaVersion: "1",
      tenantId,
      runId,
      transitionKind: "durable_fixture_grant",
      transitionKey: grant.id,
      workOrderBindingDigest: workOrder.workOrderBindingDigest,
      executionDefinitionDigest: workOrder.executionDefinitionDigest,
    },
    async (transaction) => {
      await transaction.issueCapabilityGrant(grant);
      return null;
    },
  );
  void authority;
}

const httpRuntime: HttpRuntimeSurface = {
  async start(authority, agent, request, command) {
    try {
      const started = await kernel.start(authority, agent, request, command);
      await issueEffectGrant(authority, started.runId, started.workOrderId);
      void kernel.execute(authority, started.runId).catch((error: unknown) => {
        process.stderr.write(
          `${JSON.stringify({ type: "EXECUTION_FAILED", errorType: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "unknown", details: error instanceof KafError ? error.details : undefined })}\n`,
        );
      });
      return started;
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ type: "START_FAILED", errorType: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : "unknown", details: error instanceof KafError ? error.details : undefined })}\n`,
      );
      throw error;
    }
  },
  resume: (authority, runId, command, options) => kernel.resume(authority, runId, command, options),
  getRun: (authority, runId) => kernel.getRun(authority, runId),
  async getEvidence(authority, runId) {
    const projection = await kernel.getRun(authority, runId);
    return suite.evidenceRecordStore.get(projection.tenantId, `evidence-${runId}`);
  },
  async getArtifacts(authority, runId) {
    const projection = await kernel.getRun(authority, runId);
    const values = await Promise.all(
      projection.artifactIds.map((artifactId) =>
        suite.artifactStore.get(projection.tenantId, artifactId),
      ),
    );
    return values.filter((value) => value !== undefined);
  },
  events: (authority, runId, options) => kernel.events(authority, runId, options),
  submitInput: (authority, runId, requestId, value, command) =>
    kernel.submitInput(authority, runId, requestId, value, command),
  issueDecisionChallenge: (authority, runId, decisionId, command) =>
    kernel.issueDecisionChallenge(authority, runId, decisionId, command),
  approve: (authority, runId, decision, command) =>
    kernel.approve(authority, runId, decision, command),
  reject: (authority, runId, decision, command) =>
    kernel.reject(authority, runId, decision, command),
  reconcileEffect: (authority, runId, effectId, resolution, command) =>
    kernel.reconcileEffect(authority, runId, effectId, resolution, command),
  requestCompensation: (authority, runId, effectId, request, command) =>
    kernel.requestCompensation(authority, runId, effectId, request, command),
  cancel: (authority, runId, reason, command) =>
    kernel.cancel(
      authority,
      runId,
      typeof reason === "string" ? reason : JSON.stringify(reason),
      command,
    ),
  getCapabilities: () => ({
    ...kernel.getCapabilities(),
    backgroundWakeup: true,
    atomicCommandAndWakeup: true,
  }),
  evaluateReadiness: (input) => kernel.evaluateReadiness(input),
};

const handler = createAgentFetchHandler({
  runtime: httpRuntime,
  authenticate: (request) => {
    const bearer = request.headers.get("authorization");
    const tokenTenant =
      bearer === `Bearer tenant-a-${scenarioId}`
        ? tenantId
        : bearer === `Bearer tenant-b-${scenarioId}`
          ? otherTenantId
          : undefined;
    if (tokenTenant === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      authority: issueAuthority(tokenTenant),
      principal: { type: "service", id: principalId },
      tenant: { id: tokenTenant },
      credentialMode: "bearer",
    });
  },
  authorize: (authentication) =>
    Promise.resolve(
      authentication.principal.id === principalId &&
        (authentication.tenant.id === tenantId || authentication.tenant.id === otherTenantId),
    ),
  resolveAgent: (reference, authentication) =>
    Promise.resolve(
      authentication.tenant.id === tenantId &&
        reference.id === definition.id &&
        reference.version === definition.version
        ? definition
        : undefined,
    ),
});
const server = createPactmarkNodeServer(handler, { capabilities: httpRuntime.getCapabilities() });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (address === null || typeof address === "string") throw new Error("KAF_DURABLE_PORT_INVALID");
emitControl({ type: "READY", phase, port: address.port, scenarioId });

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await closeNodeServer(server);
  await database.end?.();
}
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
