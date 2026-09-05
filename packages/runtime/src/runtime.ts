import {
  AcceptedAgentWorkOrderSchema,
  AcceptedCompensationWorkOrderSchema,
  ActiveExecutionReservationSchema,
  AgentDefinitionSchema,
  CompensationRunDefinitionSchema,
  ArtifactSchema,
  CommandRecordSchema,
  CommandContextSchema,
  ContextSnapshotSchema,
  DecisionApprovalSubmissionSchema,
  DecisionGateSchema,
  DecisionPreviewReferenceSchema,
  DecisionRejectionSchema,
  DecisionRejectionSubmissionSchema,
  DecisionSubmissionChallengeSchema,
  EffectRecordSchema,
  EvidenceRecordSchema,
  ProtectedEffectResultRecordSchema,
  EffectReconciliationResolutionSchema,
  ApprovalSchema,
  createRunProjection,
  canonicalJsonStringify,
  digestBytes,
  digestCanonicalJson,
  JsonValueSchema,
  InputSubmissionRecordSchema,
  KafError,
  ModelCallBindingSchema,
  ModelCallReservationSchema,
  ModelCredentialIssueRequestSchema,
  ModelCredentialRefSchema,
  reduceRunEvent,
  RunEventSchema,
  RuntimeCapabilitiesSchema,
  RuntimeReadinessProfileSchema,
  RuntimeReadinessReportSchema,
  TerminalRunStatusSchema,
  ToolRegistrationContractSchema,
  TypedInputValidationResultSchema,
  VerificationResultSchema,
  validateCommandIdWindow,
  WorkOrderRequestSchema,
  protectedEffectResultAad,
  type AcceptedAgentWorkOrder,
  type AcceptedCompensationWorkOrder,
  type AcceptedWorkOrder,
  type AcceptedWorkOrderStore,
  type ActiveExecutionReservation,
  type AgentDefinition,
  type AgentRegistry,
  type Approval,
  type AdmissionController,
  type Artifact,
  type ArtifactStore,
  type AuthorityContext,
  type AuthorityIssuer,
  type Clock,
  type CommandContext,
  type CommandRecord,
  type CommandScope,
  type ContextSnapshot,
  type ContextStore,
  type DataProtector,
  type DecisionApprovalSubmission,
  type DecisionChallengeIssuer,
  type DecisionGate,
  type DecisionPreviewer,
  type DecisionRejectionSubmission,
  type DecisionStore,
  type EvidenceBuilder,
  type EvidenceRecord,
  type Digest,
  type EffectAcknowledgement,
  type EffectRecord,
  type EffectReconciliationResolution,
  type ProtectedEffectResultRecord,
  type EventStore,
  type IdGenerator,
  type InputSubmissionStore,
  type JsonValue,
  type KafErrorCode,
  type ModelCallReservation,
  type ModelDriver,
  type PolicyEngine,
  type PurposeRegistry,
  type Run,
  type RunEvent,
  type RunLease,
  type RunLeaseStore,
  type RunProjection,
  type RuntimeCapabilities,
  type RuntimeReadinessProfile,
  type RuntimeReadinessReport,
  type RunCommandTransaction,
  type RunCommandUnitOfWork,
  type ToolExecutor,
  type ToolCallResolver,
  type ToolRegistrationContract,
  type TypedInputRegistry,
  type VerificationResult,
  type VerifierRegistry,
  type WakeupScheduler,
  type WorkOrderRequest,
} from "@pactmark/core";
import { z } from "zod";

import { RuntimeModelEmissionSchema, type RuntimeModelEmission } from "./protocol.js";
import {
  createModelCallReservationId,
  validateModelCallContext,
  type RuntimeModelCallSettlement,
  type RuntimeProductionModelServices,
  type RuntimeSealedModelAdapter,
} from "./models.js";
import { evaluateHostToolCall, resolveHostToolCall } from "./tool-authority.js";
import {
  assertEffectRecordBinding,
  createEffectKey,
  markAuthorizationReservationConsumed,
  validateAuthorizationReservation,
  validateEffectExecution,
  validateEffectLookupResult,
  validateEffectPreview,
  type RuntimeEffectDispatchContext,
  type RuntimeEffectServices,
  RuntimeCompensationRequestSchema,
  type RuntimeCompensationServices,
} from "./effects.js";

export interface RuntimeToolRegistry {
  resolve(toolRegistrationDigest: string): ToolRegistrationContract | undefined;
}

export interface RuntimeRegistrationKillSwitches {
  isKilled(
    targetKind:
      | "tool_registration"
      | "model_adapter"
      | "model_profile"
      | "policy_registration"
      | "compensation_definition"
      | "compensation_strategy",
    targetDigest: Digest,
  ): boolean;
}

export type RuntimeBoundaryErrorClassification =
  "aborted" | "timed_out" | "retryable" | "non_retryable" | "uncertain";

const RuntimeBoundaryErrorClassificationSchema = z.enum([
  "aborted",
  "timed_out",
  "retryable",
  "non_retryable",
  "uncertain",
]);

export interface RuntimeRetryPolicy {
  maximumAttempts(input: Readonly<{ boundary: "model" | "tool" }>): number;
  backoffMilliseconds(
    input: Readonly<{
      boundary: "model" | "tool";
      attempt: number;
      classification: "timed_out" | "retryable" | "uncertain";
      jitter: number;
    }>,
  ): number;
}

export interface RuntimeJitterSource {
  next(): number;
}

export interface RuntimeActiveExecutionReservationReader {
  get(
    tenantId: string,
    runId: string,
    stepId: string,
    boundary: ActiveExecutionReservation["boundary"],
    boundaryKey: string,
  ): Promise<ActiveExecutionReservation | undefined>;
}

export interface RuntimeActiveExecutionServices {
  readonly transactionDomain: string;
  readonly durable: boolean;
  readonly reader: RuntimeActiveExecutionReservationReader;
  maximumChargeMilliseconds(
    input: Readonly<{
      boundary: ActiveExecutionReservation["boundary"];
      workOrder: AcceptedWorkOrder;
    }>,
  ): number;
}

export interface RuntimeKernelConfig {
  readonly authorityIssuer: AuthorityIssuer;
  readonly agentRegistry: AgentRegistry;
  readonly purposeRegistry: PurposeRegistry;
  readonly acceptedWorkOrderStore: AcceptedWorkOrderStore;
  readonly inputSubmissionStore?: InputSubmissionStore;
  readonly inputProtector?: DataProtector;
  readonly typedInputRegistry?: TypedInputRegistry;
  readonly decisionStore?: DecisionStore;
  readonly decisionChallengeIssuer?: DecisionChallengeIssuer;
  readonly decisionPreviewer?: DecisionPreviewer;
  readonly effectServices?: RuntimeEffectServices;
  /** Protects acknowledged effect results before their atomic ledger commit. */
  readonly effectResultProtector?: DataProtector;
  readonly compensationServices?: RuntimeCompensationServices;
  readonly eventStore: EventStore;
  readonly artifactStore: ArtifactStore;
  readonly contextStore?: ContextStore;
  readonly contextProtector?: DataProtector;
  readonly contextCheckpointTransactionDomain?: string;
  readonly leaseStore: RunLeaseStore;
  /** Durable command replay and fenced transition boundary. */
  readonly runCommandUnitOfWork: RunCommandUnitOfWork;
  readonly admissionController?: AdmissionController;
  readonly admissionLeaseDurationMs?: number;
  readonly retryPolicy?: RuntimeRetryPolicy;
  readonly retryJitterSource?: RuntimeJitterSource;
  readonly activeExecutionServices?: RuntimeActiveExecutionServices;
  readonly modelDriver: ModelDriver;
  /** Required for durable/production model calls; local ambient preview uses modelDriver directly. */
  readonly productionModelServices?: RuntimeProductionModelServices;
  readonly requireProductionModelBoundary?: boolean;
  readonly toolRegistry: RuntimeToolRegistry;
  readonly toolCallResolver: ToolCallResolver;
  readonly policyEngine: PolicyEngine;
  /** Rechecked immediately before model and compensation registration use. */
  readonly killSwitches?: RuntimeRegistrationKillSwitches;
  readonly toolExecutor: ToolExecutor;
  readonly verifierRegistry: VerifierRegistry;
  readonly evidenceBuilder: EvidenceBuilder;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly wakeupScheduler?: WakeupScheduler;
  readonly leaseHolderId: string;
  readonly leaseTtlMs?: number;
  readonly commandIdempotencyHorizonMs?: number;
  readonly commandMaximumFutureSkewMs?: number;
  readonly eventStreamPollIntervalMs?: number;
  readonly decisionChallengeTtlMs?: number;
  readonly approvalTtlMs?: number;
  readonly freshAuthenticationMaximumAgeMs?: number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const RUNTIME_CONTEXT_SCHEMA_DIGEST = digestCanonicalJson({
  id: "pactmark.runtime-context-checkpoint",
  version: "2",
});

const RuntimeContextCheckpointSchema = z
  .object({
    schemaVersion: z.literal("1"),
    phase: z.enum([
      "turn",
      "model",
      "model_inflight",
      "emission",
      "tool_request",
      "tool",
      "final",
      "verification",
      "input",
      "scheduled_backoff",
    ]),
    modelInput: JsonValueSchema.optional(),
    stepId: z.string().min(1).optional(),
    attempt: z.number().int().positive().optional(),
    emission: RuntimeModelEmissionSchema.optional(),
    toolCallId: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
    inputSchemaDigest: z.string().startsWith("sha256:").optional(),
    retryBoundary: z.enum(["model", "tool"]).optional(),
    retryClassification: z.enum(["timed_out", "retryable", "uncertain"]).optional(),
    nextAttempt: z.number().int().positive().optional(),
    notBefore: z.iso.datetime({ offset: true }).optional(),
    delayMs: z.number().int().nonnegative().optional(),
    resumePhase: z.enum(["model", "tool"]).optional(),
    artifact: ArtifactSchema.optional(),
    verificationStarted: z.boolean().default(false),
    verifications: z.array(VerificationResultSchema).default([]),
  })
  .strict();
type RuntimeContextCheckpoint = z.input<typeof RuntimeContextCheckpointSchema>;
type ParsedRuntimeContextCheckpoint = z.output<typeof RuntimeContextCheckpointSchema>;

export type RuntimeExecutionResult = Readonly<{
  runId: string;
  status: "completed" | "parked" | "failed" | "cancelled";
}>;

type VerifiedAuthority =
  ReturnType<AuthorityIssuer["verify"]> extends infer Result
    ? Result extends { valid: true; claims: infer Claims }
      ? Claims
      : never
    : never;

type LeaseSession = { current: RunLease };

const DELEGATED_WORKER_RUN_OPERATIONS = new Set(["run.execute", "run.get", "run.events"]);

const TERMINAL_RUN_ERROR_CODES = new Set<KafErrorCode>([
  "KAF_RUNTIME_CAPABILITY_MISSING",
  "KAF_RUNTIME_TERMINAL",
  "KAF_POLICY_DENIED",
  "KAF_EFFECT_ABANDONED_UNCERTAIN",
  "KAF_MODEL_RESOURCE_LIMIT_EXCEEDED",
  "KAF_TOOL_EXECUTION_FAILED",
  "KAF_VERIFICATION_REQUIRED",
  "KAF_EVIDENCE_INVALID_REFERENCE",
]);

const TERMINAL_MODEL_ADAPTER_REASONS = new Set([
  "model_emission_schema_invalid",
  "model_call_failed_without_safe_result",
]);

const TERMINAL_EFFECT_AUTHORIZATION_REASONS = new Set([
  "effect_approval_required",
  "effect_authorization_reservation_mismatch",
  "effect_operation_key_empty",
  "effect_preview_binding_or_determinism_failed",
  "effect_secret_ref_claim_port_unavailable",
]);

class RuntimeBoundaryInvocationError extends Error {
  readonly boundaryError: unknown;

  constructor(boundaryError: unknown) {
    super(
      boundaryError instanceof Error ? boundaryError.message : "Runtime boundary invocation failed",
    );
    this.name = "RuntimeBoundaryInvocationError";
    this.boundaryError = boundaryError;
  }
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("Operation aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      globalThis.clearTimeout(timeout);
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function tenantRunKey(tenantId: string, runId: string): string {
  return canonicalJsonStringify([tenantId, runId]);
}

function tenantRunStepKey(tenantId: string, runId: string, stepId: string): string {
  return canonicalJsonStringify([tenantId, runId, stepId]);
}

export class AgentRuntime {
  readonly #config: RuntimeKernelConfig;
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #uncertainLocalModelCalls = new Set<string>();

  constructor(config: RuntimeKernelConfig) {
    for (const [name, value] of [
      ["decisionChallengeTtlMs", config.decisionChallengeTtlMs],
      ["approvalTtlMs", config.approvalTtlMs],
      ["freshAuthenticationMaximumAgeMs", config.freshAuthenticationMaximumAgeMs],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new KafError("KAF_SCHEMA_INVALID", {
          details: { path: name, issue: "positive_safe_integer_required" },
        });
      }
    }
    if (
      config.wakeupScheduler?.capabilities.backgroundWakeup === true &&
      !config.runCommandUnitOfWork.atomicCommandAndWakeup
    ) {
      throw new KafError("KAF_RUNTIME_NOT_READY", {
        details: { reason: "durable_wakeup_requires_atomic_command_unit_of_work" },
      });
    }
    this.#config = config;
  }

  getCapabilities(): RuntimeCapabilities {
    const eventCapabilities = this.#config.eventStore.capabilities;
    const workOrderCapabilities = this.#config.acceptedWorkOrderStore.capabilities;
    const artifactCapabilities = this.#config.artifactStore.capabilities;
    const modelCapabilities = this.#config.modelDriver.capabilities;
    const executorCapabilities = this.#config.toolExecutor.capabilities;
    const schedulerCapabilities = this.#config.wakeupScheduler?.capabilities;
    return RuntimeCapabilitiesSchema.parse({
      schemaVersion: "1",
      executionProfile: this.#leastDurableProfile([
        eventCapabilities.executionProfile,
        workOrderCapabilities.executionProfile,
        artifactCapabilities.executionProfile,
      ]),
      durableStorage:
        eventCapabilities.durableStorage &&
        workOrderCapabilities.durableStorage &&
        artifactCapabilities.durableStorage,
      protectedContext: this.#contextCheckpointEnabled(),
      protectedWorkOrders: workOrderCapabilities.protectedWorkOrders,
      protectedInputSubmissions:
        this.#config.inputSubmissionStore?.capabilities.protectedInputSubmissions === true &&
        this.#config.inputProtector !== undefined,
      streaming: eventCapabilities.streaming,
      cancellation: modelCapabilities.cancellation && executorCapabilities.cancellation,
      sandbox: executorCapabilities.sandbox,
      networkPolicy: this.#config.toolExecutor.networkPolicy,
      backgroundWakeup: schedulerCapabilities?.backgroundWakeup ?? false,
      atomicCommandAndWakeup:
        this.#config.runCommandUnitOfWork.atomicCommandAndWakeup &&
        (schedulerCapabilities?.atomicCommandAndWakeup ?? false),
      humanDecisions:
        this.#config.decisionStore !== undefined &&
        this.#config.decisionChallengeIssuer !== undefined &&
        this.#config.decisionPreviewer !== undefined,
      typedInput:
        this.#config.inputSubmissionStore !== undefined &&
        this.#config.inputProtector !== undefined &&
        this.#config.typedInputRegistry !== undefined,
      effectReconciliation: this.#config.effectServices !== undefined,
      compensation:
        this.#config.effectServices !== undefined &&
        this.#config.compensationServices !== undefined &&
        this.#config.compensationServices.transactionDomain ===
          this.#config.runCommandUnitOfWork.transactionDomain,
      modelCredentials: this.#productionModelBoundaryReady(),
      toolCredentials: false,
      telemetry: "none",
      transactionDomains: [this.#config.runCommandUnitOfWork.transactionDomain],
    });
  }

  evaluateReadiness(input: Readonly<{ profile: RuntimeReadinessProfile }>): RuntimeReadinessReport {
    const profile = RuntimeReadinessProfileSchema.parse(input.profile);
    const capabilities = this.getCapabilities();
    const checks: RuntimeReadinessReport["checks"] = [
      {
        schemaVersion: "1",
        id: "runtime-kernel",
        status: "pass",
        code: "KAF_RUNTIME_NOT_READY",
        safeMessage: "The portable runtime kernel is configured.",
        remediationSlug: "configure-runtime-kernel",
      },
    ];
    if (this.#config.compensationServices !== undefined) {
      checks.push(
        this.#readinessCheck(
          "compensation-transaction-domain",
          capabilities.compensation,
          "Compensation intent and run creation require the command transaction domain.",
          "configure-compensation-transaction-domain",
        ),
      );
    }
    if (this.#config.effectServices !== undefined) {
      checks.push(
        this.#readinessCheck(
          "protected-effect-results",
          this.#config.effectResultProtector !== undefined,
          "Governed effects require protected acknowledged-result persistence.",
          "configure-protected-effect-results",
        ),
      );
    }
    if (profile === "production") {
      checks.push(
        this.#readinessCheck(
          "durable-storage",
          capabilities.durableStorage,
          "Production requires durable event, WorkOrder, and artifact storage.",
          "configure-durable-storage",
        ),
        this.#readinessCheck(
          "protected-context",
          capabilities.protectedContext,
          "Production requires protected context checkpoints in the command transaction domain.",
          "configure-protected-context",
        ),
        this.#readinessCheck(
          "protected-work-orders",
          capabilities.protectedWorkOrders,
          "Production requires protected accepted WorkOrders.",
          "protect-accepted-work-orders",
        ),
        this.#readinessCheck(
          "protected-input-submissions",
          capabilities.protectedInputSubmissions,
          "Production typed input requires a protected submission store.",
          "configure-protected-input-store",
        ),
        this.#readinessCheck(
          "model-call-reservations",
          capabilities.modelCredentials,
          "Production model calls require bound reservations and credential references.",
          "configure-model-call-reservations",
        ),
        this.#readinessCheck(
          "admission-controller",
          this.#config.admissionController !== undefined,
          "Production requires an explicit admission policy before atomic quota reservation.",
          "configure-admission-controller",
        ),
        this.#readinessCheck(
          "active-execution-reservations",
          this.#activeExecutionBoundaryReady(),
          "Production requires durable active-execution reservations in the command transaction domain.",
          "configure-active-execution-reservations",
        ),
      );
    }
    return RuntimeReadinessReportSchema.parse({
      schemaVersion: "1",
      ready: checks.every((check) => check.status !== "fail"),
      profile,
      capabilities,
      checks,
      evaluatedAt: this.#config.clock.now(),
      rulesVersion: "pactmark.runtime-readiness@1",
    });
  }

  #productionModelBoundaryReady(): boolean {
    const services = this.#config.productionModelServices;
    return (
      services !== undefined &&
      services.reservations.durable &&
      services.reservations.transactionDomain ===
        this.#config.runCommandUnitOfWork.transactionDomain
    );
  }

  #activeExecutionBoundaryReady(): boolean {
    const services = this.#config.activeExecutionServices;
    return (
      services !== undefined &&
      services.durable &&
      services.transactionDomain === this.#config.runCommandUnitOfWork.transactionDomain
    );
  }

  #requiresProductionModelBoundary(): boolean {
    return (
      this.#config.requireProductionModelBoundary === true ||
      this.#config.acceptedWorkOrderStore.capabilities.durableStorage ||
      this.#config.eventStore.capabilities.durableStorage ||
      this.#config.artifactStore.capabilities.durableStorage
    );
  }

  async start(
    authority: AuthorityContext,
    definitionInput: AgentDefinition,
    requestInput: WorkOrderRequest,
    commandInput: CommandContext,
  ): Promise<Readonly<{ runId: string; workOrderId: string }>> {
    const claims = this.#verifyAuthority(authority, {
      kind: "unscoped_only",
      operation: "run.start",
    });
    const request = WorkOrderRequestSchema.parse(requestInput);
    const definition = AgentDefinitionSchema.parse(definitionInput);
    const command = CommandContextSchema.parse(commandInput);
    this.#assertCommand(command, "run.start", request);
    this.#assertCommandWindow(command);
    if (request.agent.id !== definition.id || request.agent.version !== definition.version) {
      throw new KafError("KAF_RUNTIME_AGENT_DEFINITION_MISMATCH");
    }
    if (!this.#config.purposeRegistry.has(request.purpose.code)) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "unknown_purpose" },
      });
    }
    const admissionRequest = {
      schemaVersion: "1" as const,
      tenant: claims.tenant,
      principal: claims.actor,
      commandId: command.commandId,
      category: "request_start" as const,
      resourceKey: `agent:${definition.agentDefinitionDigest}`,
      amount: 1,
      leaseDurationMs: this.#config.admissionLeaseDurationMs ?? 60_000,
    };

    const transactionResult = await this.#config.runCommandUnitOfWork.transactCommand(
      this.#commandScope(claims, command),
      command,
      async (transaction) => {
        const registered = await this.#config.agentRegistry.resolve(
          definition.id,
          definition.version,
          definition.agentDefinitionDigest,
        );
        if (registered === undefined) throw new KafError("KAF_RUNTIME_AGENT_DEFINITION_MISMATCH");
        const admission = await this.#config.admissionController?.evaluate(admissionRequest);
        if (admission !== undefined && !admission.admitted) {
          throw new KafError("KAF_ADMISSION_DENIED", {
            details: { retryAfterSeconds: admission.retryAfterSeconds },
          });
        }
        if (admission?.admitted === true) {
          this.#assertExactBinding(
            {
              tenant: admission.reservation.tenant,
              principal: admission.reservation.principal,
              commandId: admission.reservation.commandId,
              category: admission.reservation.category,
              resourceKey: admission.reservation.resourceKey,
              amount: admission.reservation.amount,
            },
            {
              tenant: admissionRequest.tenant,
              principal: admissionRequest.principal,
              commandId: admissionRequest.commandId,
              category: admissionRequest.category,
              resourceKey: admissionRequest.resourceKey,
              amount: admissionRequest.amount,
            },
            "admission_controller_binding_changed",
          );
        }
        await transaction.reserveAdmission(admissionRequest);
        const runId = this.#config.idGenerator.generate("run");
        const workOrderId = this.#config.idGenerator.generate("work_order");
        const createdAt = this.#config.clock.now();
        const executionDefinition = {
          kind: "agent" as const,
          id: definition.id,
          version: definition.version,
          agentDefinitionDigest: definition.agentDefinitionDigest,
        };
        const executionDefinitionDigest = digestCanonicalJson(executionDefinition);
        const acceptedMaterial = {
          schemaVersion: "1" as const,
          id: workOrderId,
          createdAt,
          goal: request.goal,
          input: request.input,
          context: request.context,
          workMode: request.workMode,
          autonomyMode: request.autonomyMode,
          decisionOwner:
            request.decisionOwner.mode === "requesting_principal"
              ? { mode: "principal" as const, principal: claims.actor }
              : { mode: "registered_role" as const, role: request.decisionOwner.role },
          purpose: request.purpose,
          dataClass: request.dataClass,
          retention: request.retention,
          principal: claims.actor,
          tenant: claims.tenant,
          requestedCapabilities: request.requestedCapabilities,
          resourceScopeCeiling: request.resourceScopeCeiling,
          budget: request.budget,
          ...(request.workflowContext === undefined
            ? {}
            : { workflowContext: request.workflowContext }),
          correlationId: command.commandId,
          ...(request.deadline === undefined ? {} : { deadline: request.deadline }),
          ...(request.region === undefined ? {} : { region: request.region }),
          ...(request.jurisdiction === undefined ? {} : { jurisdiction: request.jurisdiction }),
          kind: "agent" as const,
          executionDefinition,
          executionDefinitionDigest,
          modelSecurityProfileDigest: definition.modelSecurityProfileDigest,
          modelResourceProfileDigest: definition.modelResourceProfileDigest,
          modelAdapterRegistrationDigest: definition.modelAdapterRegistrationDigest,
        };
        const workOrder = AcceptedAgentWorkOrderSchema.parse({
          ...acceptedMaterial,
          workOrderBindingDigest: digestCanonicalJson(acceptedMaterial),
        });
        const acceptedEvent = this.#event(workOrder, runId, 1, "RunAccepted", {
          workOrderId,
          workOrderBindingDigest: workOrder.workOrderBindingDigest,
          requiredVerifierIds: definition.verifierRegistrationDigests,
        });
        const initialRun: Run = {
          schemaVersion: "1",
          runId,
          tenantId: claims.tenant.id,
          workOrderId,
          workOrderBindingDigest: workOrder.workOrderBindingDigest,
          executionDefinition,
          executionDefinitionDigest,
          status: "created",
          createdAt: acceptedEvent.occurredAt,
          updatedAt: acceptedEvent.occurredAt,
          dataClass: workOrder.dataClass,
          correlationId: command.commandId,
        };
        const projection = reduceRunEvent(createRunProjection(initialRun), acceptedEvent);
        const value = { runId, workOrderId };
        await transaction.putAcceptedWorkOrder(workOrder);
        await transaction.appendRunEvent(acceptedEvent);
        await transaction.putRunProjection(projection);
        await this.#recordCommand(transaction, claims, command, value);
        if (
          this.#config.wakeupScheduler?.capabilities.backgroundWakeup === true &&
          this.#config.runCommandUnitOfWork.atomicCommandAndWakeup
        ) {
          await transaction.enqueueWakeup({
            schemaVersion: "1",
            tenantId: claims.tenant.id,
            runId,
            reason: "run_accepted",
            notBefore: createdAt,
            deduplicationKey: command.commandId,
            payload: {},
          });
        }
        return value;
      },
    );
    const value = transactionResult.value;
    if (
      !transactionResult.replayed &&
      this.#config.wakeupScheduler !== undefined &&
      !this.#config.wakeupScheduler.capabilities.backgroundWakeup
    ) {
      await this.#config.wakeupScheduler.schedule({
        schemaVersion: "1",
        tenantId: claims.tenant.id,
        runId: value.runId,
        reason: "run_accepted",
        scheduledAt: this.#config.clock.now(),
        deduplicationKey: command.commandId,
      });
    }
    return value;
  }

  async submitInput(
    authority: AuthorityContext,
    runId: string,
    requestId: string,
    valueInput: JsonValue,
    commandInput: CommandContext,
  ): Promise<
    Readonly<{ inputSubmissionRecordId: string; runId: string; automaticResume: boolean }>
  > {
    const claims = this.#verifyAuthority(authority, {
      kind: "run",
      operation: "run.submit_input",
      runId,
    });
    await this.#assertAuthorityStoredRunScope(claims, runId);
    const command = CommandContextSchema.parse(commandInput);
    this.#assertCommand(command, "run.submit_input", valueInput);
    this.#assertCommandResourceScope(command, [runId, requestId]);
    this.#assertCommandWindow(command);
    const store = this.#config.inputSubmissionStore;
    const protector = this.#config.inputProtector;
    const registry = this.#config.typedInputRegistry;
    if (store === undefined || protector === undefined || registry === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { requiredCapability: "typedInput" },
      });
    }
    const result = await this.#config.runCommandUnitOfWork.transactCommand(
      this.#commandScope(claims, command),
      command,
      async (transaction) => {
        const existing = await store.get(claims.tenant.id, runId, requestId);
        if (existing !== undefined) {
          const validatedExisting = TypedInputValidationResultSchema.parse(
            registry.validate(existing.inputSchemaDigest, valueInput),
          );
          this.#assertExactBinding(
            {
              valueDigest: existing.valueDigest,
              submittingPrincipalId: existing.submittingPrincipalId,
            },
            {
              valueDigest: digestCanonicalJson(validatedExisting.value),
              submittingPrincipalId: claims.actor.id,
            },
            "input_submission_changed",
            "KAF_HTTP_IDEMPOTENCY_CONFLICT",
          );
          const result = {
            inputSubmissionRecordId: existing.inputSubmissionRecordId,
            runId,
            automaticResume: false,
          };
          await this.#recordCommand(transaction, claims, command, result);
          return result;
        }
        const projection = await this.getRun(authority, runId);
        if (
          projection.status !== "waiting_for_input" ||
          projection.waitingRequestId !== requestId
        ) {
          throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
            details: { reason: "run_not_waiting_for_exact_input" },
          });
        }
        const workOrder = await this.#loadWorkOrder(claims.tenant.id, projection.workOrderId);
        if (workOrder.dataClass === "highly_restricted") {
          throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
            details: { reason: "highly_restricted_input_forbidden" },
          });
        }
        const requestingEvent = await this.#findEvent(
          claims.tenant.id,
          runId,
          projection.lastEventId,
        );
        if (requestingEvent?.eventType !== "InputRequested") {
          throw new KafError("KAF_RUNTIME_EVENT_BINDING");
        }
        const validated = TypedInputValidationResultSchema.parse(
          registry.validate(requestingEvent.payload.inputSchemaDigest, valueInput),
        );
        if (validated.inputSchemaDigest !== requestingEvent.payload.inputSchemaDigest) {
          throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
            details: { reason: "input_schema_changed" },
          });
        }
        const valueDigest = digestCanonicalJson(validated.value);
        const recordId = this.#config.idGenerator.generate("input_submission");
        const binding = {
          tenantId: claims.tenant.id,
          runId,
          requestId,
          recordId,
          workOrderBindingDigest: workOrder.workOrderBindingDigest,
          inputSchemaDigest: validated.inputSchemaDigest,
          valueDigest,
          commandId: command.commandId,
        };
        const protectedValue = await protector.protect(
          binding,
          new TextEncoder().encode(canonicalJsonStringify(validated.value)),
        );
        if (protectedValue.aadDigest !== digestCanonicalJson(binding)) {
          throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
            details: { reason: "input_protector_aad_mismatch" },
          });
        }
        const record = {
          schemaVersion: "1" as const,
          inputSubmissionRecordId: recordId,
          tenantId: claims.tenant.id,
          runId,
          requestId,
          requestingStepId: requestingEvent.payload.stepId,
          requestingEventId: requestingEvent.eventId,
          executionDefinition: workOrder.executionDefinition,
          executionDefinitionDigest: workOrder.executionDefinitionDigest,
          workOrderBindingDigest: workOrder.workOrderBindingDigest,
          inputSchemaDigest: validated.inputSchemaDigest,
          valueDigest,
          protectedValue,
          submittingPrincipalId: claims.actor.id,
          purposeCode: workOrder.purpose.code,
          purposeRegistryVersion: workOrder.purpose.registryVersion,
          dataClass: workOrder.dataClass,
          retention:
            workOrder.retention.mode === "host_policy"
              ? { mode: "policy" as const, policyId: workOrder.retention.policyId }
              : workOrder.retention,
          consumingCommandId: command.commandId,
          createdAt: this.#config.clock.now(),
        };
        const event = this.#event(workOrder, runId, projection.lastSequence + 1, "InputSubmitted", {
          stepId: requestingEvent.payload.stepId,
          requestId,
          inputSubmissionRecordId: recordId,
          inputSchemaDigest: validated.inputSchemaDigest,
          valueDigest,
        });
        const next = reduceRunEvent(projection, event);
        const automaticResume = this.#canCommitAutomaticWakeup();
        const response = { inputSubmissionRecordId: recordId, runId, automaticResume };
        await transaction.putInputSubmission(record);
        await transaction.appendRunEvent(event);
        await transaction.putRunProjection(next);
        await this.#recordCommand(transaction, claims, command, response);
        if (automaticResume)
          await this.#enqueueCommandWakeup(
            transaction,
            claims.tenant.id,
            runId,
            command,
            "input_submitted",
          );
        return response;
      },
    );
    return result.value;
  }

  async issueDecisionChallenge(
    authority: AuthorityContext,
    runId: string,
    decisionId: string,
    commandInput: CommandContext,
  ): Promise<Readonly<{ challengeProof: string; expiresAt: string }>> {
    const claims = this.#verifyAuthority(authority, {
      kind: "run",
      operation: "run.issue_decision_challenge",
      runId,
    });
    const command = CommandContextSchema.parse(commandInput);
    this.#assertCommand(command, "run.issue_decision_challenge", {});
    this.#assertCommandResourceScope(command, [runId, decisionId]);
    this.#assertCommandWindow(command);
    const store = this.#config.decisionStore;
    const issuer = this.#config.decisionChallengeIssuer;
    if (store === undefined || issuer === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { requiredCapability: "humanDecisions" },
      });
    }
    const expiresAt = new Date(
      Date.parse(this.#config.clock.now()) + (this.#config.decisionChallengeTtlMs ?? 300_000),
    ).toISOString();
    const projectionBefore = await this.getRun(authority, runId);
    if (
      projectionBefore.status !== "waiting_for_approval" ||
      projectionBefore.waitingDecisionId !== decisionId
    ) {
      throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
        details: { reason: "run_not_waiting_for_exact_decision" },
      });
    }
    const gateBefore = await store.getGate(claims.tenant.id, runId, decisionId);
    if (gateBefore === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    this.#assertDecisionGateAuthority(gateBefore, claims, projectionBefore);
    // Issuers are external authority adapters. Invoke them outside the storage transaction and
    // require command-idempotent reproduction so a raw proof never enters the durable UOW value.
    const issued = await issuer.issue(
      authority,
      {
        schemaVersion: "1",
        binding: gateBefore.binding,
        requiredAuthenticationStrength: gateBefore.requiredAuthenticationStrength,
        expiresAt,
      },
      command,
    );
    const challenge = DecisionSubmissionChallengeSchema.parse(issued.challenge);
    const challengeProofDigest = digestBytes(new TextEncoder().encode(issued.challengeProof));
    this.#assertExactBinding(
      {
        binding: challenge.binding,
        requiredAuthenticationStrength: challenge.requiredAuthenticationStrength,
        expiresAt: challenge.expiresAt,
        consumingCommandId: challenge.consumingCommandId ?? null,
        proofDigest: challenge.proofDigest,
      },
      {
        binding: gateBefore.binding,
        requiredAuthenticationStrength: gateBefore.requiredAuthenticationStrength,
        expiresAt,
        consumingCommandId: null,
        proofDigest: challengeProofDigest,
      },
      "issued_challenge_binding_mismatch",
    );
    const result = await this.#config.runCommandUnitOfWork.transactCommand(
      this.#commandScope(claims, command),
      command,
      async (transaction) => {
        const projection = await this.getRun(authority, runId);
        if (
          projection.status !== "waiting_for_approval" ||
          projection.waitingDecisionId !== decisionId
        ) {
          throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
            details: { reason: "run_not_waiting_for_exact_decision" },
          });
        }
        const gate = await store.getGate(claims.tenant.id, runId, decisionId);
        if (gate === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
        this.#assertDecisionGateAuthority(gate, claims, projection);
        this.#assertExactBinding(gate.binding, challenge.binding, "issued_challenge_gate_changed");
        const response = { challengeProofDigest, expiresAt };
        await transaction.putDecisionChallenge(challenge);
        await this.#recordCommand(transaction, claims, command, response);
        return response;
      },
    );
    if (result.value.challengeProofDigest !== challengeProofDigest) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "decision_challenge_proof_replay_changed" },
      });
    }
    return { challengeProof: issued.challengeProof, expiresAt: result.value.expiresAt };
  }

  async approve(
    authority: AuthorityContext,
    runId: string,
    decisionInput: JsonValue,
    commandInput: CommandContext,
  ): Promise<Readonly<{ approvalId: string; runId: string; automaticResume: boolean }>> {
    const decision = DecisionApprovalSubmissionSchema.parse(decisionInput);
    return this.#decideApprove(
      authority,
      runId,
      decision,
      CommandContextSchema.parse(commandInput),
    );
  }

  async reject(
    authority: AuthorityContext,
    runId: string,
    decisionInput: JsonValue,
    commandInput: CommandContext,
  ): Promise<Readonly<{ decisionId: string; runId: string; automaticResume: boolean }>> {
    const decision = DecisionRejectionSubmissionSchema.parse(decisionInput);
    return this.#decideReject(authority, runId, decision, CommandContextSchema.parse(commandInput));
  }

  async reconcileEffect(
    authority: AuthorityContext,
    runId: string,
    effectId: string,
    resolutionInput: JsonValue,
    commandInput: CommandContext,
  ): Promise<Readonly<{ runId: string; effectId: string; status: "recovered" | "abandoned" }>> {
    const claims = this.#verifyAuthority(authority, {
      kind: "run",
      operation: "run.reconcile_effect",
      runId,
    });
    if (!claims.decisionRoles.includes("effect:reconcile")) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "effect_reconcile_role_required" },
      });
    }
    const services = this.#config.effectServices;
    if (services === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { requiredCapability: "effectReconciliation" },
      });
    }
    const resolution = EffectReconciliationResolutionSchema.parse(resolutionInput);
    const command = CommandContextSchema.parse(commandInput);
    this.#assertCommand(command, "run.reconcile_effect", resolution);
    this.#assertCommandResourceScope(command, [runId, effectId]);
    this.#assertCommandWindow(command);
    const projectionBefore = await this.getRun(authority, runId);
    if (projectionBefore.status !== "suspended" || projectionBefore.activeEffectId !== effectId) {
      throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
        details: { reason: "run_not_suspended_at_exact_effect" },
      });
    }
    const recordBefore = await services.store.getByEffectId(claims.tenant.id, runId, effectId);
    if (recordBefore?.state !== "needs_reconciliation") {
      throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
        details: { reason: "effect_not_waiting_for_reconciliation" },
      });
    }
    const workOrder = await this.#loadWorkOrder(claims.tenant.id, projectionBefore.workOrderId);
    const definition = await this.#config.agentRegistry.resolve(
      workOrder.executionDefinition.id,
      workOrder.executionDefinition.version,
      workOrder.executionDefinition.agentDefinitionDigest,
    );
    if (definition === undefined) throw new KafError("KAF_RUNTIME_AGENT_DEFINITION_MISMATCH");
    const registration = this.#config.toolRegistry.resolve(recordBefore.toolRegistrationDigest);
    const strategy = services.strategies.resolve(recordBefore.toolRegistrationDigest);
    if (
      registration === undefined ||
      strategy === undefined ||
      strategy.registrationDigest !== recordBefore.strategyRegistrationDigest
    ) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "reconciliation_registration_unavailable" },
      });
    }
    let recovered:
      Readonly<{ result: JsonValue; acknowledgement: EffectAcknowledgement }> | undefined;
    if (resolution.kind === "recovered_acknowledgement") {
      if (strategy.kind !== "reconcilable" || recordBefore.operationKey === undefined) {
        throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
          details: { reason: "effect_has_no_registered_lookup" },
        });
      }
      const lookup = await strategy.lookup(recordBefore.operationKey, {
        tenantId: claims.tenant.id,
        runId,
        stepId: recordBefore.stepId,
        toolCallId: recordBefore.toolCallId,
        effectId,
        effectKey: recordBefore.effectKey,
        normalizedTargetDigest: recordBefore.normalizedTargetDigest,
        purposeCode: workOrder.purpose.code,
        dataClass: workOrder.dataClass,
        signal: new AbortController().signal,
      });
      if (lookup.status !== "applied") {
        throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
          details: { reason: `reconciliation_lookup_${lookup.status}` },
        });
      }
      recovered = validateEffectExecution({
        execution: lookup.execution,
        strategy,
        registration,
        effectKey: recordBefore.effectKey,
        operationKey: recordBefore.operationKey,
        normalizedTargetDigest: recordBefore.normalizedTargetDigest,
      });
      if (recovered.acknowledgement.proofKind !== "lookup_recovery") {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
          details: { reason: "reconciliation_lookup_proof_required" },
        });
      }
    }
    const recoveredProtectedResult =
      recovered === undefined
        ? undefined
        : await this.#protectEffectResult(
            workOrder,
            projectionBefore.runId,
            recordBefore,
            recovered,
            this.#config.clock.now(),
          );
    const result = await this.#config.runCommandUnitOfWork.transactCommand(
      this.#commandScope(claims, command),
      command,
      async (transaction) => {
        const projection = await this.getRun(authority, runId);
        const current = await services.store.getByEffectId(claims.tenant.id, runId, effectId);
        if (
          projection.status !== "suspended" ||
          projection.activeEffectId !== effectId ||
          current?.state !== "needs_reconciliation" ||
          current.effectDigest !== recordBefore.effectDigest
        ) {
          throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT");
        }
        const recordedEvent = this.#event(
          workOrder,
          runId,
          projection.lastSequence + 1,
          "EffectReconciliationRecorded",
          {
            stepId: current.stepId,
            effectId,
            resolution: resolution.kind,
            commandId: command.commandId,
          },
        );
        let next = reduceRunEvent(projection, recordedEvent);
        await transaction.appendRunEvent(recordedEvent);
        if (
          resolution.kind === "recovered_acknowledgement" &&
          recovered !== undefined &&
          recoveredProtectedResult !== undefined
        ) {
          const updatedAt = recoveredProtectedResult.createdAt;
          const recoveredResultDigest = digestCanonicalJson(recovered.result);
          const acknowledged = EffectRecordSchema.parse({
            ...this.#effectRecordBase(current, updatedAt),
            state: "acknowledged",
            resultDigest: recoveredResultDigest,
            acknowledgement: recovered.acknowledgement,
          });
          const acknowledgedEvent = this.#event(
            workOrder,
            runId,
            next.lastSequence + 1,
            "EffectAcknowledged",
            {
              stepId: current.stepId,
              effectId,
              resultDigest: recoveredResultDigest,
              acknowledgement: recovered.acknowledgement,
            },
          );
          next = reduceRunEvent(next, acknowledgedEvent);
          await transaction.putEffectRecord(acknowledged);
          await transaction.putProtectedEffectResult(recoveredProtectedResult);
          await transaction.appendRunEvent(acknowledgedEvent);
          const response = { runId, effectId, status: "recovered" as const };
          await transaction.putRunProjection(next);
          await this.#recordCommand(transaction, claims, command, response);
          return response;
        }
        const updatedAt = this.#config.clock.now();
        const abandoned = EffectRecordSchema.parse({
          ...this.#effectRecordBase(current, updatedAt),
          state: "abandoned",
          reason: (
            resolution as Extract<EffectReconciliationResolution, { kind: "abandon_uncertain" }>
          ).reason,
          evidenceRefs: (
            resolution as Extract<EffectReconciliationResolution, { kind: "abandon_uncertain" }>
          ).evidenceRefs,
          effectMayHaveOccurred: true,
        });
        const failedEvent = this.#event(workOrder, runId, next.lastSequence + 1, "RunFailed", {
          stepId: current.stepId,
          errorCode: "KAF_EFFECT_ABANDONED_UNCERTAIN",
          safeDetails: { effectId, effectMayHaveOccurred: true },
        });
        next = reduceRunEvent(next, failedEvent);
        const response = { runId, effectId, status: "abandoned" as const };
        await transaction.putEffectRecord(abandoned);
        await transaction.appendRunEvent(failedEvent);
        await transaction.putRunProjection(next);
        await this.#recordCommand(transaction, claims, command, response);
        return response;
      },
    );
    return result.value;
  }

  async requestCompensation(
    authority: AuthorityContext,
    runId: string,
    effectId: string,
    requestInput: JsonValue,
    commandInput: CommandContext,
  ): Promise<Readonly<{ compensationRunId: string }>> {
    const claims = this.#verifyAuthority(authority, {
      kind: "unscoped_only",
      operation: "run.request_compensation",
    });
    if (!claims.decisionRoles.includes("effect:compensate")) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "effect_compensate_role_required" },
      });
    }
    const effects = this.#config.effectServices;
    const compensation = this.#config.compensationServices;
    if (effects === undefined || compensation === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { requiredCapability: "compensation" },
      });
    }
    if (compensation.transactionDomain !== this.#config.runCommandUnitOfWork.transactionDomain) {
      throw new KafError("KAF_RUNTIME_NOT_READY", {
        details: { reason: "compensation_transaction_domain_mismatch" },
      });
    }
    const request = RuntimeCompensationRequestSchema.parse(requestInput);
    const command = CommandContextSchema.parse(commandInput);
    this.#assertCommand(command, "run.request_compensation", request);
    this.#assertCommandResourceScope(command, [runId, effectId]);
    this.#assertCommandWindow(command);
    const originalProjection = await this.getRun(authority, runId);
    const originalWorkOrder = await this.#loadWorkOrder(
      claims.tenant.id,
      originalProjection.workOrderId,
    );
    const originalEffect = await effects.store.getByEffectId(claims.tenant.id, runId, effectId);
    if (originalEffect?.state !== "acknowledged") {
      throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
        details: { reason: "compensation_requires_acknowledged_effect" },
      });
    }
    const originalResult = await effects.store.getAcknowledgedResult(originalEffect);
    if (
      originalResult === undefined ||
      digestCanonicalJson(originalResult) !== originalEffect.resultDigest
    ) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "compensation_original_result_unavailable" },
      });
    }
    const originalTool = this.#config.toolRegistry.resolve(originalEffect.toolRegistrationDigest);
    if (
      originalTool === undefined ||
      originalTool.security.reversibility !== "compensatable" ||
      originalTool.compensationStrategyRegistrationDigest === undefined
    ) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "compensation_strategy_registration_unavailable" },
      });
    }
    const binding = await compensation.resolve(originalTool.toolRegistrationDigest);
    if (binding === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "compensation_run_definition_unavailable" },
      });
    }
    const definition = CompensationRunDefinitionSchema.parse(binding.definition);
    if (
      this.#config.killSwitches?.isKilled(
        "compensation_definition",
        definition.compensationRunDefinitionDigest,
      ) === true ||
      this.#config.killSwitches?.isKilled(
        "compensation_strategy",
        definition.compensationStrategyRegistrationDigest,
      ) === true
    ) {
      throw new KafError("KAF_RUNTIME_NOT_READY", {
        details: { reason: "compensation_registration_killed" },
      });
    }
    const registeredDefinition = await compensation.registry.resolve(
      definition.id,
      definition.version,
      definition.compensationRunDefinitionDigest,
    );
    if (
      registeredDefinition === undefined ||
      canonicalJsonStringify(registeredDefinition) !== canonicalJsonStringify(definition) ||
      definition.originalAgentDefinitionDigest !==
        originalWorkOrder.executionDefinition.agentDefinitionDigest ||
      definition.originalToolRegistrationDigest !== originalTool.toolRegistrationDigest ||
      definition.compensationStrategyRegistrationDigest !==
        originalTool.compensationStrategyRegistrationDigest
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "compensation_definition_binding_mismatch" },
      });
    }
    const compensationTool = this.#config.toolRegistry.resolve(
      definition.compensationToolRegistrationDigest,
    );
    if (
      compensationTool === undefined ||
      compensationTool.id !== definition.compensationToolId ||
      compensationTool.implementationVersion !== definition.compensationToolVersion ||
      compensationTool.toolRegistrationDigest !== definition.compensationToolRegistrationDigest ||
      compensationTool.effectStrategyKind === "read" ||
      compensationTool.id === originalTool.id
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "compensation_tool_binding_mismatch" },
      });
    }
    if (!this.#config.purposeRegistry.has(definition.purposeCode)) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "compensation_purpose_unregistered" },
      });
    }
    const compensationInput = binding.validateInput(
      binding.deriveInput({
        result: originalResult,
        acknowledgement: originalEffect.acknowledgement,
      }),
    );
    const transactionResult = await this.#config.runCommandUnitOfWork.transactCommand(
      this.#commandScope(claims, command),
      command,
      async (transaction) => {
        const compensationRunId = this.#config.idGenerator.generate("compensation_run");
        const compensationWorkOrderId =
          this.#config.idGenerator.generate("compensation_work_order");
        const executionDefinition = {
          kind: "compensation" as const,
          id: definition.id,
          version: definition.version,
          compensationRunDefinitionDigest: definition.compensationRunDefinitionDigest,
          originalAgentDefinitionDigest: definition.originalAgentDefinitionDigest,
          originalEffectDigest: originalEffect.effectDigest,
          compensationStrategyRegistrationDigest: definition.compensationStrategyRegistrationDigest,
          compensationToolRegistrationDigest: definition.compensationToolRegistrationDigest,
        };
        const executionDefinitionDigest = digestCanonicalJson(executionDefinition);
        const createdAt = this.#config.clock.now();
        const acceptedMaterial = {
          schemaVersion: "1" as const,
          id: compensationWorkOrderId,
          createdAt,
          goal: request.reason,
          input: compensationInput,
          context: {
            roleFamily: "operations",
            workflowId: "effect_compensation",
            riskClass: "high" as const,
          },
          workMode: "automate" as const,
          autonomyMode: "delegate_review" as const,
          decisionOwner: { mode: "principal" as const, principal: claims.actor },
          purpose: {
            code: definition.purposeCode,
            registryVersion: definition.purposeRegistryVersion,
          },
          dataClass: originalWorkOrder.dataClass,
          retention: originalWorkOrder.retention,
          principal: claims.actor,
          tenant: claims.tenant,
          requestedCapabilities: definition.requiredCapabilities,
          resourceScopeCeiling: originalWorkOrder.resourceScopeCeiling,
          budget: request.budget,
          correlationId: command.commandId,
          kind: "compensation" as const,
          executionDefinition,
          executionDefinitionDigest,
          originalRunId: runId,
          originalEffectId: effectId,
          originalEffectDigest: originalEffect.effectDigest,
          originalEffectResultDigest: originalEffect.resultDigest,
          originalEffectAcknowledgementDigest: digestCanonicalJson(originalEffect.acknowledgement),
          compensationStrategyRegistrationDigest: definition.compensationStrategyRegistrationDigest,
          compensationToolId: definition.compensationToolId,
          compensationToolVersion: definition.compensationToolVersion,
          compensationToolRegistrationDigest: definition.compensationToolRegistrationDigest,
        };
        const workOrder = AcceptedCompensationWorkOrderSchema.parse({
          ...acceptedMaterial,
          workOrderBindingDigest: digestCanonicalJson(acceptedMaterial),
        });
        const intent = {
          originalTenantId: claims.tenant.id,
          originalRunId: runId,
          originalEffectId: effectId,
          originalEffectDigest: originalEffect.effectDigest,
          compensationRunId,
          compensationWorkOrderId,
          compensationRunDefinitionDigest: definition.compensationRunDefinitionDigest,
          commandId: command.commandId,
        };
        const reservedIntent = await compensation.putIntentOnce(transaction, intent);
        this.#assertExactBinding(reservedIntent, intent, "compensation_intent_binding_mismatch");
        const acceptedEvent = this.#event(workOrder, compensationRunId, 1, "RunAccepted", {
          workOrderId: compensationWorkOrderId,
          workOrderBindingDigest: workOrder.workOrderBindingDigest,
          requiredVerifierIds: definition.requiredVerifierRegistrationDigests,
        });
        const initialRun: Run = {
          schemaVersion: "1",
          runId: compensationRunId,
          tenantId: claims.tenant.id,
          workOrderId: compensationWorkOrderId,
          workOrderBindingDigest: workOrder.workOrderBindingDigest,
          executionDefinition,
          executionDefinitionDigest,
          status: "created",
          createdAt: acceptedEvent.occurredAt,
          updatedAt: acceptedEvent.occurredAt,
          dataClass: workOrder.dataClass,
          correlationId: command.commandId,
        };
        const projection = reduceRunEvent(createRunProjection(initialRun), acceptedEvent);
        const response = { compensationRunId };
        await transaction.putAcceptedWorkOrder(workOrder);
        await transaction.appendRunEvent(acceptedEvent);
        await transaction.putRunProjection(projection);
        await this.#recordCommand(transaction, claims, command, response);
        return response;
      },
    );
    return transactionResult.value;
  }

  async getRun(authority: AuthorityContext, runId: string): Promise<RunProjection> {
    const claims = this.#verifyAuthority(authority, { kind: "run", operation: "run.get", runId });
    const projection = await this.#config.eventStore.getProjection(claims.tenant.id, runId);
    if (projection === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    this.#assertAuthorityWorkOrderScope(claims, runId, projection.workOrderId);
    return projection;
  }

  async *events(
    authority: AuthorityContext,
    runId: string,
    options: Readonly<{ afterSequence?: number; signal?: AbortSignal }> = {},
  ): AsyncIterable<RunEvent> {
    const claims = this.#verifyAuthority(authority, {
      kind: "run",
      operation: "run.events",
      runId,
    });
    let projection = await this.#config.eventStore.getProjection(claims.tenant.id, runId);
    if (projection === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    this.#assertAuthorityWorkOrderScope(claims, runId, projection.workOrderId);
    let cursor = options.afterSequence ?? 0;
    const sleep = this.#config.sleep ?? defaultSleep;
    for (;;) {
      if (options.signal?.aborted === true) return;
      let observed = false;
      for await (const event of this.#config.eventStore.read(claims.tenant.id, runId, cursor)) {
        observed = true;
        cursor = event.sequence;
        yield event;
      }
      projection = await this.#config.eventStore.getProjection(claims.tenant.id, runId);
      if (projection === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
      this.#assertAuthorityWorkOrderScope(claims, runId, projection.workOrderId);
      if (TerminalRunStatusSchema.safeParse(projection.status).success) return;
      if (!observed) {
        try {
          await sleep(this.#config.eventStreamPollIntervalMs ?? 25, options.signal);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          throw error;
        }
      }
    }
  }

  cancel(
    authority: AuthorityContext,
    runId: string,
    command: CommandContext,
  ): Promise<RunProjection>;
  cancel(
    authority: AuthorityContext,
    runId: string,
    reasonCode: string,
    command: CommandContext,
  ): Promise<RunProjection>;
  async cancel(
    authority: AuthorityContext,
    runId: string,
    reasonOrCommand: string | CommandContext,
    explicitCommand?: CommandContext,
  ): Promise<RunProjection> {
    const claims = this.#verifyAuthority(authority, {
      kind: "run",
      operation: "run.cancel",
      runId,
    });
    await this.#assertAuthorityStoredRunScope(claims, runId);
    const reasonCode =
      typeof reasonOrCommand === "string" ? reasonOrCommand : "authenticated_cancellation";
    if (!/^[a-z0-9][a-z0-9_:-]{0,127}$/u.test(reasonCode)) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "reasonCode", issue: "invalid_format" },
      });
    }
    const commandInput = typeof reasonOrCommand === "string" ? explicitCommand : reasonOrCommand;
    const command = CommandContextSchema.parse(commandInput);
    this.#assertCommand(
      command,
      "run.cancel",
      typeof reasonOrCommand === "string" ? { runId, reason: reasonCode } : { runId },
    );
    this.#assertCommandWindow(command);
    const result = await this.#config.runCommandUnitOfWork.transactCommand(
      this.#commandScope(claims, command),
      command,
      async (transaction) => {
        const projection = await this.getRun(authority, runId);
        if (TerminalRunStatusSchema.safeParse(projection.status).success) {
          await this.#recordCommand(transaction, claims, command, projection);
          return projection;
        }
        const workOrder = await this.#loadWorkOrder(claims.tenant.id, projection.workOrderId);
        const event = this.#event(workOrder, runId, projection.lastSequence + 1, "RunCancelled", {
          ...(projection.currentStepId === null ? {} : { stepId: projection.currentStepId }),
          reasonCode,
          actorId: claims.actor.id,
        });
        const next = reduceRunEvent(projection, event);
        await transaction.appendRunEvent(event);
        await transaction.putRunProjection(next);
        await this.#recordCommand(transaction, claims, command, next);
        return next;
      },
    );
    this.#abortControllers.get(tenantRunKey(claims.tenant.id, runId))?.abort(reasonCode);
    return result.value;
  }

  async resume(
    authority: AuthorityContext,
    runId: string,
    commandInput: CommandContext,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<RuntimeExecutionResult> {
    const claims = this.#verifyAuthority(authority, {
      kind: "run",
      operation: "run.resume",
      runId,
    });
    await this.#assertAuthorityStoredRunScope(claims, runId);
    const command = CommandContextSchema.parse(commandInput);
    this.#assertCommand(command, "run.resume", { runId });
    this.#assertCommandWindow(command);
    const transactionResult = await this.#config.runCommandUnitOfWork.transactCommand(
      this.#commandScope(claims, command),
      command,
      async (transaction) => {
        const projection = await this.getRun(authority, runId);
        await this.#recordCommand(transaction, claims, command, {
          runId,
          status: projection.status,
        });
        if (
          !TerminalRunStatusSchema.safeParse(projection.status).success &&
          projection.status !== "waiting_for_input" &&
          projection.status !== "waiting_for_approval" &&
          this.#config.wakeupScheduler?.capabilities.backgroundWakeup === true
        ) {
          await transaction.enqueueWakeup({
            schemaVersion: "1",
            tenantId: claims.tenant.id,
            runId,
            reason: "resume",
            notBefore: this.#config.clock.now(),
            deduplicationKey: command.commandId,
            payload: {},
          });
        }
        return projection.status;
      },
    );
    const status = transactionResult.value;
    if (TerminalRunStatusSchema.safeParse(status).success) {
      return {
        runId,
        status:
          status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed",
      };
    }
    if (status === "waiting_for_input" || status === "waiting_for_approval") {
      return { runId, status: "parked" };
    }
    if (this.#config.wakeupScheduler?.capabilities.backgroundWakeup === true) {
      return { runId, status: "parked" };
    }
    return this.execute(authority, runId, options);
  }

  async execute(
    authority: AuthorityContext,
    runId: string,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<RuntimeExecutionResult> {
    const claims = this.#verifyAuthority(authority, {
      kind: "run",
      operation: "run.execute",
      runId,
    });
    let projection = await this.getRun(authority, runId);
    if (TerminalRunStatusSchema.safeParse(projection.status).success) {
      return {
        runId,
        status:
          projection.status === "completed"
            ? "completed"
            : projection.status === "cancelled"
              ? "cancelled"
              : "failed",
      };
    }
    const workOrder = await this.#loadAcceptedWorkOrder(claims.tenant.id, projection.workOrderId);
    if (workOrder.kind === "compensation") {
      return this.#executeCompensation(claims, workOrder, projection, options);
    }
    const definition = await this.#config.agentRegistry.resolve(
      workOrder.executionDefinition.id,
      workOrder.executionDefinition.version,
      workOrder.executionDefinition.agentDefinitionDigest,
    );
    if (definition === undefined) throw new KafError("KAF_RUNTIME_AGENT_DEFINITION_MISMATCH");
    const lease = await this.#config.leaseStore.acquire(
      claims.tenant.id,
      runId,
      this.#config.leaseHolderId,
      this.#config.leaseTtlMs ?? 30_000,
    );
    if (lease === undefined) throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT");
    const leaseSession: LeaseSession = { current: lease };
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(options.signal?.reason);
    };
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const executionRunKey = tenantRunKey(claims.tenant.id, runId);
    this.#abortControllers.set(executionRunKey, controller);
    try {
      const history = await this.#readEvents(claims.tenant.id, runId);
      let modelCalls = history.filter((event) => event.eventType === "ModelCallStarted").length;
      let toolCalls = history.filter((event) => event.eventType === "ToolCallRequested").length;
      let turns = history.filter((event) => event.eventType === "PlanningStarted").length;
      const toolCallsByRegistration = this.#toolCallCounts(history);
      const persistedActiveExecutionMs = this.#persistedActiveExecutionMs(history);
      if (
        projection.status === "waiting_for_input" ||
        projection.status === "waiting_for_approval"
      ) {
        return { runId, status: "parked" };
      }
      if (projection.status === "suspended") return { runId, status: "parked" };
      if (projection.status === "running") {
        const recovered = await this.#recoverInterruptedEffect(
          workOrder,
          projection,
          leaseSession,
          history,
        );
        if (recovered !== undefined) return { runId, status: "parked" };
      }
      let checkpoint =
        projection.status === "accepted"
          ? undefined
          : await this.#loadContextCheckpoint(workOrder, projection);
      if (projection.status !== "accepted" && checkpoint === undefined) {
        const last = history.at(-1);
        const stepId = projection.currentStepId ?? this.#config.idGenerator.generate("step");
        projection = await this.#append(workOrder, projection, leaseSession, "RunSuspended", {
          stepId,
          resumeTarget:
            projection.status === "verifying"
              ? "verifying"
              : projection.status === "running"
                ? "running"
                : "planning",
          reasonCode: `checkpoint_required_after_${last?.eventType ?? "unknown"}`,
        });
        return { runId, status: "parked" };
      }
      const invocationStartedAt = this.#config.clock.monotonicMilliseconds();
      let modelInput: JsonValue = checkpoint?.modelInput ?? {
        goal: workOrder.goal,
        input: workOrder.input,
      };
      for (;;) {
        if (checkpoint?.phase === "input") {
          modelInput = await this.#loadSubmittedInput(workOrder, projection, checkpoint, history);
          checkpoint = RuntimeContextCheckpointSchema.parse({
            schemaVersion: "1",
            phase: "model",
            stepId: checkpoint.stepId,
            attempt: modelCalls + 1,
            modelInput,
            verifications: [],
          });
        }
        if (checkpoint?.phase === "scheduled_backoff") {
          if (
            checkpoint.stepId === undefined ||
            checkpoint.retryBoundary === undefined ||
            checkpoint.nextAttempt === undefined ||
            checkpoint.notBefore === undefined ||
            checkpoint.resumePhase === undefined
          ) {
            throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
              details: { reason: "retry_checkpoint_invalid" },
            });
          }
          const remaining = Math.max(
            0,
            Date.parse(checkpoint.notBefore) - Date.parse(this.#config.clock.now()),
          );
          if (remaining > 0) {
            await this.#withActiveExecution({
              workOrder,
              lease: leaseSession,
              stepId: checkpoint.stepId,
              boundary: "scheduled_backoff",
              boundaryKey: `${checkpoint.retryBoundary}:${String(checkpoint.nextAttempt)}:${checkpoint.notBefore}`,
              signal: controller.signal,
              repeatAfterRecoveredReservation: true,
              callback: (boundarySignal) =>
                (this.#config.sleep ?? defaultSleep)(remaining, boundarySignal),
            });
          }
          this.#assertBoundary(workOrder, controller.signal, {
            dispatch: "internal",
            turns,
            modelCalls,
            toolCalls,
            activeExecutionMs:
              persistedActiveExecutionMs +
              Math.max(0, this.#config.clock.monotonicMilliseconds() - invocationStartedAt),
          });
          const {
            retryBoundary: _retryBoundary,
            retryClassification: _retryClassification,
            nextAttempt: _nextAttempt,
            notBefore: _notBefore,
            delayMs: _delayMs,
            resumePhase: _resumePhase,
            ...checkpointBase
          } = checkpoint;
          const resumed = RuntimeContextCheckpointSchema.parse({
            ...checkpointBase,
            phase: checkpoint.resumePhase,
            attempt: checkpoint.nextAttempt,
          });
          void _retryBoundary;
          void _retryClassification;
          void _nextAttempt;
          void _notBefore;
          void _delayMs;
          void _resumePhase;
          projection = await this.#append(
            workOrder,
            projection,
            leaseSession,
            "RetryResumed",
            {
              stepId: checkpoint.stepId,
              boundary: checkpoint.retryBoundary,
              boundaryKey:
                checkpoint.retryBoundary === "model"
                  ? `model:${checkpoint.stepId}`
                  : (checkpoint.toolCallId ?? `tool:${checkpoint.stepId}`),
              attempt: checkpoint.nextAttempt,
            },
            undefined,
            undefined,
            resumed,
          );
          checkpoint = resumed;
        }

        if (checkpoint?.phase === "final" || checkpoint?.phase === "verification") {
          if (checkpoint.stepId === undefined || checkpoint.emission?.type !== "final") {
            throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
              details: { reason: "final_context_checkpoint_invalid" },
            });
          }
          return await this.#finalize(
            workOrder,
            projection,
            leaseSession,
            checkpoint.stepId,
            checkpoint.emission.value,
            controller.signal,
            checkpoint,
          );
        }
        this.#assertBoundary(workOrder, controller.signal, {
          dispatch: "turn",
          turns,
          modelCalls,
          toolCalls,
          activeExecutionMs:
            persistedActiveExecutionMs +
            Math.max(0, this.#config.clock.monotonicMilliseconds() - invocationStartedAt),
        });
        let stepId: string;
        let next: RuntimeModelEmission;
        const resumedToolRequest = checkpoint?.phase === "tool_request";
        const resumedTool = checkpoint?.phase === "tool";
        if (
          checkpoint !== undefined &&
          (checkpoint.phase === "emission" || resumedToolRequest || resumedTool)
        ) {
          if (checkpoint.stepId === undefined || checkpoint.emission === undefined) {
            throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
              details: { reason: "model_context_checkpoint_invalid" },
            });
          }
          stepId = checkpoint.stepId;
          next = checkpoint.emission;
        } else {
          const resumedModel = checkpoint?.phase === "model";
          const resumedInflight = checkpoint?.phase === "model_inflight";
          if (resumedModel || resumedInflight) {
            if (checkpoint === undefined) {
              throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
                details: { reason: "model_context_checkpoint_missing" },
              });
            }
            if (checkpoint.stepId === undefined) {
              throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
                details: { reason: "model_context_step_missing" },
              });
            }
            stepId = checkpoint.stepId;
          } else {
            stepId = `step-${String(turns + 1)}`;
            projection = await this.#append(
              workOrder,
              projection,
              leaseSession,
              "PlanningStarted",
              { stepId },
              undefined,
              undefined,
              {
                schemaVersion: "1",
                phase: "model",
                stepId,
                attempt: modelCalls + 1,
                modelInput,
                verifications: [],
              },
            );
            turns += 1;
          }
          this.#assertBoundary(workOrder, controller.signal, {
            dispatch: "model",
            turns,
            modelCalls,
            toolCalls,
            activeExecutionMs:
              persistedActiveExecutionMs +
              Math.max(0, this.#config.clock.monotonicMilliseconds() - invocationStartedAt),
          });
          const attempt = checkpoint?.attempt ?? modelCalls + 1;
          const localModelCallKey = tenantRunStepKey(workOrder.tenant.id, projection.runId, stepId);
          if (resumedInflight && this.#config.productionModelServices !== undefined) {
            const services = this.#config.productionModelServices;
            let reservation = await services.reservationReader.get(
              workOrder.tenant.id,
              projection.runId,
              stepId,
              attempt,
            );
            if (reservation === undefined) {
              projection = await this.#append(workOrder, projection, leaseSession, "RunSuspended", {
                stepId,
                resumeTarget: "planning",
                reasonCode: "model_call_reservation_missing_after_start",
              });
              return { runId, status: "parked" };
            }
            if (reservation.status === "dispatched") {
              const dispatched = reservation;
              await this.#transitionModelReservation(
                workOrder,
                leaseSession,
                `uncertain:${dispatched.reservationId}`,
                async (transaction) => {
                  reservation = await services.reservations.markUncertain(transaction, dispatched);
                  this.#assertModelReservation(reservation, dispatched, "uncertain");
                },
              );
            }
            if (reservation.status === "uncertain" || reservation.status === "dispatched") {
              const scheduled = await this.#scheduleRetry({
                workOrder,
                projection,
                lease: leaseSession,
                stepId,
                boundary: "model",
                boundaryKey: `model:${stepId}`,
                attempt,
                classification: "uncertain",
                checkpoint: {
                  schemaVersion: "1",
                  phase: "model",
                  stepId,
                  attempt: attempt + 1,
                  modelInput,
                  verifications: [],
                },
              });
              if (scheduled !== undefined) {
                projection = scheduled.projection;
                checkpoint = scheduled.checkpoint;
                continue;
              }
              projection = await this.#append(workOrder, projection, leaseSession, "RunSuspended", {
                stepId,
                resumeTarget: "planning",
                reasonCode: "model_call_dispatched_outcome_uncertain",
              });
              return { runId, status: "parked" };
            }
            if (reservation.status !== "accepted") {
              projection = await this.#append(workOrder, projection, leaseSession, "RunSuspended", {
                stepId,
                resumeTarget: "planning",
                reasonCode: `model_call_${reservation.status}_without_result`,
              });
              return { runId, status: "parked" };
            }
          }
          if (resumedInflight && this.#uncertainLocalModelCalls.has(localModelCallKey)) {
            projection = await this.#append(workOrder, projection, leaseSession, "RunSuspended", {
              stepId,
              resumeTarget: "planning",
              reasonCode: "model_call_outcome_unknown",
            });
            return { runId, status: "parked" };
          }
          let modelCall: Readonly<{
            projection: RunProjection;
            reservationId: string;
            next: RuntimeModelEmission | undefined;
            completedEventCommitted: boolean;
          }>;
          try {
            modelCall = await this.#withActiveExecution({
              workOrder,
              lease: leaseSession,
              stepId,
              boundary: "model",
              boundaryKey: `model:${stepId}:${String(attempt)}`,
              signal: controller.signal,
              callback: () =>
                this.#invokeModelCall({
                  claims,
                  workOrder,
                  definition,
                  projection,
                  lease: leaseSession,
                  stepId,
                  attempt,
                  modelInput,
                  signal: controller.signal,
                  started: resumedInflight,
                }),
            });
          } catch (error) {
            const latest = await this.#config.eventStore.getProjection(
              workOrder.tenant.id,
              projection.runId,
            );
            if (latest !== undefined) projection = latest;
            modelCalls = Math.max(modelCalls, attempt);
            const boundaryError = this.#capturedBoundaryError(error);
            if (boundaryError === undefined) throw error;
            const classification = this.#classifyBoundaryError("model", boundaryError);
            if (classification === "aborted") this.#throwBoundaryError(boundaryError);
            const scheduled = await this.#scheduleRetry({
              workOrder,
              projection,
              lease: leaseSession,
              stepId,
              boundary: "model",
              boundaryKey: `model:${stepId}`,
              attempt,
              classification,
              checkpoint: {
                schemaVersion: "1",
                phase: "model",
                stepId,
                attempt: attempt + 1,
                modelInput,
                verifications: [],
              },
            });
            if (scheduled === undefined) {
              if (classification === "uncertain") {
                projection = await this.#append(
                  workOrder,
                  projection,
                  leaseSession,
                  "RunSuspended",
                  {
                    stepId,
                    resumeTarget: "planning",
                    reasonCode: "model_call_outcome_uncertain",
                  },
                );
                return { runId, status: "parked" };
              }
              throw this.#normalizeBoundaryFailure("model", boundaryError, classification);
            }
            projection = scheduled.projection;
            checkpoint = scheduled.checkpoint;
            continue;
          }
          projection = modelCall.projection;
          if (!resumedInflight) modelCalls += 1;
          if (modelCall.next === undefined) {
            return await this.#fail(
              workOrder,
              projection,
              leaseSession,
              stepId,
              "KAF_RUNTIME_MODEL_EMPTY",
            );
          }
          next = modelCall.next;
          this.#assertJsonByteLimit(
            next,
            workOrder.budget.maxStreamedOutputBytesPerCall,
            "model_output_per_call",
          );
          if (!modelCall.completedEventCommitted) {
            projection = await this.#append(
              workOrder,
              projection,
              leaseSession,
              "ModelCallCompleted",
              {
                stepId,
                modelCallReservationId: modelCall.reservationId,
                responseDigest: digestCanonicalJson(next),
                finishReason: next.type,
              },
              undefined,
              undefined,
              {
                schemaVersion: "1",
                phase: "emission",
                stepId,
                modelInput,
                emission: next,
                verifications: [],
              },
            );
          }
        }

        if (next.type === "input_request") {
          const requestId = `input-request-${stepId}`;
          projection = await this.#append(
            workOrder,
            projection,
            leaseSession,
            "InputRequested",
            {
              stepId,
              requestId,
              inputSchemaDigest: next.value.inputSchemaDigest,
              safePrompt: next.value.safePrompt,
            },
            undefined,
            undefined,
            {
              schemaVersion: "1",
              phase: "input",
              stepId,
              modelInput,
              emission: next,
              requestId,
              inputSchemaDigest: next.value.inputSchemaDigest,
              verifications: [],
            },
          );
          return { runId: projection.runId, status: "parked" };
        }

        if (next.type === "tool_call") {
          const registration = this.#config.toolRegistry.resolve(next.value.toolRegistrationDigest);
          if (
            registration === undefined ||
            !definition.toolRegistrationDigests.includes(next.value.toolRegistrationDigest) ||
            !registration.security.requiredScopes.every((scope) =>
              workOrder.requestedCapabilities.includes(scope),
            )
          ) {
            return await this.#fail(
              workOrder,
              projection,
              leaseSession,
              stepId,
              "KAF_AUTHORIZATION_BINDING_MISMATCH",
            );
          }
          ToolRegistrationContractSchema.parse(registration);
          const persistedCallsForRegistration =
            toolCallsByRegistration.get(registration.toolRegistrationDigest) ?? 0;
          const callsAlreadyUsed =
            resumedTool && persistedCallsForRegistration > 0
              ? persistedCallsForRegistration - 1
              : persistedCallsForRegistration;
          let resolvedCall: Awaited<ReturnType<typeof resolveHostToolCall>>;
          try {
            resolvedCall = await resolveHostToolCall({
              resolver: this.#config.toolCallResolver,
              workOrder,
              registration,
              proposedInput: next.value.input,
            });
          } catch {
            return await this.#fail(
              workOrder,
              projection,
              leaseSession,
              stepId,
              "KAF_POLICY_DENIED",
              { reason: "tool_input_or_resource_resolution_failed" },
            );
          }
          const argumentsDigest = resolvedCall.argumentsDigest;
          const toolCallId = checkpoint?.toolCallId ?? `tool-call-${stepId}`;
          if (!resumedTool) {
            if (!resumedToolRequest) {
              this.#assertBoundary(workOrder, controller.signal, {
                dispatch: "tool",
                turns,
                modelCalls,
                toolCalls,
                activeExecutionMs:
                  persistedActiveExecutionMs +
                  Math.max(0, this.#config.clock.monotonicMilliseconds() - invocationStartedAt),
              });
              if (callsAlreadyUsed >= registration.security.maxCallsPerRun) {
                return await this.#fail(
                  workOrder,
                  projection,
                  leaseSession,
                  stepId,
                  "KAF_RUNTIME_CAPABILITY_MISSING",
                  { reason: "per_tool_budget_exhausted" },
                );
              }
              projection = await this.#append(
                workOrder,
                projection,
                leaseSession,
                "ExecutionStarted",
                { stepId, toolCallId },
                undefined,
                undefined,
                {
                  schemaVersion: "1",
                  phase: "tool_request",
                  stepId,
                  modelInput,
                  emission: next,
                  toolCallId,
                  verifications: [],
                },
              );
            }
            projection = await this.#append(
              workOrder,
              projection,
              leaseSession,
              "ToolCallRequested",
              {
                stepId,
                toolCallId,
                toolRegistrationDigest: registration.toolRegistrationDigest,
                argumentsDigest,
              },
              undefined,
              undefined,
              {
                schemaVersion: "1",
                phase: "tool",
                stepId,
                modelInput,
                emission: next,
                toolCallId,
                attempt: 1,
                verifications: [],
              },
            );
            toolCalls += 1;
            toolCallsByRegistration.set(
              registration.toolRegistrationDigest,
              (toolCallsByRegistration.get(registration.toolRegistrationDigest) ?? 0) + 1,
            );
          }
          const policy = await evaluateHostToolCall({
            policyEngine: this.#config.policyEngine,
            workOrder,
            registration,
            resolvedCall,
            networkPolicy: this.#config.toolExecutor.networkPolicy,
            callsAlreadyUsed,
          });
          if (policy.decision === "deny")
            return await this.#fail(
              workOrder,
              projection,
              leaseSession,
              stepId,
              "KAF_POLICY_DENIED",
            );
          let approvedToolCall: Approval | undefined;
          if (policy.decision === "require_approval") {
            approvedToolCall = await this.#approvedToolCall({
              workOrder,
              projection,
              definition,
              registration,
              stepId,
              argumentsDigest,
              normalizedTargetDigest: policy.normalizedTargetDigest,
            });
          }
          if (policy.decision === "require_approval" && approvedToolCall === undefined) {
            const previewer = this.#config.decisionPreviewer;
            const decisionStore = this.#config.decisionStore;
            if (previewer === undefined || decisionStore === undefined) {
              return await this.#fail(
                workOrder,
                projection,
                leaseSession,
                stepId,
                "KAF_RUNTIME_CAPABILITY_MISSING",
                { reason: "decision_preview_or_store_missing" },
              );
            }
            if (workOrder.decisionOwner.mode !== "principal") {
              return await this.#fail(
                workOrder,
                projection,
                leaseSession,
                stepId,
                "KAF_RUNTIME_CAPABILITY_MISSING",
                { reason: "registered_role_resolution_required" },
              );
            }
            const decisionId = this.#config.idGenerator.generate("decision");
            const preview = DecisionPreviewReferenceSchema.parse(
              await previewer.preview({
                tenantId: workOrder.tenant.id,
                runId,
                stepId,
                decisionId,
                toolRegistrationDigest: registration.toolRegistrationDigest,
                argumentsDigest,
                targetDigest: policy.normalizedTargetDigest,
                value: resolvedCall.validatedInput,
              }),
            );
            const binding = {
              schemaVersion: "1" as const,
              tenant: workOrder.tenant,
              principal: workOrder.decisionOwner.principal,
              runId,
              stepId,
              decisionId,
              workOrderBindingDigest: workOrder.workOrderBindingDigest,
              executionDefinition: workOrder.executionDefinition,
              executionDefinitionDigest: workOrder.executionDefinitionDigest,
              toolId: registration.id,
              toolVersion: registration.implementationVersion,
              toolRegistrationDigest: registration.toolRegistrationDigest,
              argumentsDigest,
              targetDigest: policy.normalizedTargetDigest,
              ...(preview.contentDigest === undefined
                ? {}
                : { contentDigest: preview.contentDigest }),
              previewDigest: preview.previewDigest,
              purpose: workOrder.purpose,
              policyRegistrationDigest: definition.policyRegistrationDigest,
            };
            const requiredAuthenticationStrength =
              registration.security.riskClass === "R5"
                ? "user_presence"
                : registration.security.riskClass === "R4"
                  ? "phishing_resistant"
                  : "multi_factor";
            const requestingEventId = this.#config.idGenerator.generate("event");
            const decisionGateDigest = digestCanonicalJson({
              decisionId,
              requestingEventId,
              binding,
              requiredAuthenticationStrength,
            });
            const gate = DecisionGateSchema.parse({
              schemaVersion: "1",
              decisionId,
              tenantId: workOrder.tenant.id,
              runId,
              requestingEventId,
              binding,
              decisionGateDigest,
              requiredAuthenticationStrength,
              createdAt: this.#config.clock.now(),
            });
            projection = await this.#append(
              workOrder,
              projection,
              leaseSession,
              "ApprovalRequested",
              {
                stepId,
                decisionId,
                decisionGateDigest,
                proposedEffectDigest: digestCanonicalJson(binding),
                ...(preview.approvalDisplay === undefined
                  ? {}
                  : { approvalDisplay: preview.approvalDisplay }),
              },
              requestingEventId,
              async (transaction) => {
                await transaction.putDecisionGate(gate);
              },
            );
            return { runId, status: "parked" };
          }
          this.#assertBoundary(workOrder, controller.signal, {
            dispatch: "internal",
            turns,
            modelCalls,
            toolCalls,
            activeExecutionMs:
              persistedActiveExecutionMs +
              Math.max(0, this.#config.clock.monotonicMilliseconds() - invocationStartedAt),
          });
          let result: JsonValue;
          if (registration.effectStrategyKind === "read") {
            if (approvedToolCall !== undefined) {
              await this.#claimReadApproval({
                workOrder,
                lease: leaseSession,
                approval: approvedToolCall,
                stepId,
                toolCallId,
                argumentsDigest,
                normalizedTargetDigest: policy.normalizedTargetDigest,
              });
            }
            if (
              registration.security.riskClass !== "R0" &&
              registration.security.riskClass !== "R1"
            ) {
              return await this.#fail(
                workOrder,
                projection,
                leaseSession,
                stepId,
                "KAF_RUNTIME_CAPABILITY_MISSING",
                { reason: "read_effect_strategy_risk_mismatch" },
              );
            }
            const toolAttempt = checkpoint?.attempt ?? 1;
            try {
              result = await this.#withActiveExecution({
                workOrder,
                lease: leaseSession,
                stepId,
                boundary: "tool",
                boundaryKey: `${toolCallId}:${String(toolAttempt)}`,
                signal: controller.signal,
                callback: (boundarySignal) =>
                  this.#captureBoundaryInvocation(() =>
                    this.#config.toolExecutor.execute({
                      registration,
                      input: resolvedCall.validatedInput,
                      signal: boundarySignal,
                    }),
                  ),
              });
            } catch (error) {
              const boundaryError = this.#capturedBoundaryError(error);
              if (boundaryError === undefined) throw error;
              const classification = this.#classifyBoundaryError(
                "tool",
                boundaryError,
                registration,
              );
              if (classification === "aborted") this.#throwBoundaryError(boundaryError);
              const scheduled = await this.#scheduleRetry({
                workOrder,
                projection,
                lease: leaseSession,
                stepId,
                boundary: "tool",
                boundaryKey: toolCallId,
                attempt: toolAttempt,
                classification,
                checkpoint: {
                  schemaVersion: "1",
                  phase: "tool",
                  stepId,
                  attempt: toolAttempt + 1,
                  modelInput,
                  emission: next,
                  toolCallId,
                  verifications: [],
                },
              });
              if (scheduled === undefined) {
                if (classification === "uncertain") {
                  projection = await this.#append(
                    workOrder,
                    projection,
                    leaseSession,
                    "RunSuspended",
                    {
                      stepId,
                      resumeTarget: "running",
                      reasonCode: "tool_call_outcome_uncertain",
                    },
                  );
                  return { runId, status: "parked" };
                }
                throw this.#normalizeBoundaryFailure("tool", boundaryError, classification);
              }
              projection = scheduled.projection;
              checkpoint = scheduled.checkpoint;
              continue;
            }
          } else {
            const effectOutcome = await this.#executeWriteEffect({
              workOrder,
              definition,
              projection,
              lease: leaseSession,
              registration,
              stepId,
              toolCallId,
              value: resolvedCall.validatedInput,
              normalizedTargetDigest: policy.normalizedTargetDigest,
              ...(approvedToolCall === undefined ? {} : { approval: approvedToolCall }),
              signal: controller.signal,
              checkpoint: {
                schemaVersion: "1",
                phase: "tool",
                stepId,
                attempt: checkpoint?.attempt ?? 1,
                modelInput,
                emission: next,
                toolCallId,
                verifications: [],
              },
            });
            projection = effectOutcome.projection;
            if (effectOutcome.status === "parked") return { runId, status: "parked" };
            result = effectOutcome.result;
          }
          this.#assertJsonByteLimit(
            result,
            workOrder.budget.maxToolResultContextBytesPerCall,
            "tool_result_per_call",
          );
          const nextModelInput: JsonValue = {
            goal: workOrder.goal,
            input: workOrder.input,
            toolResult: result,
          };
          projection = await this.#append(
            workOrder,
            projection,
            leaseSession,
            "ToolCallCompleted",
            {
              stepId,
              toolCallId,
              resultDigest: digestCanonicalJson(result),
            },
            undefined,
            undefined,
            {
              schemaVersion: "1",
              phase: "turn",
              stepId,
              modelInput: nextModelInput,
              verifications: [],
            },
          );
          modelInput = nextModelInput;
          checkpoint = undefined;
          continue;
        }

        projection = await this.#append(
          workOrder,
          projection,
          leaseSession,
          "ExecutionStarted",
          { stepId },
          undefined,
          undefined,
          {
            schemaVersion: "1",
            phase: "final",
            stepId,
            modelInput,
            emission: next,
            verifications: [],
          },
        );
        return await this.#finalize(
          workOrder,
          projection,
          leaseSession,
          stepId,
          next.value,
          controller.signal,
          {
            schemaVersion: "1",
            phase: "final",
            stepId,
            modelInput,
            emission: next,
            verifications: [],
          },
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const latest = await this.#config.eventStore.getProjection(claims.tenant.id, runId);
        if (latest !== undefined && !TerminalRunStatusSchema.safeParse(latest.status).success) {
          await this.#append(workOrder, latest, leaseSession, "RunCancelled", {
            ...(latest.currentStepId === null ? {} : { stepId: latest.currentStepId }),
            reasonCode: "abort_signal",
            actorId: claims.actor.id,
          });
        }
        return { runId, status: "cancelled" };
      }
      const terminal = await this.#terminalizeExecutionFailure(workOrder, leaseSession, error);
      if (terminal !== undefined) return terminal;
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.#abortControllers.delete(executionRunKey);
      await this.#config.leaseStore.release(leaseSession.current);
    }
  }

  async #executeCompensation(
    claims: VerifiedAuthority,
    workOrder: AcceptedCompensationWorkOrder,
    projectionInput: RunProjection,
    options: Readonly<{ signal?: AbortSignal }>,
  ): Promise<RuntimeExecutionResult> {
    const services = this.#config.compensationServices;
    if (
      services === undefined ||
      services.transactionDomain !== this.#config.runCommandUnitOfWork.transactionDomain
    ) {
      throw new KafError("KAF_RUNTIME_NOT_READY", {
        details: { reason: "compensation_transaction_domain_unavailable" },
      });
    }
    const definition = await services.registry.resolve(
      workOrder.executionDefinition.id,
      workOrder.executionDefinition.version,
      workOrder.executionDefinition.compensationRunDefinitionDigest,
    );
    if (
      this.#config.killSwitches?.isKilled(
        "compensation_definition",
        workOrder.executionDefinition.compensationRunDefinitionDigest,
      ) === true ||
      this.#config.killSwitches?.isKilled(
        "compensation_strategy",
        workOrder.executionDefinition.compensationStrategyRegistrationDigest,
      ) === true
    ) {
      throw new KafError("KAF_RUNTIME_NOT_READY", {
        details: { reason: "compensation_registration_killed" },
      });
    }
    if (
      definition === undefined ||
      definition.compensationRunDefinitionDigest !==
        workOrder.executionDefinition.compensationRunDefinitionDigest ||
      definition.originalAgentDefinitionDigest !==
        workOrder.executionDefinition.originalAgentDefinitionDigest ||
      definition.compensationStrategyRegistrationDigest !==
        workOrder.executionDefinition.compensationStrategyRegistrationDigest ||
      definition.compensationToolRegistrationDigest !==
        workOrder.executionDefinition.compensationToolRegistrationDigest ||
      workOrder.originalEffectDigest !== workOrder.executionDefinition.originalEffectDigest
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "compensation_execution_definition_mismatch" },
      });
    }
    const registration = this.#config.toolRegistry.resolve(
      definition.compensationToolRegistrationDigest,
    );
    if (
      registration === undefined ||
      registration.id !== definition.compensationToolId ||
      registration.implementationVersion !== definition.compensationToolVersion ||
      registration.toolRegistrationDigest !== definition.compensationToolRegistrationDigest ||
      registration.effectStrategyKind === "read"
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "compensation_tool_registration_mismatch" },
      });
    }
    const lease = await this.#config.leaseStore.acquire(
      claims.tenant.id,
      projectionInput.runId,
      this.#config.leaseHolderId,
      this.#config.leaseTtlMs ?? 30_000,
    );
    if (lease === undefined) throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT");
    const leaseSession: LeaseSession = { current: lease };
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(options.signal?.reason);
    };
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const executionRunKey = tenantRunKey(claims.tenant.id, projectionInput.runId);
    this.#abortControllers.set(executionRunKey, controller);
    let projection = projectionInput;
    try {
      if (projection.status === "suspended") return { runId: projection.runId, status: "parked" };
      if (projection.status !== "accepted") {
        throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
          details: { reason: "compensation_requires_accepted_checkpoint" },
        });
      }
      const stepId = this.#config.idGenerator.generate("compensation_step");
      const toolCallId = this.#config.idGenerator.generate("compensation_tool_call");
      this.#assertBoundary(workOrder, controller.signal, {
        dispatch: "tool",
        turns: 0,
        modelCalls: 0,
        toolCalls: 0,
        activeExecutionMs: 0,
      });
      projection = await this.#append(workOrder, projection, leaseSession, "ExecutionStarted", {
        stepId,
        toolCallId,
      });
      projection = await this.#append(
        workOrder,
        projection,
        leaseSession,
        "CompensationRequested",
        {
          stepId,
          originalRunId: workOrder.originalRunId,
          originalEffectDigest: workOrder.originalEffectDigest,
          compensationRunId: projection.runId,
        },
      );
      let resolvedCall: Awaited<ReturnType<typeof resolveHostToolCall>>;
      try {
        resolvedCall = await resolveHostToolCall({
          resolver: this.#config.toolCallResolver,
          workOrder,
          registration,
          proposedInput: workOrder.input,
        });
      } catch {
        return await this.#fail(workOrder, projection, leaseSession, stepId, "KAF_POLICY_DENIED", {
          reason: "compensation_input_or_resource_resolution_failed",
        });
      }
      const argumentsDigest = resolvedCall.argumentsDigest;
      projection = await this.#append(workOrder, projection, leaseSession, "ToolCallRequested", {
        stepId,
        toolCallId,
        toolRegistrationDigest: registration.toolRegistrationDigest,
        argumentsDigest,
      });
      const policy = await evaluateHostToolCall({
        policyEngine: this.#config.policyEngine,
        workOrder,
        registration,
        resolvedCall,
        networkPolicy: this.#config.toolExecutor.networkPolicy,
        callsAlreadyUsed: 0,
      });
      if (policy.decision !== "allow_with_grant") {
        return await this.#fail(
          workOrder,
          projection,
          leaseSession,
          stepId,
          policy.decision === "deny" ? "KAF_POLICY_DENIED" : "KAF_RUNTIME_CAPABILITY_MISSING",
          { reason: "compensation_approval_gate_not_materialized" },
        );
      }
      const outcome = await this.#executeWriteEffect({
        workOrder,
        definition,
        projection,
        lease: leaseSession,
        registration,
        stepId,
        toolCallId,
        value: resolvedCall.validatedInput,
        normalizedTargetDigest: policy.normalizedTargetDigest,
        signal: controller.signal,
      });
      projection = outcome.projection;
      if (outcome.status === "parked") return { runId: projection.runId, status: "parked" };
      this.#assertJsonByteLimit(
        outcome.result,
        workOrder.budget.maxToolResultContextBytesPerCall,
        "tool_result_per_call",
      );
      projection = await this.#append(workOrder, projection, leaseSession, "ToolCallCompleted", {
        stepId,
        toolCallId,
        resultDigest: digestCanonicalJson(outcome.result),
      });
      return await this.#finalize(
        workOrder,
        projection,
        leaseSession,
        stepId,
        outcome.result,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        const latest = await this.#config.eventStore.getProjection(
          claims.tenant.id,
          projectionInput.runId,
        );
        if (latest !== undefined && !TerminalRunStatusSchema.safeParse(latest.status).success) {
          await this.#append(workOrder, latest, leaseSession, "RunCancelled", {
            ...(latest.currentStepId === null ? {} : { stepId: latest.currentStepId }),
            reasonCode: "abort_signal",
            actorId: claims.actor.id,
          });
        }
        return { runId: projectionInput.runId, status: "cancelled" };
      }
      const terminal = await this.#terminalizeExecutionFailure(workOrder, leaseSession, error);
      if (terminal !== undefined) return terminal;
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.#abortControllers.delete(executionRunKey);
      await this.#config.leaseStore.release(leaseSession.current);
    }
  }

  async #invokeModelCall(input: {
    readonly claims: VerifiedAuthority;
    readonly workOrder: AcceptedAgentWorkOrder;
    readonly definition: AgentDefinition;
    readonly projection: RunProjection;
    readonly lease: LeaseSession;
    readonly stepId: string;
    readonly attempt: number;
    readonly modelInput: JsonValue;
    readonly signal: AbortSignal;
    readonly started?: boolean;
  }): Promise<
    Readonly<{
      projection: RunProjection;
      reservationId: string;
      next: RuntimeModelEmission | undefined;
      completedEventCommitted: boolean;
    }>
  > {
    if (
      this.#config.killSwitches?.isKilled(
        "model_adapter",
        input.definition.modelAdapterRegistrationDigest,
      ) === true ||
      this.#config.killSwitches?.isKilled(
        "model_profile",
        input.definition.modelSecurityProfileDigest,
      ) === true ||
      this.#config.killSwitches?.isKilled(
        "model_profile",
        input.definition.modelResourceProfileDigest,
      ) === true
    ) {
      throw new KafError("KAF_RUNTIME_NOT_READY", {
        details: { reason: "model_registration_killed" },
      });
    }
    this.#assertJsonByteLimit(
      input.modelInput,
      input.workOrder.budget.maxModelInputBytesPerCall,
      "model_input_per_call",
    );
    const services = this.#config.productionModelServices;
    if (services === undefined) {
      if (this.#requiresProductionModelBoundary()) {
        throw new KafError("KAF_MODEL_CREDENTIAL_REQUIRED", {
          details: { reason: "production_model_boundary_unavailable" },
        });
      }
      const reservationId = `model-call-${input.stepId}-${String(input.attempt)}`;
      const projection = input.started
        ? input.projection
        : await this.#append(
            input.workOrder,
            input.projection,
            input.lease,
            "ModelCallStarted",
            {
              stepId: input.stepId,
              modelCallReservationId: reservationId,
              requestDigest: digestCanonicalJson(input.modelInput),
            },
            undefined,
            undefined,
            {
              schemaVersion: "1",
              phase: "model_inflight",
              stepId: input.stepId,
              attempt: input.attempt,
              modelInput: input.modelInput,
              verifications: [],
            },
          );
      const run = this.#asRun(projection);
      let next: RuntimeModelEmission | undefined;
      try {
        next = await this.#withLeaseHeartbeat(input.lease, input.signal, (boundarySignal) =>
          this.#captureBoundaryInvocation(async () => {
            for await (const rawEmission of this.#config.modelDriver.invoke({
              run,
              input: input.modelInput,
              signal: boundarySignal,
            })) {
              return this.#parseModelEmission(rawEmission);
            }
            return undefined;
          }),
        );
      } catch (error) {
        this.#uncertainLocalModelCalls.add(
          tenantRunStepKey(input.workOrder.tenant.id, projection.runId, input.stepId),
        );
        throw error;
      }
      return { projection, reservationId, next, completedEventCommitted: false };
    }
    if (!this.#productionModelBoundaryReady()) {
      throw new KafError("KAF_RUNTIME_NOT_READY", {
        details: { reason: "durable_model_reservation_domain_unavailable" },
      });
    }
    return this.#invokeProductionModelCall(input, services);
  }

  async #invokeProductionModelCall(
    input: {
      readonly claims: VerifiedAuthority;
      readonly workOrder: AcceptedAgentWorkOrder;
      readonly definition: AgentDefinition;
      readonly projection: RunProjection;
      readonly lease: LeaseSession;
      readonly stepId: string;
      readonly attempt: number;
      readonly modelInput: JsonValue;
      readonly signal: AbortSignal;
    },
    services: RuntimeProductionModelServices,
  ): Promise<
    Readonly<{
      projection: RunProjection;
      reservationId: string;
      next: RuntimeModelEmission | undefined;
      completedEventCommitted: true;
    }>
  > {
    const security = services.profiles.resolveSecurity(input.definition.modelSecurityProfileDigest);
    const resource = services.profiles.resolveResource(input.definition.modelResourceProfileDigest);
    const adapter = services.adapters.resolve(input.definition.modelAdapterRegistrationDigest);
    if (security === undefined || resource === undefined || adapter === undefined) {
      throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
        details: { reason: "registered_model_material_unavailable" },
      });
    }
    this.#assertProductionModelBinding(input, adapter, security, resource);
    const outputTokenMaximum = Math.min(
      resource.maxOutputTokensPerCall,
      input.workOrder.budget.maxModelOutputTokensPerCall ?? resource.maxOutputTokensPerCall,
    );
    const providerRequest = {
      schemaVersion: "1" as const,
      instructions: input.definition.instructions,
      modelConfig: input.definition.modelConfig,
      toolRegistrationDigests: input.definition.toolRegistrationDigests,
      input: input.modelInput,
      outputTokenMaximum,
    };
    const canonicalRequest = canonicalJsonStringify(providerRequest);
    const inputBytes = new TextEncoder().encode(canonicalRequest).byteLength;
    this.#assertJsonByteLimit(
      providerRequest,
      Math.min(
        resource.maxInputBytesPerCall,
        input.workOrder.budget.maxModelInputBytesPerCall ?? resource.maxInputBytesPerCall,
      ),
      "model_input_per_call",
    );
    let inputTokenUpperBound: number;
    try {
      inputTokenUpperBound = adapter.estimateInputTokens({ canonicalRequest, inputBytes });
    } catch {
      throw new KafError("KAF_MODEL_RESOURCE_LIMIT_EXCEEDED", {
        details: { limit: "model_input_estimation" },
      });
    }
    if (
      !Number.isSafeInteger(inputTokenUpperBound) ||
      inputTokenUpperBound <= 0 ||
      inputTokenUpperBound > resource.maxInputTokensPerCall ||
      inputTokenUpperBound >
        (input.workOrder.budget.maxModelInputTokensPerCall ?? resource.maxInputTokensPerCall)
    ) {
      throw new KafError("KAF_MODEL_RESOURCE_LIMIT_EXCEEDED", {
        details: { limit: "model_input_tokens_per_call" },
      });
    }
    const now = this.#config.clock.now();
    if (
      input.workOrder.budget.monetaryCeiling !== undefined &&
      (resource.priceCurrency !== input.workOrder.budget.monetaryCeiling.currency ||
        resource.priceTableExpiresAt === undefined ||
        Date.parse(resource.priceTableExpiresAt) <= Date.parse(now))
    ) {
      throw new KafError("KAF_MODEL_RESOURCE_LIMIT_EXCEEDED", {
        details: { limit: "model_price_bound" },
      });
    }
    const reservationId = createModelCallReservationId({
      tenantId: input.workOrder.tenant.id,
      runId: input.projection.runId,
      stepId: input.stepId,
      attempt: input.attempt,
      workOrderBindingDigest: input.workOrder.workOrderBindingDigest,
      agentDefinitionDigest: input.definition.agentDefinitionDigest,
      modelSecurityProfileDigest: security.modelSecurityProfileDigest,
      modelResourceProfileDigest: resource.modelResourceProfileDigest,
      modelAdapterRegistrationDigest: adapter.registration.modelAdapterRegistrationDigest,
    });
    const reservationCreatedAt = input.projection.updatedAt;
    const reservation = ModelCallReservationSchema.parse({
      schemaVersion: "1",
      reservationId,
      tenantId: input.workOrder.tenant.id,
      runId: input.projection.runId,
      stepId: input.stepId,
      attempt: input.attempt,
      workOrderBindingDigest: input.workOrder.workOrderBindingDigest,
      agentDefinitionDigest: input.definition.agentDefinitionDigest,
      modelSecurityProfileDigest: security.modelSecurityProfileDigest,
      modelResourceProfileDigest: resource.modelResourceProfileDigest,
      modelAdapterRegistrationDigest: adapter.registration.modelAdapterRegistrationDigest,
      inputBytes,
      inputTokenUpperBound,
      outputTokenMaximum,
      outputBytesMaximum: Math.min(
        resource.maxStreamedOutputBytesPerCall,
        input.workOrder.budget.maxStreamedOutputBytesPerCall ??
          resource.maxStreamedOutputBytesPerCall,
      ),
      ...(input.workOrder.budget.monetaryCeiling === undefined
        ? {}
        : {
            maximumCallCostMinor: Math.ceil(input.workOrder.budget.monetaryCeiling.amount * 100),
            currency: input.workOrder.budget.monetaryCeiling.currency,
          }),
      status: "accepted",
      createdAt: reservationCreatedAt,
      expiresAt: new Date(
        Date.parse(reservationCreatedAt) + (services.credentialRefTtlMs ?? 300_000),
      ).toISOString(),
    });
    let accepted: ModelCallReservation | undefined;
    let projection = await this.#append(
      input.workOrder,
      input.projection,
      input.lease,
      "ModelCallStarted",
      {
        stepId: input.stepId,
        modelCallReservationId: reservationId,
        requestDigest: digestCanonicalJson(providerRequest),
      },
      undefined,
      async (transaction) => {
        accepted = await services.reservations.reserve(transaction, reservation);
        this.#assertModelReservation(accepted, reservation, "accepted");
      },
      {
        schemaVersion: "1",
        phase: "model_inflight",
        stepId: input.stepId,
        attempt: input.attempt,
        modelInput: input.modelInput,
        verifications: [],
      },
    );
    if (accepted === undefined) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "model_reservation_not_returned" },
      });
    }
    const acceptedReservation = accepted;
    const binding = ModelCallBindingSchema.parse({
      schemaVersion: "1",
      tenantId: input.workOrder.tenant.id,
      authoritySubject: input.claims.actor.id,
      workOrderBindingDigest: input.workOrder.workOrderBindingDigest,
      agentDefinitionDigest: input.definition.agentDefinitionDigest,
      modelSecurityProfileDigest: security.modelSecurityProfileDigest,
      modelResourceProfileDigest: resource.modelResourceProfileDigest,
      modelAdapterRegistrationDigest: adapter.registration.modelAdapterRegistrationDigest,
      reservationId,
      providerEndpointOrigin: security.endpointOrigin,
      purpose: input.workOrder.purpose.code,
      permittedDataClasses: [input.workOrder.dataClass],
      credentialSlot: security.credentialSlot,
    });
    let issuedRef: ReturnType<typeof ModelCredentialRefSchema.parse>;
    try {
      issuedRef = ModelCredentialRefSchema.parse(
        await services.credentialIssuer.issue(
          ModelCredentialIssueRequestSchema.parse({
            schemaVersion: "1",
            binding,
            reservation: acceptedReservation,
            expiresAt: acceptedReservation.expiresAt,
          }),
        ),
      );
    } catch {
      throw new KafError("KAF_MODEL_CREDENTIAL_REQUIRED", {
        details: { reason: "model_credential_issuance_failed" },
      });
    }
    if (issuedRef.issuerId !== services.credentialIssuer.issuerId) {
      throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
        details: { reason: "model_credential_issuer_mismatch" },
      });
    }
    const context = validateModelCallContext({
      context: {
        schemaVersion: "1",
        binding,
        reservation: acceptedReservation,
        credentialRef: issuedRef,
      },
      registration: adapter.registration,
      securityProfile: security,
      resourceProfile: resource,
      now,
    });
    await this.#transitionModelReservation(
      input.workOrder,
      input.lease,
      `dispatch:${reservationId}`,
      async (transaction) => {
        const dispatched = await services.reservations.markDispatched(
          transaction,
          acceptedReservation,
        );
        this.#assertModelReservation(dispatched, acceptedReservation, "dispatched");
      },
    );
    let credentialResolutionCount = 0;
    let next: RuntimeModelEmission | undefined;
    try {
      next = await this.#withLeaseHeartbeat(input.lease, input.signal, async (boundarySignal) => {
        for await (const rawEmission of adapter.invoke({
          run: this.#asRun(projection),
          providerRequest,
          outputTokenMaximum,
          context,
          signal: boundarySignal,
          resolveCredential: async () => {
            credentialResolutionCount += 1;
            if (credentialResolutionCount !== 1) {
              throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
                details: { reason: "model_credential_resolution_repeated" },
              });
            }
            validateModelCallContext({
              context,
              registration: adapter.registration,
              securityProfile: security,
              resourceProfile: resource,
              now: this.#config.clock.now(),
            });
            return services.credentialResolver.resolve({
              ref: context.credentialRef,
              binding: context.binding,
              reservation: context.reservation,
            });
          },
        })) {
          return this.#parseModelEmission(rawEmission);
        }
        return undefined;
      });
      if (credentialResolutionCount !== 1) {
        throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
          details: { reason: "sealed_adapter_did_not_resolve_credential" },
        });
      }
    } catch (error) {
      const invalidEmission =
        error instanceof KafError &&
        error.code === "KAF_MODEL_ADAPTER_MISMATCH" &&
        error.details?.["reason"] === "model_emission_schema_invalid";
      const retryClassification = invalidEmission
        ? "non_retryable"
        : adapter.classifyError === undefined
          ? "uncertain"
          : this.#safeBoundaryClassification(() => adapter.classifyError?.(error) ?? "uncertain");
      await this.#transitionModelReservation(
        input.workOrder,
        input.lease,
        `uncertain:${reservationId}`,
        async (transaction) => {
          const uncertain = await services.reservations.markUncertain(
            transaction,
            acceptedReservation,
          );
          this.#assertModelReservation(uncertain, acceptedReservation, "uncertain");
        },
      );
      if (invalidEmission) {
        throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
          details: { reason: "model_emission_schema_invalid", retryClassification },
          internalCause: error,
        });
      }
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "model_call_failed_after_dispatch", retryClassification },
        internalCause: error,
      });
    }
    const outputBytes =
      next === undefined ? 0 : new TextEncoder().encode(canonicalJsonStringify(next)).byteLength;
    if (next !== undefined) {
      this.#assertJsonByteLimit(
        next,
        Math.min(
          resource.maxStreamedOutputBytesPerCall,
          input.workOrder.budget.maxStreamedOutputBytesPerCall ??
            resource.maxStreamedOutputBytesPerCall,
        ),
        "model_output_per_call",
      );
    }
    const trustedProviderUsage = adapter.trustedUsage?.(context);
    const settlement: RuntimeModelCallSettlement = {
      inputBytes,
      inputTokenLowerBound: inputTokenUpperBound,
      outputBytes,
      outputTokenLowerBound: outputBytes === 0 ? 0 : 1,
      ...(trustedProviderUsage === undefined ? {} : { trustedProviderUsage }),
    };
    projection = await this.#append(
      input.workOrder,
      projection,
      input.lease,
      "ModelCallCompleted",
      {
        stepId: input.stepId,
        modelCallReservationId: reservationId,
        responseDigest: digestCanonicalJson(next ?? null),
        finishReason: next?.type ?? "empty",
      },
      undefined,
      async (transaction) => {
        const settled = await services.reservations.settle(
          transaction,
          acceptedReservation,
          settlement,
        );
        this.#assertModelReservation(settled, acceptedReservation, "settled");
      },
      next === undefined
        ? {
            schemaVersion: "1",
            phase: "model",
            stepId: input.stepId,
            attempt: input.attempt,
            modelInput: input.modelInput,
            verifications: [],
          }
        : {
            schemaVersion: "1",
            phase: "emission",
            stepId: input.stepId,
            attempt: input.attempt,
            modelInput: input.modelInput,
            emission: next,
            verifications: [],
          },
    );
    return { projection, reservationId, next, completedEventCommitted: true };
  }

  #assertProductionModelBinding(
    input: {
      readonly workOrder: AcceptedAgentWorkOrder;
      readonly definition: AgentDefinition;
    },
    adapter: RuntimeSealedModelAdapter,
    security: Parameters<typeof validateModelCallContext>[0]["securityProfile"],
    resource: Parameters<typeof validateModelCallContext>[0]["resourceProfile"],
  ): void {
    const registration = adapter.registration;
    if (
      registration.modelAdapterRegistrationDigest !==
        input.definition.modelAdapterRegistrationDigest ||
      registration.modelSecurityProfileDigest !== input.definition.modelSecurityProfileDigest ||
      registration.modelResourceProfileDigest !== input.definition.modelResourceProfileDigest ||
      registration.modelSecurityProfileDigest !== security.modelSecurityProfileDigest ||
      registration.modelResourceProfileDigest !== resource.modelResourceProfileDigest ||
      registration.credentialSlot !== security.credentialSlot ||
      registration.endpointOrigin !== security.endpointOrigin ||
      !security.allowedTenants.includes(input.workOrder.tenant.id) ||
      !security.allowedPurposes.includes(input.workOrder.purpose.code) ||
      input.workOrder.dataClass === "highly_restricted" ||
      !security.allowedDataClasses.includes(input.workOrder.dataClass)
    ) {
      throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
        details: { reason: "model_registration_or_profile_binding_mismatch" },
      });
    }
  }

  #assertModelReservation(
    actual: ModelCallReservation,
    original: ModelCallReservation,
    status: ModelCallReservation["status"],
  ): void {
    const parsed = ModelCallReservationSchema.parse(actual);
    const { status: _actualStatus, settlement: _actualSettlement, ...actualIdentity } = parsed;
    const {
      status: _originalStatus,
      settlement: _originalSettlement,
      ...originalIdentity
    } = original;
    if (
      parsed.status !== status ||
      canonicalJsonStringify(actualIdentity) !== canonicalJsonStringify(originalIdentity)
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "model_reservation_binding_mismatch" },
      });
    }
    void _actualStatus;
    void _actualSettlement;
    void _originalStatus;
    void _originalSettlement;
  }

  async #transitionModelReservation(
    workOrder: AcceptedAgentWorkOrder,
    lease: LeaseSession,
    key: string,
    transition: (transaction: RunCommandTransaction) => Promise<void>,
  ): Promise<void> {
    lease.current = await this.#config.leaseStore.renew(
      lease.current,
      this.#config.leaseTtlMs ?? 30_000,
    );
    await this.#config.runCommandUnitOfWork.transactTransition(
      {
        schemaVersion: "1",
        tenantId: workOrder.tenant.id,
        runId: lease.current.runId,
        transitionKind: "model_call_reservation",
        transitionKey: key,
        workOrderBindingDigest: workOrder.workOrderBindingDigest,
        executionDefinitionDigest: workOrder.executionDefinitionDigest,
        leaseId: lease.current.leaseId,
        fencingToken: lease.current.fencingToken,
      },
      async (transaction) => {
        await transition(transaction);
      },
    );
  }

  async #withActiveExecution<T>(input: {
    readonly workOrder: AcceptedWorkOrder;
    readonly lease: LeaseSession;
    readonly stepId: string;
    readonly boundary: ActiveExecutionReservation["boundary"];
    readonly boundaryKey: string;
    readonly signal: AbortSignal;
    readonly repeatAfterRecoveredReservation?: boolean;
    readonly callback: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    const services = this.#config.activeExecutionServices;
    if (services === undefined) {
      return this.#withLeaseHeartbeat(input.lease, input.signal, input.callback);
    }
    if (services.transactionDomain !== this.#config.runCommandUnitOfWork.transactionDomain) {
      throw new KafError("KAF_RUNTIME_NOT_READY", {
        details: { reason: "active_execution_transaction_domain_mismatch" },
      });
    }
    const prior = await services.reader.get(
      input.workOrder.tenant.id,
      input.lease.current.runId,
      input.stepId,
      input.boundary,
      input.boundaryKey,
    );
    if (prior !== undefined) {
      if (prior.state === "reserved") {
        const settledAtServerTime = this.#config.clock.now();
        const closed = ActiveExecutionReservationSchema.parse({
          ...prior,
          state: "closed_uncertain",
          settledChargeMs: prior.maxChargeMs,
          refundedMs: 0,
          settledAtServerTime,
        });
        await this.#transitionActiveExecution(
          input.workOrder,
          input.lease,
          `close-uncertain:${prior.id}`,
          async (transaction) => {
            await transaction.putActiveExecutionReservation(
              closed,
              input.workOrder.budget.maxActiveExecutionMs,
            );
          },
        );
      }
      if (input.repeatAfterRecoveredReservation !== true) {
        throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
          details: {
            reason: "active_execution_result_unavailable",
            boundary: input.boundary,
            retryClassification: "uncertain",
          },
        });
      }
      return this.#withLeaseHeartbeat(input.lease, input.signal, input.callback);
    }
    const startedAtServerTime = this.#config.clock.now();
    const configuredMaximum = services.maximumChargeMilliseconds({
      boundary: input.boundary,
      workOrder: input.workOrder,
    });
    if (!Number.isSafeInteger(configuredMaximum) || configuredMaximum <= 0) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "activeExecution.maximumChargeMs", issue: "positive_safe_integer" },
      });
    }
    const deadlineRemaining =
      input.workOrder.deadline === undefined
        ? configuredMaximum
        : Math.max(0, Date.parse(input.workOrder.deadline) - Date.parse(startedAtServerTime));
    const maxChargeMs = Math.min(
      configuredMaximum,
      input.workOrder.budget.maxActiveExecutionMs,
      deadlineRemaining,
    );
    /* v8 ignore next -- execute's immediately preceding boundary check rejects an elapsed deadline */
    if (maxChargeMs <= 0) {
      throw new KafError("KAF_RUNTIME_TERMINAL", {
        details: { reason: "active_execution_deadline_elapsed" },
      });
    }
    const reservation = ActiveExecutionReservationSchema.parse({
      schemaVersion: "1",
      id: `active-${digestCanonicalJson({
        tenantId: input.workOrder.tenant.id,
        runId: input.lease.current.runId,
        stepId: input.stepId,
        boundary: input.boundary,
        boundaryKey: input.boundaryKey,
      }).slice("sha256:".length)}`,
      tenant: input.workOrder.tenant,
      runId: input.lease.current.runId,
      stepId: input.stepId,
      boundary: input.boundary,
      boundaryKey: input.boundaryKey,
      leaseId: input.lease.current.leaseId,
      fencingToken: input.lease.current.fencingToken,
      startedAtServerTime,
      maxChargeMs,
      state: "reserved",
      expiresAt: new Date(Date.parse(startedAtServerTime) + maxChargeMs).toISOString(),
    });
    let persistedReservation: ActiveExecutionReservation | undefined;
    await this.#transitionActiveExecution(
      input.workOrder,
      input.lease,
      `reserve:${reservation.id}`,
      async (transaction) => {
        persistedReservation = await transaction.putActiveExecutionReservation(
          reservation,
          input.workOrder.budget.maxActiveExecutionMs,
        );
      },
    );
    /* v8 ignore next -- conforming transaction stores must return the normalized reservation */
    if (persistedReservation === undefined) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "active_execution_reservation_not_returned" },
      });
    }
    const authoritativeReservation = persistedReservation;
    let result: T;
    try {
      result = await this.#withLeaseHeartbeat(input.lease, input.signal, input.callback);
    } catch (error) {
      await this.#settleActiveExecution(input.workOrder, input.lease, authoritativeReservation);
      throw error;
    }
    await this.#settleActiveExecution(input.workOrder, input.lease, authoritativeReservation);
    return result;
  }

  async #settleActiveExecution(
    workOrder: AcceptedWorkOrder,
    lease: LeaseSession,
    reservation: ActiveExecutionReservation,
  ): Promise<void> {
    const settled = ActiveExecutionReservationSchema.parse({
      ...reservation,
      state: "settled",
      settledChargeMs: 0,
      refundedMs: reservation.maxChargeMs,
      settledAtServerTime: this.#config.clock.now(),
    });
    await this.#transitionActiveExecution(
      workOrder,
      lease,
      `settle:${reservation.id}`,
      async (transaction) => {
        await transaction.putActiveExecutionReservation(
          settled,
          workOrder.budget.maxActiveExecutionMs,
        );
      },
    );
  }

  async #transitionActiveExecution(
    workOrder: AcceptedWorkOrder,
    lease: LeaseSession,
    key: string,
    transition: (transaction: RunCommandTransaction) => Promise<void>,
  ): Promise<void> {
    lease.current = await this.#config.leaseStore.renew(
      lease.current,
      this.#config.leaseTtlMs ?? 30_000,
    );
    await this.#config.runCommandUnitOfWork.transactTransition(
      {
        schemaVersion: "1",
        tenantId: workOrder.tenant.id,
        runId: lease.current.runId,
        transitionKind: "active_execution_reservation",
        transitionKey: key,
        workOrderBindingDigest: workOrder.workOrderBindingDigest,
        executionDefinitionDigest: workOrder.executionDefinitionDigest,
        leaseId: lease.current.leaseId,
        fencingToken: lease.current.fencingToken,
      },
      async (transaction) => transition(transaction),
    );
  }

  async #approvedToolCall(input: {
    readonly workOrder: AcceptedAgentWorkOrder;
    readonly projection: RunProjection;
    readonly definition: Readonly<{ policyRegistrationDigest: Digest }>;
    readonly registration: ToolRegistrationContract;
    readonly stepId: string;
    readonly argumentsDigest: Digest;
    readonly normalizedTargetDigest: Digest;
  }): Promise<Approval | undefined> {
    const store = this.#config.decisionStore;
    if (store === undefined) return undefined;
    const events = await this.#readEvents(input.workOrder.tenant.id, input.projection.runId);
    let recordedIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.eventType === "ApprovalRecorded" && event.payload.stepId === input.stepId) {
        recordedIndex = index;
        break;
      }
    }
    if (recordedIndex < 1) return undefined;
    const recorded = events[recordedIndex];
    const requested = events[recordedIndex - 1];
    if (
      recorded?.eventType !== "ApprovalRecorded" ||
      requested?.eventType !== "ApprovalRequested" ||
      requested.payload.stepId !== input.stepId ||
      requested.payload.decisionId !== recorded.payload.decisionId
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "approval_event_sequence_changed" },
      });
    }
    const gateValue = await store.getGate(
      input.workOrder.tenant.id,
      input.projection.runId,
      recorded.payload.decisionId,
    );
    const approvalValue = await store.getApproval(
      input.workOrder.tenant.id,
      recorded.payload.approvalId,
    );
    if (gateValue === undefined || approvalValue === undefined) {
      throw new KafError("KAF_STORAGE_NOT_FOUND");
    }
    const gate = DecisionGateSchema.parse(gateValue);
    const approval = ApprovalSchema.parse(approvalValue);
    if (input.workOrder.decisionOwner.mode !== "principal") {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "approval_owner_changed" },
      });
    }
    this.#assertExactBinding(
      {
        decisionId: gate.decisionId,
        tenantId: gate.tenantId,
        runId: gate.runId,
        requestingEventId: gate.requestingEventId,
        decisionGateDigest: gate.decisionGateDigest,
        binding: gate.binding,
      },
      {
        decisionId: recorded.payload.decisionId,
        tenantId: input.workOrder.tenant.id,
        runId: input.projection.runId,
        requestingEventId: requested.eventId,
        decisionGateDigest: requested.payload.decisionGateDigest,
        binding: gate.binding,
      },
      "approved_decision_gate_changed",
    );
    if (
      gate.decisionGateDigest !==
        digestCanonicalJson({
          decisionId: gate.decisionId,
          requestingEventId: gate.requestingEventId,
          binding: gate.binding,
          requiredAuthenticationStrength: gate.requiredAuthenticationStrength,
        }) ||
      requested.payload.proposedEffectDigest !== digestCanonicalJson(gate.binding)
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "approved_decision_gate_digest_changed" },
      });
    }
    const binding = gate.binding;
    this.#assertExactBinding(
      {
        schemaVersion: binding.schemaVersion,
        tenant: binding.tenant,
        principal: binding.principal,
        runId: binding.runId,
        stepId: binding.stepId,
        decisionId: binding.decisionId,
        workOrderBindingDigest: binding.workOrderBindingDigest,
        executionDefinition: binding.executionDefinition,
        executionDefinitionDigest: binding.executionDefinitionDigest,
        toolId: binding.toolId,
        toolVersion: binding.toolVersion,
        toolRegistrationDigest: binding.toolRegistrationDigest,
        argumentsDigest: binding.argumentsDigest,
        targetDigest: binding.targetDigest,
        purpose: binding.purpose,
        policyRegistrationDigest: binding.policyRegistrationDigest,
      },
      {
        schemaVersion: "1",
        tenant: input.workOrder.tenant,
        principal: input.workOrder.decisionOwner.principal,
        runId: input.projection.runId,
        stepId: input.stepId,
        decisionId: recorded.payload.decisionId,
        workOrderBindingDigest: input.workOrder.workOrderBindingDigest,
        executionDefinition: input.workOrder.executionDefinition,
        executionDefinitionDigest: input.workOrder.executionDefinitionDigest,
        toolId: input.registration.id,
        toolVersion: input.registration.implementationVersion,
        toolRegistrationDigest: input.registration.toolRegistrationDigest,
        argumentsDigest: input.argumentsDigest,
        targetDigest: input.normalizedTargetDigest,
        purpose: input.workOrder.purpose,
        policyRegistrationDigest: input.definition.policyRegistrationDigest,
      },
      "approved_effect_binding_changed",
    );
    this.#assertExactBinding(
      {
        id: approval.id,
        challengeId: approval.challengeId,
        challengeProofDigest: approval.challengeProofDigest,
        binding: approval.binding,
        maximumUses: approval.maximumUses,
      },
      {
        id: recorded.payload.approvalId,
        challengeId: approval.challengeId,
        challengeProofDigest: approval.challengeProofDigest,
        binding: gate.binding,
        maximumUses: 1,
      },
      "recorded_approval_binding_changed",
    );
    return approval;
  }

  async #claimReadApproval(input: {
    readonly workOrder: AcceptedAgentWorkOrder;
    readonly lease: LeaseSession;
    readonly approval: Approval;
    readonly stepId: string;
    readonly toolCallId: string;
    readonly argumentsDigest: Digest;
    readonly normalizedTargetDigest: Digest;
  }): Promise<void> {
    const authorizationKey = `pactmark-read:${digestCanonicalJson({
      schemaVersion: "1",
      workOrderBindingDigest: input.workOrder.workOrderBindingDigest,
      runId: input.lease.current.runId,
      stepId: input.stepId,
      toolCallId: input.toolCallId,
      argumentsDigest: input.argumentsDigest,
      normalizedTargetDigest: input.normalizedTargetDigest,
    })}`;
    input.lease.current = await this.#config.leaseStore.renew(
      input.lease.current,
      this.#config.leaseTtlMs ?? 30_000,
    );
    await this.#config.runCommandUnitOfWork.transactTransition(
      {
        schemaVersion: "1",
        tenantId: input.workOrder.tenant.id,
        runId: input.lease.current.runId,
        transitionKind: "approval_use_claim",
        transitionKey: authorizationKey,
        workOrderBindingDigest: input.workOrder.workOrderBindingDigest,
        executionDefinitionDigest: input.workOrder.executionDefinitionDigest,
        leaseId: input.lease.current.leaseId,
        fencingToken: input.lease.current.fencingToken,
      },
      async (transaction) => {
        await transaction.claimApproval(
          input.workOrder.tenant.id,
          input.approval.id,
          authorizationKey,
          this.#config.clock.now(),
        );
      },
    );
  }

  async #executeWriteEffect(input: {
    readonly workOrder: AcceptedWorkOrder;
    readonly definition: Readonly<{ policyRegistrationDigest: Digest }>;
    readonly projection: RunProjection;
    readonly lease: LeaseSession;
    readonly registration: ToolRegistrationContract;
    readonly stepId: string;
    readonly toolCallId: string;
    readonly value: JsonValue;
    readonly normalizedTargetDigest: Digest;
    readonly approval?: Approval;
    readonly signal: AbortSignal;
    readonly checkpoint?: RuntimeContextCheckpoint;
  }): Promise<
    | Readonly<{ status: "acknowledged"; projection: RunProjection; result: JsonValue }>
    | Readonly<{ status: "parked"; projection: RunProjection }>
  > {
    const services = this.#config.effectServices;
    if (services === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "effect_strategy_requires_governed_runtime" },
      });
    }
    const strategy = services.strategies.resolve(input.registration.toolRegistrationDigest);
    if (
      strategy === undefined ||
      strategy.kind !== input.registration.effectStrategyKind ||
      strategy.registrationDigest !== input.registration.effectStrategyRegistrationDigest
    ) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "executable_effect_strategy_registration_mismatch" },
      });
    }
    const argumentsDigest = digestCanonicalJson(input.value);
    const effectKey = createEffectKey({
      workOrderBindingDigest: input.workOrder.workOrderBindingDigest,
      executionDefinitionDigest: input.workOrder.executionDefinitionDigest,
      runId: input.projection.runId,
      stepId: input.stepId,
      toolCallId: input.toolCallId,
      toolRegistrationDigest: input.registration.toolRegistrationDigest,
      argumentsDigest,
      normalizedTargetDigest: input.normalizedTargetDigest,
    });
    let record = await services.store.getByEffectKey(
      input.workOrder.tenant.id,
      input.projection.runId,
      effectKey,
    );
    if (record !== undefined) {
      record = assertEffectRecordBinding(record, {
        tenantId: input.workOrder.tenant.id,
        runId: input.projection.runId,
        effectKey,
        toolRegistrationDigest: input.registration.toolRegistrationDigest,
        strategy: strategy.kind,
        strategyRegistrationDigest: strategy.registrationDigest,
        argumentsDigest,
        normalizedTargetDigest: input.normalizedTargetDigest,
      });
    }
    const effectId = record?.effectId ?? this.#config.idGenerator.generate("effect");
    const context: RuntimeEffectDispatchContext = {
      tenantId: input.workOrder.tenant.id,
      runId: input.projection.runId,
      stepId: input.stepId,
      toolCallId: input.toolCallId,
      effectId,
      effectKey,
      normalizedTargetDigest: input.normalizedTargetDigest,
      purposeCode: input.workOrder.purpose.code,
      dataClass: input.workOrder.dataClass,
      signal: input.signal,
    };
    const effectPreview = await validateEffectPreview({
      strategy,
      registration: input.registration,
      value: input.value,
      context,
      normalizedTargetDigest: input.normalizedTargetDigest,
    });
    if (input.approval !== undefined) {
      this.#assertExactBinding(
        {
          approvalId: input.approval.id,
          tenantId: input.approval.binding.tenant.id,
          runId: input.approval.binding.runId,
          stepId: input.approval.binding.stepId,
          toolRegistrationDigest: input.approval.binding.toolRegistrationDigest,
          argumentsDigest: input.approval.binding.argumentsDigest,
          targetDigest: input.approval.binding.targetDigest,
          previewDigest: input.approval.binding.previewDigest,
          contentDigest: input.approval.binding.contentDigest ?? null,
        },
        {
          approvalId: input.approval.id,
          tenantId: input.workOrder.tenant.id,
          runId: input.projection.runId,
          stepId: input.stepId,
          toolRegistrationDigest: input.registration.toolRegistrationDigest,
          argumentsDigest,
          targetDigest: input.normalizedTargetDigest,
          previewDigest: effectPreview.previewDigest,
          contentDigest: effectPreview.contentDigest,
        },
        "effect_approval_preview_changed",
      );
    }
    const operationKey =
      strategy.kind === "none"
        ? undefined
        : strategy.operationKey(input.value, {
            effectKey,
            normalizedTargetDigest: input.normalizedTargetDigest,
            toolRegistrationDigest: input.registration.toolRegistrationDigest,
          });
    if (operationKey !== undefined && operationKey.length === 0) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "effect_operation_key_empty" },
      });
    }
    if (record !== undefined && record.operationKey !== operationKey) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "effect_operation_key_changed" },
      });
    }
    let projection = input.projection;
    let dispatchAttempt = 1;

    if (record?.state === "acknowledged" || record?.state === "compensated") {
      const recovered = await services.store.getAcknowledgedResult(record);
      if (recovered !== undefined && digestCanonicalJson(recovered) === record.resultDigest) {
        return { status: "acknowledged", projection, result: strategy.validateOutput(recovered) };
      }
      projection = await this.#append(input.workOrder, projection, input.lease, "RunSuspended", {
        stepId: input.stepId,
        resumeTarget: "running",
        reasonCode: "acknowledged_effect_result_unavailable",
      });
      return { status: "parked", projection };
    }

    if (record === undefined) {
      const authorizationKey = effectKey;
      const authorizationRequest = {
        workOrder: input.workOrder,
        projection,
        registration: input.registration,
        stepId: input.stepId,
        toolCallId: input.toolCallId,
        effectId,
        effectKey,
        argumentsDigest,
        normalizedTargetDigest: input.normalizedTargetDigest,
        authorizationKey,
        policyRegistrationDigest: input.definition.policyRegistrationDigest,
        ...(input.approval === undefined ? {} : { approvalId: input.approval.id }),
      };
      const authorization = validateAuthorizationReservation({
        reservation: await services.authorization.resolve(authorizationRequest),
        request: authorizationRequest,
        now: this.#config.clock.now(),
      });
      if (
        (input.registration.security.riskClass === "R4" ||
          input.registration.security.riskClass === "R5") &&
        input.approval === undefined
      ) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
          details: { reason: "effect_approval_required" },
        });
      }
      const createdAt = this.#config.clock.now();
      const consumedAuthorization = markAuthorizationReservationConsumed({
        reservation: authorization,
        consumedAt: createdAt,
      });
      const identity = {
        schemaVersion: "1" as const,
        effectId,
        tenantId: input.workOrder.tenant.id,
        runId: projection.runId,
        stepId: input.stepId,
        toolCallId: input.toolCallId,
        effectKey,
        ...(operationKey === undefined ? {} : { operationKey }),
        executionDefinition: input.workOrder.executionDefinition,
        executionDefinitionDigest: input.workOrder.executionDefinitionDigest,
        workOrderBindingDigest: input.workOrder.workOrderBindingDigest,
        toolId: input.registration.id,
        toolVersion: input.registration.implementationVersion,
        toolRegistrationDigest: input.registration.toolRegistrationDigest,
        strategy: strategy.kind,
        strategyRegistrationDigest: strategy.registrationDigest,
        authorizationReservationId: authorization.authorizationReservationId,
        argumentsDigest,
        normalizedTargetDigest: input.normalizedTargetDigest,
        createdAt,
      };
      record = EffectRecordSchema.parse({
        ...identity,
        effectDigest: digestCanonicalJson(identity),
        updatedAt: createdAt,
        state: "prepared",
      });
      const preparedRecord = record;
      projection = await this.#append(
        input.workOrder,
        projection,
        input.lease,
        "EffectPrepared",
        {
          stepId: input.stepId,
          effectId,
          effectDigest: record.effectDigest,
          effectKey,
          strategy: strategy.kind,
        },
        undefined,
        async (transaction) => {
          await transaction.reserveCapabilityGrantUse(
            input.workOrder.tenant.id,
            authorization.grantId,
            authorization.authorizationKey,
            createdAt,
          );
          if (authorization.approvalId !== undefined) {
            await transaction.claimApproval(
              input.workOrder.tenant.id,
              authorization.approvalId,
              authorization.authorizationKey,
              createdAt,
            );
          }
          await transaction.putAuthorizationReservation(consumedAuthorization);
          await transaction.putEffectRecord(preparedRecord);
        },
      );
    }

    if (record.state === "unknown" || record.state === "needs_reconciliation") {
      projection = await this.#parkEffectForReconciliation(
        input.workOrder,
        projection,
        input.lease,
        record,
        input.stepId,
        record.state === "unknown" ? record.uncertaintyCode : "effect_outcome_unknown",
      );
      return { status: "parked", projection };
    }
    if (record.state === "abandoned") {
      throw new KafError("KAF_EFFECT_ABANDONED_UNCERTAIN");
    }

    if (record.state === "dispatched") {
      if (strategy.kind === "none" || strategy.kind === "native") {
        projection = await this.#parkEffectForReconciliation(
          input.workOrder,
          projection,
          input.lease,
          record,
          input.stepId,
          strategy.kind === "native"
            ? "native_replay_safety_unproven"
            : "dispatch_response_unavailable",
        );
        return { status: "parked", projection };
      }
      if (operationKey === undefined) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
          details: { reason: "effect_operation_key_empty" },
        });
      }
      const lookup = validateEffectLookupResult(
        await this.#withActiveExecution({
          workOrder: input.workOrder,
          lease: input.lease,
          stepId: input.stepId,
          boundary: "tool",
          boundaryKey: `${input.toolCallId}:effect-lookup`,
          signal: input.signal,
          repeatAfterRecoveredReservation: true,
          callback: (signal) => strategy.lookup(operationKey, { ...context, signal }),
        }),
      );
      if (lookup.status === "unknown") {
        projection = await this.#parkEffectForReconciliation(
          input.workOrder,
          projection,
          input.lease,
          record,
          input.stepId,
          "reconciliation_lookup_unknown",
        );
        return { status: "parked", projection };
      }
      if (lookup.status === "applied") {
        const recovered = validateEffectExecution({
          execution: lookup.execution,
          strategy,
          registration: input.registration,
          effectKey,
          operationKey,
          normalizedTargetDigest: input.normalizedTargetDigest,
        });
        if (recovered.acknowledgement.proofKind !== "lookup_recovery") {
          throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
            details: { reason: "reconciliation_lookup_proof_required" },
          });
        }
        projection = await this.#acknowledgeEffect(
          input.workOrder,
          projection,
          input.lease,
          record,
          input.stepId,
          recovered,
          input.checkpoint,
        );
        return { status: "acknowledged", projection, result: recovered.result };
      }
      const history = await this.#readEvents(input.workOrder.tenant.id, input.projection.runId);
      const priorAttempt = history.reduce(
        (maximum, event) =>
          event.eventType === "EffectDispatched" && event.payload.effectId === effectId
            ? Math.max(maximum, event.payload.attempt)
            : maximum,
        0,
      );
      dispatchAttempt = priorAttempt + 1;
      projection = await this.#append(
        input.workOrder,
        projection,
        input.lease,
        "EffectDispatched",
        { stepId: input.stepId, effectId, attempt: dispatchAttempt },
        undefined,
        undefined,
        input.checkpoint,
      );
    }

    if (record.state === "prepared") {
      const dispatchedAt = this.#config.clock.now();
      record = EffectRecordSchema.parse({
        ...this.#effectRecordBase(record, dispatchedAt),
        state: "dispatched",
        dispatchedAt,
      });
      const dispatchedRecord = record;
      projection = await this.#append(
        input.workOrder,
        projection,
        input.lease,
        "EffectDispatched",
        { stepId: input.stepId, effectId, attempt: 1 },
        undefined,
        (transaction) => transaction.putEffectRecord(dispatchedRecord),
        input.checkpoint,
      );
    }

    let acknowledged: Readonly<{
      result: JsonValue;
      acknowledgement: EffectAcknowledgement;
    }>;
    try {
      const execution = await this.#withActiveExecution({
        workOrder: input.workOrder,
        lease: input.lease,
        stepId: input.stepId,
        boundary: "tool",
        boundaryKey: `${input.toolCallId}:effect-dispatch:${String(dispatchAttempt)}`,
        signal: input.signal,
        callback: (signal) => {
          const dispatchContext = { ...context, signal };
          if (strategy.kind === "none") return strategy.dispatch(input.value, dispatchContext);
          if (operationKey === undefined) {
            throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
              details: { reason: "effect_operation_key_empty" },
            });
          }
          return strategy.dispatch(input.value, operationKey, dispatchContext);
        },
      });
      acknowledged = validateEffectExecution({
        execution,
        strategy,
        registration: input.registration,
        effectKey,
        ...(operationKey === undefined ? {} : { operationKey }),
        normalizedTargetDigest: input.normalizedTargetDigest,
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      projection = await this.#parkEffectForReconciliation(
        input.workOrder,
        projection,
        input.lease,
        record,
        input.stepId,
        error instanceof KafError ? error.code : "effect_dispatch_outcome_unknown",
      );
      return { status: "parked", projection };
    }
    projection = await this.#acknowledgeEffect(
      input.workOrder,
      projection,
      input.lease,
      record,
      input.stepId,
      acknowledged,
      input.checkpoint,
    );
    return { status: "acknowledged", projection, result: acknowledged.result };
  }

  async #acknowledgeEffect(
    workOrder: AcceptedWorkOrder,
    projection: RunProjection,
    lease: LeaseSession,
    record: EffectRecord,
    stepId: string,
    execution: Readonly<{ result: JsonValue; acknowledgement: EffectAcknowledgement }>,
    checkpoint?: RuntimeContextCheckpoint,
  ): Promise<RunProjection> {
    const updatedAt = this.#config.clock.now();
    const protectedResult = await this.#protectEffectResult(
      workOrder,
      projection.runId,
      record,
      execution,
      updatedAt,
    );
    const resultDigest = protectedResult.resultDigest;
    const acknowledged = EffectRecordSchema.parse({
      ...this.#effectRecordBase(record, updatedAt),
      state: "acknowledged",
      resultDigest,
      acknowledgement: execution.acknowledgement,
    });
    return this.#append(
      workOrder,
      projection,
      lease,
      "EffectAcknowledged",
      {
        stepId,
        effectId: record.effectId,
        resultDigest,
        acknowledgement: execution.acknowledgement,
      },
      undefined,
      async (transaction) => {
        await transaction.putEffectRecord(acknowledged);
        await transaction.putProtectedEffectResult(protectedResult);
      },
      checkpoint,
    );
  }

  async #protectEffectResult(
    workOrder: AcceptedWorkOrder,
    runId: string,
    record: EffectRecord,
    execution: Readonly<{ result: JsonValue; acknowledgement: EffectAcknowledgement }>,
    createdAt: string,
  ): Promise<ProtectedEffectResultRecord> {
    const protector = this.#config.effectResultProtector;
    if (protector === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "protected_effect_result_store_required" },
      });
    }
    /* v8 ignore next -- conforming WorkOrder stores reject this class before a run exists */
    if (workOrder.dataClass === "highly_restricted") {
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
        details: { reason: "highly_restricted_effect_result_forbidden" },
      });
    }
    const resultDigest = digestCanonicalJson(execution.result);
    const plaintext = new TextEncoder().encode(canonicalJsonStringify(execution.result));
    this.#assertJsonByteLimit(
      execution.result,
      workOrder.budget.maxToolResultContextBytesPerCall,
      "protected_effect_result",
    );
    const resultMaterial = {
      schemaVersion: "1" as const,
      tenantId: workOrder.tenant.id,
      runId,
      effectId: record.effectId,
      effectDigest: record.effectDigest,
      resultDigest,
      byteSize: plaintext.byteLength,
      workOrderId: workOrder.id,
      workOrderBindingDigest: workOrder.workOrderBindingDigest,
      executionDefinition: workOrder.executionDefinition,
      executionDefinitionDigest: workOrder.executionDefinitionDigest,
      toolId: record.toolId,
      toolVersion: record.toolVersion,
      toolRegistrationDigest: record.toolRegistrationDigest,
      strategy: record.strategy,
      strategyRegistrationDigest: record.strategyRegistrationDigest,
      resultSchemaDigest: execution.acknowledgement.resultSchemaDigest,
      purposeCode: workOrder.purpose.code,
      purposeRegistryVersion: workOrder.purpose.registryVersion,
      dataClass: workOrder.dataClass,
      createdAt,
    };
    const binding = protectedEffectResultAad(resultMaterial);
    const protectedValue = await protector.protect(binding, plaintext);
    if (protectedValue.aadDigest !== digestCanonicalJson(binding)) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "effect_result_protector_aad_mismatch" },
      });
    }
    return ProtectedEffectResultRecordSchema.parse({
      ...resultMaterial,
      protectedValue,
    });
  }

  async #parkEffectForReconciliation(
    workOrder: AcceptedWorkOrder,
    projectionInput: RunProjection,
    lease: LeaseSession,
    recordInput: EffectRecord,
    stepId: string,
    uncertaintyCode: string,
  ): Promise<RunProjection> {
    let projection = projectionInput;
    let record = recordInput;
    if (record.state === "dispatched") {
      const updatedAt = this.#config.clock.now();
      const unknown = EffectRecordSchema.parse({
        ...this.#effectRecordBase(record, updatedAt),
        state: "unknown",
        dispatchedAt: record.dispatchedAt,
        uncertaintyCode,
      });
      projection = await this.#append(
        workOrder,
        projection,
        lease,
        "EffectUncertain",
        { stepId, effectId: record.effectId, uncertaintyCode },
        undefined,
        (transaction) => transaction.putEffectRecord(unknown),
      );
      record = unknown;
    }
    if (projection.status === "running") {
      projection = await this.#append(workOrder, projection, lease, "RunSuspended", {
        stepId,
        effectId: record.effectId,
        resumeTarget: "running",
        reasonCode: "effect_needs_reconciliation",
      });
    }
    if (record.state === "unknown") {
      const updatedAt = this.#config.clock.now();
      const needsReconciliation = EffectRecordSchema.parse({
        ...this.#effectRecordBase(record, updatedAt),
        state: "needs_reconciliation",
        uncertaintyCode: record.uncertaintyCode,
        effectMayHaveOccurred: true,
      });
      projection = await this.#append(
        workOrder,
        projection,
        lease,
        "EffectNeedsReconciliation",
        { stepId, effectId: record.effectId, effectMayHaveOccurred: true },
        undefined,
        (transaction) => transaction.putEffectRecord(needsReconciliation),
      );
    }
    return projection;
  }

  async #recoverInterruptedEffect(
    workOrder: AcceptedWorkOrder,
    projection: RunProjection,
    lease: LeaseSession,
    history: readonly RunEvent[],
  ): Promise<RunProjection | undefined> {
    const latest = history.at(-1);
    if (latest?.eventType === "EffectAcknowledged") {
      const store = this.#config.effectServices?.store;
      const record = await store?.getByEffectId(
        workOrder.tenant.id,
        projection.runId,
        latest.payload.effectId,
      );
      /* v8 ignore next -- EffectAcknowledged and its acknowledged ledger write are one transaction */
      if (record?.state === "acknowledged") {
        const recovered = await store?.getAcknowledgedResult(record);
        if (
          recovered !== undefined &&
          digestCanonicalJson(recovered) === latest.payload.resultDigest &&
          digestCanonicalJson(recovered) === record.resultDigest
        ) {
          return undefined;
        }
      }
      return this.#append(workOrder, projection, lease, "RunSuspended", {
        stepId: latest.payload.stepId,
        resumeTarget: "running",
        reasonCode: "acknowledged_effect_result_unavailable",
      });
    }
    if (latest?.eventType !== "EffectDispatched" && latest?.eventType !== "EffectUncertain") {
      return undefined;
    }
    const store = this.#config.effectServices?.store;
    if (store === undefined) return undefined;
    const record = await store.getByEffectId(
      workOrder.tenant.id,
      projection.runId,
      latest.payload.effectId,
    );
    if (record === undefined) return undefined;
    if (record.strategy === "reconcilable" && record.state === "dispatched") return undefined;
    return this.#parkEffectForReconciliation(
      workOrder,
      projection,
      lease,
      record,
      latest.payload.stepId,
      latest.eventType === "EffectUncertain"
        ? latest.payload.uncertaintyCode
        : record.strategy === "native"
          ? "native_replay_safety_unproven"
          : "dispatch_response_unavailable",
    );
  }

  #effectRecordBase(record: EffectRecord, updatedAt: string) {
    return {
      schemaVersion: record.schemaVersion,
      effectId: record.effectId,
      effectDigest: record.effectDigest,
      tenantId: record.tenantId,
      runId: record.runId,
      stepId: record.stepId,
      toolCallId: record.toolCallId,
      effectKey: record.effectKey,
      ...(record.operationKey === undefined ? {} : { operationKey: record.operationKey }),
      executionDefinition: record.executionDefinition,
      executionDefinitionDigest: record.executionDefinitionDigest,
      workOrderBindingDigest: record.workOrderBindingDigest,
      toolId: record.toolId,
      toolVersion: record.toolVersion,
      toolRegistrationDigest: record.toolRegistrationDigest,
      strategy: record.strategy,
      strategyRegistrationDigest: record.strategyRegistrationDigest,
      authorizationReservationId: record.authorizationReservationId,
      argumentsDigest: record.argumentsDigest,
      normalizedTargetDigest: record.normalizedTargetDigest,
      createdAt: record.createdAt,
      updatedAt,
    };
  }

  async #finalize(
    workOrder: AcceptedWorkOrder,
    projectionInput: RunProjection,
    lease: LeaseSession,
    stepId: string,
    output: JsonValue,
    signal: AbortSignal,
    checkpointInput?: RuntimeContextCheckpoint,
  ): Promise<RuntimeExecutionResult> {
    /* v8 ignore next -- every conforming AcceptedWorkOrderStore rejects this class before a run exists */
    if (workOrder.dataClass === "highly_restricted")
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE");
    let projection = projectionInput;
    const checkpoint =
      checkpointInput === undefined
        ? undefined
        : RuntimeContextCheckpointSchema.parse(checkpointInput);
    const content = new TextEncoder().encode(canonicalJsonStringify(output));
    const contentDigest = digestBytes(content);
    let artifact = checkpoint?.artifact;
    const verifications: VerificationResult[] = [...(checkpoint?.verifications ?? [])];
    let verificationStarted = checkpoint?.verificationStarted ?? false;
    if (artifact === undefined) {
      const identityDigest = digestCanonicalJson({
        runId: projection.runId,
        stepId,
        contentDigest,
      });
      const suffix = identityDigest.slice("sha256:".length, "sha256:".length + 32);
      const artifactId = `artifact-${suffix}`;
      const artifactEventId = `event-artifact-${suffix}`;
      const artifactMaterial = {
        schemaVersion: "1" as const,
        artifactId,
        contentDigest,
        mediaType: "application/json",
        byteSize: content.byteLength,
        location: {
          kind: "inline" as const,
          encoding: "utf8" as const,
          content: new TextDecoder().decode(content),
        },
        tenantId: workOrder.tenant.id,
        producingRunId: projection.runId,
        producingStepId: stepId,
        owner: { type: "principal" as const, id: workOrder.principal.id },
        visibility: "private" as const,
        dataClass: workOrder.dataClass,
        purposeCode: workOrder.purpose.code,
        retention: this.#artifactRetention(workOrder),
        provenance: {
          schemaVersion: "1" as const,
          executionDefinition: workOrder.executionDefinition,
          executionDefinitionDigest: workOrder.executionDefinitionDigest,
          workOrderBindingDigest: workOrder.workOrderBindingDigest,
          producingEventId: artifactEventId,
          sourceArtifactDigests: [],
          toolRegistrationDigests: [],
          metadata: {},
        },
        createdAt: projection.updatedAt,
      };
      const producedArtifact = ArtifactSchema.parse({
        ...artifactMaterial,
        artifactDigest: digestCanonicalJson(artifactMaterial),
      });
      artifact = producedArtifact;
      await this.#withLeaseHeartbeat(lease, signal, () =>
        this.#config.artifactStore.put(producedArtifact, content),
      );
      projection = await this.#append(
        workOrder,
        projection,
        lease,
        "ArtifactProduced",
        {
          stepId,
          artifactId,
          artifactDigest: producedArtifact.artifactDigest,
        },
        artifactEventId,
        undefined,
        {
          schemaVersion: "1",
          phase: "verification",
          stepId,
          emission: { type: "final", value: output },
          artifact: producedArtifact,
          verificationStarted: false,
          verifications,
        },
      );
    }
    artifact = ArtifactSchema.parse(artifact);
    if (!verificationStarted) {
      projection = await this.#append(
        workOrder,
        projection,
        lease,
        "VerificationStarted",
        { stepId, artifactDigest: artifact.artifactDigest },
        undefined,
        undefined,
        {
          schemaVersion: "1",
          phase: "verification",
          stepId,
          emission: { type: "final", value: output },
          artifact,
          verificationStarted: true,
          verifications,
        },
      );
      verificationStarted = true;
    }
    for (const verifierId of projection.requiredVerifierIds) {
      if (verifications.some((verification) => verification.verifierId === verifierId)) continue;
      if (!this.#config.verifierRegistry.has(verifierId)) {
        return this.#fail(workOrder, projection, lease, stepId, "KAF_VERIFICATION_REQUIRED");
      }
      const verification = this.#validateVerificationResult(
        await this.#withActiveExecution({
          workOrder,
          lease,
          stepId,
          boundary: "verifier",
          boundaryKey: verifierId,
          signal,
          callback: (boundarySignal) =>
            this.#config.verifierRegistry.verify(verifierId, artifact, boundarySignal),
        }),
        verifierId,
        artifact,
      );
      verifications.push(verification);
      projection = await this.#append(
        workOrder,
        projection,
        lease,
        "VerificationRecorded",
        {
          stepId,
          verificationId: verification.verificationId,
          verifierId: verification.verifierId,
          status: verification.status,
          verificationDigest: verification.verificationDigest,
        },
        undefined,
        undefined,
        {
          schemaVersion: "1",
          phase: "verification",
          stepId,
          emission: { type: "final", value: output },
          artifact,
          verificationStarted,
          verifications,
        },
      );
      if (verification.status !== "pass") {
        return this.#fail(workOrder, projection, lease, stepId, "KAF_VERIFICATION_REQUIRED");
      }
    }
    const events = await this.#readEvents(workOrder.tenant.id, projection.runId);
    const evidence = this.#validateEvidenceRecord(
      await this.#withActiveExecution({
        workOrder,
        lease,
        stepId,
        boundary: "runtime_internal",
        boundaryKey: `evidence:${contentDigest}`,
        signal,
        callback: () =>
          this.#config.evidenceBuilder.build({
            run: projection,
            events,
            artifacts: [artifact],
            verifications,
          }),
      }),
      workOrder,
      projection,
      [artifact],
      events,
      verifications,
    );
    projection = await this.#append(workOrder, projection, lease, "RunCompleted", {
      stepId,
      evidenceRecordId: evidence.evidenceRecordId,
      outputDigest: contentDigest,
    });
    return { runId: projection.runId, status: "completed" };
  }

  async #fail(
    workOrder: AcceptedWorkOrder,
    projection: RunProjection,
    lease: LeaseSession,
    stepId: string,
    errorCode: KafErrorCode,
    safeDetails?: Readonly<Record<string, JsonValue>>,
  ): Promise<RuntimeExecutionResult> {
    await this.#append(workOrder, projection, lease, "RunFailed", {
      stepId,
      errorCode,
      ...(safeDetails === undefined ? {} : { safeDetails }),
    });
    return { runId: projection.runId, status: "failed" };
  }

  async #withLeaseHeartbeat<T>(
    lease: LeaseSession,
    parentSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const boundaryController = new AbortController();
    const forwardAbort = (): void => {
      boundaryController.abort(parentSignal.reason);
    };
    if (parentSignal.aborted) forwardAbort();
    else parentSignal.addEventListener("abort", forwardAbort, { once: true });

    let renewalFailure: unknown;
    let renewalInFlight: Promise<void> | undefined;
    const renew = (): Promise<void> => {
      if (renewalFailure !== undefined) return Promise.resolve();
      renewalInFlight ??= (async () => {
        try {
          lease.current = await this.#config.leaseStore.renew(
            lease.current,
            this.#config.leaseTtlMs ?? 30_000,
          );
        } catch (error) {
          renewalFailure = error;
          boundaryController.abort("lease_lost");
        } finally {
          renewalInFlight = undefined;
        }
      })();
      return renewalInFlight;
    };
    const heartbeat = globalThis.setInterval(
      () => {
        void renew();
      },
      Math.max(1, Math.floor((this.#config.leaseTtlMs ?? 30_000) / 3)),
    );
    let outcome:
      { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    try {
      outcome = { ok: true, value: await operation(boundaryController.signal) };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      globalThis.clearInterval(heartbeat);
      await renewalInFlight;
      parentSignal.removeEventListener("abort", forwardAbort);
    }
    const getRenewalFailure = (): unknown => renewalFailure;
    const firstRenewalFailure = getRenewalFailure();
    if (firstRenewalFailure !== undefined) this.#throwBoundaryError(firstRenewalFailure);
    if (!outcome.ok) this.#throwBoundaryError(outcome.error);
    await renew();
    const finalRenewalFailure = getRenewalFailure();
    if (finalRenewalFailure !== undefined) this.#throwBoundaryError(finalRenewalFailure);
    return outcome.value;
  }

  #throwBoundaryError(error: unknown): never {
    if (error instanceof Error) throw error;
    throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", { internalCause: error });
  }

  async #captureBoundaryInvocation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new RuntimeBoundaryInvocationError(error);
    }
  }

  #capturedBoundaryError(error: unknown): unknown {
    if (error instanceof RuntimeBoundaryInvocationError) return error.boundaryError;
    if (!(error instanceof KafError)) return undefined;
    const classification = error.details?.["retryClassification"];
    return classification === "aborted" ||
      classification === "timed_out" ||
      classification === "retryable" ||
      classification === "non_retryable" ||
      classification === "uncertain"
      ? error
      : undefined;
  }

  #parseModelEmission(input: unknown): RuntimeModelEmission {
    const parsed = RuntimeModelEmissionSchema.safeParse(input);
    if (!parsed.success) {
      throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
        details: { reason: "model_emission_schema_invalid" },
        internalCause: parsed.error,
      });
    }
    return parsed.data;
  }

  #validateVerificationResult(
    input: unknown,
    verifierId: string,
    artifact: Artifact,
  ): VerificationResult {
    const parsed = VerificationResultSchema.safeParse(input);
    if (!parsed.success) {
      throw new KafError("KAF_VERIFICATION_REQUIRED", {
        details: { reason: "verifier_result_invalid" },
        internalCause: parsed.error,
      });
    }
    const result = parsed.data;
    const { verificationDigest, ...material } = result;
    if (
      result.verifierId !== verifierId ||
      result.verifierRegistrationDigest !== verifierId ||
      result.artifactDigest !== artifact.artifactDigest ||
      verificationDigest !== digestCanonicalJson(material)
    ) {
      throw new KafError("KAF_VERIFICATION_REQUIRED", {
        details: { reason: "verifier_result_binding_mismatch" },
      });
    }
    return result;
  }

  #validateEvidenceRecord(
    input: unknown,
    workOrder: AcceptedWorkOrder,
    projection: RunProjection,
    artifacts: readonly Artifact[],
    events: readonly RunEvent[],
    verifications: readonly VerificationResult[],
  ): EvidenceRecord {
    const parsed = EvidenceRecordSchema.safeParse(input);
    if (!parsed.success) {
      throw new KafError("KAF_EVIDENCE_INVALID_REFERENCE", {
        details: { reason: "evidence_record_invalid" },
        internalCause: parsed.error,
      });
    }
    const evidence = parsed.data;
    const { evidenceDigest, ...material } = evidence;
    const sameReferences = (actual: readonly unknown[], expected: readonly unknown[]): boolean => {
      const canonical = (values: readonly unknown[]) =>
        values.map((value) => canonicalJsonStringify(value)).sort();
      return (
        canonicalJsonStringify(canonical(actual)) === canonicalJsonStringify(canonical(expected))
      );
    };
    const expectedArtifactRefs = artifacts.map(({ artifactId, artifactDigest }) => ({
      artifactId,
      artifactDigest,
    }));
    const expectedEventRefs = events.map(({ eventId, sequence }) => ({ eventId, sequence }));
    const expectedVerificationRefs = verifications.map(
      ({
        verificationId,
        verificationDigest,
        status,
        artifactDigest,
        verifierId,
        verifierVersion,
        verifierRegistrationDigest,
        method,
        rubricVersion,
        rubricDigest,
      }) => ({
        verificationId,
        verificationDigest,
        status,
        artifactDigest,
        verifierId,
        verifierVersion,
        verifierRegistrationDigest,
        method,
        rubricVersion,
        rubricDigest,
      }),
    );
    if (
      evidenceDigest !== digestCanonicalJson(material) ||
      evidence.tenantId !== workOrder.tenant.id ||
      evidence.runId !== projection.runId ||
      canonicalJsonStringify(evidence.executionDefinition) !==
        canonicalJsonStringify(workOrder.executionDefinition) ||
      evidence.executionDefinitionDigest !== workOrder.executionDefinitionDigest ||
      evidence.workOrderBindingDigest !== workOrder.workOrderBindingDigest ||
      !sameReferences(evidence.artifactRefs, expectedArtifactRefs) ||
      !sameReferences(evidence.eventRefs, expectedEventRefs) ||
      !sameReferences(evidence.verificationRefs, expectedVerificationRefs)
    ) {
      throw new KafError("KAF_EVIDENCE_INVALID_REFERENCE", {
        details: { reason: "evidence_record_binding_mismatch" },
      });
    }
    return evidence;
  }

  #normalizeBoundaryFailure(
    boundary: "model" | "tool",
    error: unknown,
    classification: Exclude<RuntimeBoundaryErrorClassification, "aborted" | "uncertain">,
  ): KafError {
    if (error instanceof KafError) return error;
    return new KafError(
      boundary === "model" ? "KAF_MODEL_ADAPTER_MISMATCH" : "KAF_TOOL_EXECUTION_FAILED",
      {
        details: {
          reason:
            boundary === "model"
              ? "model_call_failed_without_safe_result"
              : "tool_call_failed_without_safe_result",
          retryClassification: classification,
        },
        internalCause: error,
      },
    );
  }

  #terminalRunError(error: unknown): KafError | undefined {
    if (!(error instanceof KafError)) return undefined;
    if (TERMINAL_RUN_ERROR_CODES.has(error.code)) return error;
    if (
      error.code === "KAF_MODEL_ADAPTER_MISMATCH" &&
      typeof error.details?.["reason"] === "string" &&
      TERMINAL_MODEL_ADAPTER_REASONS.has(error.details["reason"])
    ) {
      return error;
    }
    if (
      error.code === "KAF_AUTHORIZATION_BINDING_MISMATCH" &&
      typeof error.details?.["reason"] === "string" &&
      TERMINAL_EFFECT_AUTHORIZATION_REASONS.has(error.details["reason"])
    ) {
      return error;
    }
    return undefined;
  }

  async #terminalizeExecutionFailure(
    workOrder: AcceptedWorkOrder,
    lease: LeaseSession,
    error: unknown,
  ): Promise<RuntimeExecutionResult | undefined> {
    const failure = this.#terminalRunError(error);
    if (failure === undefined) return undefined;
    const latest = await this.#config.eventStore.getProjection(
      workOrder.tenant.id,
      lease.current.runId,
    );
    if (latest === undefined) return undefined;
    if (TerminalRunStatusSchema.safeParse(latest.status).success) {
      return {
        runId: latest.runId,
        status:
          latest.status === "completed"
            ? "completed"
            : latest.status === "cancelled"
              ? "cancelled"
              : "failed",
      };
    }
    await this.#append(workOrder, latest, lease, "RunFailed", {
      ...(latest.currentStepId === null ? {} : { stepId: latest.currentStepId }),
      errorCode: failure.code,
      safeDetails: failure.details ?? {},
    });
    return { runId: latest.runId, status: "failed" };
  }

  #contextCheckpointEnabled(): boolean {
    return (
      this.#config.contextStore !== undefined &&
      this.#config.contextProtector !== undefined &&
      this.#config.contextCheckpointTransactionDomain ===
        this.#config.runCommandUnitOfWork.transactionDomain
    );
  }

  #classifyBoundaryError(
    boundary: "model" | "tool",
    error: unknown,
    registration?: ToolRegistrationContract,
  ): RuntimeBoundaryErrorClassification {
    if (error instanceof DOMException && error.name === "AbortError") return "aborted";
    if (error instanceof KafError) {
      const value = error.details?.["retryClassification"];
      if (
        value === "aborted" ||
        value === "timed_out" ||
        value === "retryable" ||
        value === "non_retryable" ||
        value === "uncertain"
      ) {
        return value;
      }
    }
    const classify =
      boundary === "model"
        ? this.#config.modelDriver.classifyError === undefined
          ? undefined
          : (failure: unknown) => this.#config.modelDriver.classifyError?.(failure) ?? "uncertain"
        : registration === undefined || this.#config.toolExecutor.classifyError === undefined
          ? undefined
          : (failure: unknown) =>
              this.#config.toolExecutor.classifyError?.(failure, registration) ?? "uncertain";
    if (classify !== undefined) return this.#safeBoundaryClassification(() => classify(error));
    if (error instanceof KafError) return error.retryable ? "retryable" : "non_retryable";
    return "uncertain";
  }

  #safeBoundaryClassification(classify: () => unknown): RuntimeBoundaryErrorClassification {
    try {
      const result = RuntimeBoundaryErrorClassificationSchema.safeParse(classify());
      return result.success ? result.data : "uncertain";
    } catch {
      return "uncertain";
    }
  }

  async #scheduleRetry(
    input: Readonly<{
      workOrder: AcceptedAgentWorkOrder;
      projection: RunProjection;
      lease: LeaseSession;
      stepId: string;
      boundary: "model" | "tool";
      boundaryKey: string;
      attempt: number;
      classification: RuntimeBoundaryErrorClassification;
      checkpoint: RuntimeContextCheckpoint;
    }>,
  ): Promise<
    Readonly<{ projection: RunProjection; checkpoint: ParsedRuntimeContextCheckpoint }> | undefined
  > {
    if (
      input.classification === "aborted" ||
      input.classification === "non_retryable" ||
      this.#config.retryPolicy === undefined
    ) {
      return undefined;
    }
    const maximumAttempts = this.#config.retryPolicy.maximumAttempts({
      boundary: input.boundary,
    });
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 100) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "retryPolicy.maximumAttempts", issue: "bounded_integer_required" },
      });
    }
    if (input.attempt >= maximumAttempts) return undefined;
    const jitter = this.#config.retryJitterSource?.next() ?? 0;
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "retryJitterSource", issue: "unit_interval_required" },
      });
    }
    const classification = input.classification;
    const delayMs = this.#config.retryPolicy.backoffMilliseconds({
      boundary: input.boundary,
      attempt: input.attempt,
      classification,
      jitter,
    });
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 86_400_000) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "retryPolicy.backoffMilliseconds", issue: "bounded_integer_required" },
      });
    }
    const now = Date.parse(this.#config.clock.now());
    const notBefore = new Date(now + delayMs).toISOString();
    if (
      input.workOrder.deadline !== undefined &&
      Date.parse(notBefore) >= Date.parse(input.workOrder.deadline)
    ) {
      return undefined;
    }
    const nextAttempt = input.attempt + 1;
    const checkpoint = RuntimeContextCheckpointSchema.parse({
      ...input.checkpoint,
      phase: "scheduled_backoff",
      attempt: input.attempt,
      retryBoundary: input.boundary,
      retryClassification: classification,
      nextAttempt,
      notBefore,
      delayMs,
      resumePhase: input.boundary,
    });
    const projection = await this.#append(
      input.workOrder,
      input.projection,
      input.lease,
      "RetryScheduled",
      {
        stepId: input.stepId,
        boundary: input.boundary,
        boundaryKey: input.boundaryKey,
        attempt: input.attempt,
        nextAttempt,
        classification,
        delayMs,
        notBefore,
      },
      undefined,
      undefined,
      checkpoint,
    );
    return { projection, checkpoint };
  }

  async #loadSubmittedInput(
    workOrder: AcceptedAgentWorkOrder,
    projection: RunProjection,
    checkpoint: ParsedRuntimeContextCheckpoint,
    history: readonly RunEvent[],
  ): Promise<JsonValue> {
    const store = this.#config.inputSubmissionStore;
    const protector = this.#config.inputProtector;
    const registry = this.#config.typedInputRegistry;
    if (
      store === undefined ||
      protector === undefined ||
      registry === undefined ||
      checkpoint.stepId === undefined ||
      checkpoint.requestId === undefined ||
      checkpoint.inputSchemaDigest === undefined ||
      checkpoint.emission?.type !== "input_request"
    ) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { requiredCapability: "typedInput" },
      });
    }
    const submitted = history.at(-1);
    if (
      submitted?.eventType !== "InputSubmitted" ||
      submitted.payload.stepId !== checkpoint.stepId ||
      submitted.payload.requestId !== checkpoint.requestId ||
      submitted.payload.inputSchemaDigest !== checkpoint.inputSchemaDigest
    ) {
      throw new KafError("KAF_RUNTIME_EVENT_BINDING", {
        details: { reason: "input_submission_event_changed" },
      });
    }
    const recordValue = await store.get(
      workOrder.tenant.id,
      projection.runId,
      checkpoint.requestId,
    );
    /* v8 ignore next -- InputSubmitted and its protected record commit atomically */
    if (recordValue === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    const record = InputSubmissionRecordSchema.parse(recordValue);
    this.#assertExactBinding(
      {
        tenantId: record.tenantId,
        runId: record.runId,
        requestId: record.requestId,
        requestingStepId: record.requestingStepId,
        requestingEventId: record.requestingEventId,
        executionDefinition: record.executionDefinition,
        executionDefinitionDigest: record.executionDefinitionDigest,
        workOrderBindingDigest: record.workOrderBindingDigest,
        inputSchemaDigest: record.inputSchemaDigest,
        valueDigest: record.valueDigest,
        inputSubmissionRecordId: record.inputSubmissionRecordId,
      },
      {
        tenantId: workOrder.tenant.id,
        runId: projection.runId,
        requestId: checkpoint.requestId,
        requestingStepId: checkpoint.stepId,
        requestingEventId: history.at(-2)?.eventId,
        executionDefinition: workOrder.executionDefinition,
        executionDefinitionDigest: workOrder.executionDefinitionDigest,
        workOrderBindingDigest: workOrder.workOrderBindingDigest,
        inputSchemaDigest: checkpoint.inputSchemaDigest,
        valueDigest: submitted.payload.valueDigest,
        inputSubmissionRecordId: submitted.payload.inputSubmissionRecordId,
      },
      "input_submission_binding_changed",
    );
    const binding = {
      tenantId: record.tenantId,
      runId: record.runId,
      requestId: record.requestId,
      recordId: record.inputSubmissionRecordId,
      workOrderBindingDigest: record.workOrderBindingDigest,
      inputSchemaDigest: record.inputSchemaDigest,
      valueDigest: record.valueDigest,
      commandId: record.consumingCommandId,
    };
    if (record.protectedValue.aadDigest !== digestCanonicalJson(binding)) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "input_submission_aad_changed" },
      });
    }
    const plaintext = await protector.unprotect(binding, record.protectedValue);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    } catch (internalCause) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", { internalCause });
    }
    const value = JsonValueSchema.parse(raw);
    const validated = TypedInputValidationResultSchema.parse(
      registry.validate(checkpoint.inputSchemaDigest, value),
    );
    if (
      validated.inputSchemaDigest !== checkpoint.inputSchemaDigest ||
      digestCanonicalJson(validated.value) !== record.valueDigest
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "input_submission_schema_or_digest_changed" },
      });
    }
    const nextInput: JsonValue = {
      goal: workOrder.goal,
      input: workOrder.input,
      submittedInput: validated.value,
      inputRequestId: checkpoint.requestId,
    };
    this.#assertJsonByteLimit(
      nextInput,
      workOrder.budget.maxModelInputBytesPerCall,
      "submitted_input_to_model",
    );
    return nextInput;
  }

  #contextBinding(
    snapshot: Omit<ContextSnapshot, "protectedValue"> | ContextSnapshot,
  ): Readonly<Record<string, string>> {
    return {
      tenantId: snapshot.tenantId,
      recordId: snapshot.snapshotId,
      storeKind: "context",
      schemaVersion: snapshot.schemaVersion,
      purposeCode: snapshot.purposeCode,
      purposeRegistryVersion: snapshot.purposeRegistryVersion,
      dataClass: snapshot.dataClass,
      runId: snapshot.runId,
      stepId: snapshot.stepId,
      sequence: String(snapshot.sequence),
      executionDefinitionDigest: snapshot.executionDefinitionDigest,
      workOrderBindingDigest: snapshot.workOrderBindingDigest,
      contextSchemaDigest: snapshot.contextSchemaDigest,
      contextDigest: snapshot.contextDigest,
    };
  }

  async #createContextSnapshot(
    workOrder: AcceptedWorkOrder,
    event: RunEvent,
    checkpointInput: RuntimeContextCheckpoint,
  ): Promise<ContextSnapshot | undefined> {
    if (!this.#contextCheckpointEnabled()) return undefined;
    const protector = this.#config.contextProtector;
    if (protector === undefined) return undefined;
    const checkpoint = RuntimeContextCheckpointSchema.parse(checkpointInput);
    if (checkpoint.stepId === undefined) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "context.stepId", issue: "required" },
      });
    }
    const plaintext = new TextEncoder().encode(canonicalJsonStringify(checkpoint));
    if (
      workOrder.budget.maxContextSnapshotBytes !== undefined &&
      plaintext.byteLength > workOrder.budget.maxContextSnapshotBytes
    ) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "context_snapshot_budget_exhausted" },
      });
    }
    const contextDigest = digestBytes(plaintext);
    const snapshotId = `context-${event.eventId}`;
    const retention = this.#artifactRetention(workOrder);
    const material = {
      schemaVersion: "1" as const,
      snapshotId,
      tenantId: workOrder.tenant.id,
      runId: event.runId,
      sequence: event.sequence,
      stepId: checkpoint.stepId,
      executionDefinition: workOrder.executionDefinition,
      executionDefinitionDigest: workOrder.executionDefinitionDigest,
      workOrderBindingDigest: workOrder.workOrderBindingDigest,
      contextSchemaDigest: RUNTIME_CONTEXT_SCHEMA_DIGEST,
      contextDigest,
      byteSize: plaintext.byteLength,
      purposeCode: workOrder.purpose.code,
      purposeRegistryVersion: workOrder.purpose.registryVersion,
      dataClass: workOrder.dataClass,
      retention,
      createdAt: event.occurredAt,
      ...(retention.mode === "until" ? { expiresAt: retention.expiresAt } : {}),
    };
    const binding = this.#contextBinding(material as Omit<ContextSnapshot, "protectedValue">);
    const protectedValue = await protector.protect(binding, plaintext);
    if (protectedValue.aadDigest !== digestCanonicalJson(binding)) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "context_protector_aad_mismatch" },
      });
    }
    return ContextSnapshotSchema.parse({ ...material, protectedValue });
  }

  async #loadContextCheckpoint(
    workOrder: AcceptedWorkOrder,
    projection: RunProjection,
  ): Promise<ParsedRuntimeContextCheckpoint | undefined> {
    if (!this.#contextCheckpointEnabled()) return undefined;
    const store = this.#config.contextStore;
    const protector = this.#config.contextProtector;
    if (store === undefined || protector === undefined) return undefined;
    const snapshotValue = await store.getLatest(workOrder.tenant.id, projection.runId);
    if (snapshotValue === undefined) return undefined;
    const snapshot = ContextSnapshotSchema.parse(snapshotValue);
    if (
      snapshot.tenantId !== workOrder.tenant.id ||
      snapshot.runId !== projection.runId ||
      snapshot.sequence > projection.lastSequence ||
      snapshot.executionDefinitionDigest !== workOrder.executionDefinitionDigest ||
      snapshot.workOrderBindingDigest !== workOrder.workOrderBindingDigest ||
      projection.executionDefinitionDigest !== workOrder.executionDefinitionDigest ||
      projection.workOrderBindingDigest !== workOrder.workOrderBindingDigest ||
      snapshot.contextSchemaDigest !== RUNTIME_CONTEXT_SCHEMA_DIGEST ||
      canonicalJsonStringify(snapshot.executionDefinition) !==
        canonicalJsonStringify(workOrder.executionDefinition)
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "context_checkpoint_binding_changed" },
      });
    }
    const binding = this.#contextBinding(snapshot);
    if (snapshot.protectedValue.aadDigest !== digestCanonicalJson(binding)) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "context_checkpoint_aad_changed" },
      });
    }
    const plaintext = await protector.unprotect(binding, snapshot.protectedValue);
    if (
      plaintext.byteLength !== snapshot.byteSize ||
      digestBytes(plaintext) !== snapshot.contextDigest
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "context_checkpoint_payload_changed" },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    } catch (internalCause) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", { internalCause });
    }
    const checkpoint = RuntimeContextCheckpointSchema.parse(parsed);
    await this.#assertContextCheckpointSuffix(workOrder, projection, snapshot, checkpoint);
    if (
      checkpoint.stepId !== snapshot.stepId ||
      (projection.currentStepId !== null && checkpoint.stepId !== projection.currentStepId)
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "context_checkpoint_step_changed" },
      });
    }
    return checkpoint;
  }

  async #assertContextCheckpointSuffix(
    workOrder: AcceptedWorkOrder,
    projection: RunProjection,
    snapshot: ContextSnapshot,
    checkpoint: ParsedRuntimeContextCheckpoint,
  ): Promise<void> {
    if (snapshot.sequence === projection.lastSequence) return;
    const suffix = (await this.#readEvents(workOrder.tenant.id, projection.runId)).filter(
      (event) => event.sequence > snapshot.sequence,
    );
    const requested = suffix[0];
    const recorded = suffix[1];
    const safeApprovalSuffix =
      checkpoint.phase === "tool" &&
      checkpoint.stepId !== undefined &&
      suffix.length === 2 &&
      requested?.sequence === snapshot.sequence + 1 &&
      requested.eventType === "ApprovalRequested" &&
      recorded?.sequence === snapshot.sequence + 2 &&
      recorded.eventType === "ApprovalRecorded" &&
      projection.lastEventId === recorded.eventId &&
      projection.status === "running" &&
      requested.executionDefinitionDigest === workOrder.executionDefinitionDigest &&
      recorded.executionDefinitionDigest === workOrder.executionDefinitionDigest &&
      requested.payload.stepId === checkpoint.stepId &&
      recorded.payload.stepId === checkpoint.stepId &&
      requested.payload.decisionId === recorded.payload.decisionId &&
      recorded.payload.resumeTarget === "running";
    const inputSubmitted = suffix[0];
    const safeInputSuffix =
      checkpoint.phase === "input" &&
      checkpoint.stepId !== undefined &&
      checkpoint.requestId !== undefined &&
      checkpoint.inputSchemaDigest !== undefined &&
      suffix.length === 1 &&
      inputSubmitted?.sequence === snapshot.sequence + 1 &&
      inputSubmitted.eventType === "InputSubmitted" &&
      projection.lastEventId === inputSubmitted.eventId &&
      projection.status === "planning" &&
      inputSubmitted.executionDefinitionDigest === workOrder.executionDefinitionDigest &&
      inputSubmitted.payload.stepId === checkpoint.stepId &&
      inputSubmitted.payload.requestId === checkpoint.requestId &&
      inputSubmitted.payload.inputSchemaDigest === checkpoint.inputSchemaDigest;
    if (!safeApprovalSuffix && !safeInputSuffix) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "context_checkpoint_suffix_invalid" },
      });
    }
  }

  async #append(
    workOrder: AcceptedWorkOrder,
    projection: RunProjection,
    lease: LeaseSession,
    eventType: RunEvent["eventType"],
    payload: unknown,
    eventId?: string,
    commit?: (transaction: RunCommandTransaction) => Promise<void>,
    checkpoint?: RuntimeContextCheckpoint,
  ): Promise<RunProjection> {
    lease.current = await this.#config.leaseStore.renew(
      lease.current,
      this.#config.leaseTtlMs ?? 30_000,
    );
    const event = this.#event(
      workOrder,
      projection.runId,
      projection.lastSequence + 1,
      eventType,
      payload,
      eventId,
    );
    const next = reduceRunEvent(projection, event);
    const snapshot =
      checkpoint === undefined
        ? undefined
        : await this.#createContextSnapshot(workOrder, event, checkpoint);
    return this.#config.runCommandUnitOfWork.transactTransition(
      {
        schemaVersion: "1",
        tenantId: workOrder.tenant.id,
        runId: projection.runId,
        transitionKind: eventType,
        transitionKey: event.eventId,
        workOrderBindingDigest: workOrder.workOrderBindingDigest,
        executionDefinitionDigest: workOrder.executionDefinitionDigest,
        leaseId: lease.current.leaseId,
        fencingToken: lease.current.fencingToken,
      },
      async (transaction) => {
        await commit?.(transaction);
        if (snapshot !== undefined) await transaction.putContextSnapshot(snapshot);
        await transaction.appendRunEvent(event);
        await transaction.putRunProjection(next);
        return next;
      },
    );
  }

  #event(
    workOrder: AcceptedWorkOrder,
    runId: string,
    sequence: number,
    eventType: RunEvent["eventType"],
    payload: unknown,
    eventId?: string,
  ): RunEvent {
    return RunEventSchema.parse({
      schemaVersion: "1",
      eventId:
        eventId ??
        `event-${digestCanonicalJson({ tenantId: workOrder.tenant.id, runId, sequence, eventType }).slice("sha256:".length, 39)}`,
      runId,
      sequence,
      occurredAt: this.#config.clock.now(),
      correlationId: workOrder.correlationId ?? runId,
      tenantId: workOrder.tenant.id,
      dataClass: workOrder.dataClass,
      executionDefinition: workOrder.executionDefinition,
      executionDefinitionDigest: workOrder.executionDefinitionDigest,
      eventType,
      payload,
    });
  }

  #verifyAuthority(
    authority: AuthorityContext,
    requirement:
      | Readonly<{ kind: "unscoped_only"; operation: string }>
      | Readonly<{ kind: "run"; operation: string; runId: string }>,
  ) {
    const verification = this.#config.authorityIssuer.verify(
      authority,
      new Date(this.#config.clock.now()),
    );
    if (!verification.valid) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: verification.reason },
      });
    }
    const runScope = verification.claims.runScope;
    if (runScope !== undefined) {
      if (requirement.kind === "unscoped_only") {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
          details: { reason: "run_scope_cannot_create_run", operation: requirement.operation },
        });
      }
      if (runScope.runId !== requirement.runId) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
          details: { reason: "run_scope_mismatch", operation: requirement.operation },
        });
      }
      if (
        verification.claims.actor.type === "system_worker" &&
        !DELEGATED_WORKER_RUN_OPERATIONS.has(requirement.operation)
      ) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
          details: { reason: "run_scope_operation_denied", operation: requirement.operation },
        });
      }
    }
    return verification.claims;
  }

  async #assertAuthorityStoredRunScope(claims: VerifiedAuthority, runId: string): Promise<void> {
    if (claims.runScope === undefined) return;
    const projection = await this.#config.eventStore.getProjection(claims.tenant.id, runId);
    if (projection === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    this.#assertAuthorityWorkOrderScope(claims, runId, projection.workOrderId);
  }

  #assertAuthorityWorkOrderScope(
    claims: VerifiedAuthority,
    runId: string,
    workOrderId: string,
  ): void {
    const runScope = claims.runScope;
    if (
      runScope !== undefined &&
      (runScope.runId !== runId || runScope.workOrderId !== workOrderId)
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "run_scope_mismatch", operation: "run.load" },
      });
    }
  }

  #assertCommand(command: CommandContext, operation: string, payload: unknown): void {
    if (command.operation !== operation || command.requestDigest !== digestCanonicalJson(payload)) {
      throw new KafError("KAF_HTTP_IDEMPOTENCY_CONFLICT");
    }
  }

  #assertCommandResourceScope(command: CommandContext, expectedValues: readonly string[]): void {
    const values = command.normalizedResourceScope.map((scope) => scope.value);
    this.#assertExactBinding(values, expectedValues, "command_resource_scope_mismatch");
  }

  async #decideApprove(
    authority: AuthorityContext,
    runId: string,
    decision: DecisionApprovalSubmission,
    command: CommandContext,
  ): Promise<Readonly<{ approvalId: string; runId: string; automaticResume: boolean }>> {
    const claims = this.#verifyAuthority(authority, {
      kind: "run",
      operation: "run.approve",
      runId,
    });
    await this.#assertAuthorityStoredRunScope(claims, runId);
    this.#assertCommand(command, "run.approve", decision);
    this.#assertCommandResourceScope(command, [runId, decision.decisionId]);
    this.#assertCommandWindow(command);
    const result = await this.#config.runCommandUnitOfWork.transactCommand(
      this.#commandScope(claims, command),
      command,
      async (transaction) => {
        const { issuer, projection, gate, challenge } = await this.#decisionContext(
          authority,
          claims,
          runId,
          decision.decisionId,
          decision.challengeProof,
        );
        const verified = DecisionSubmissionChallengeSchema.parse(
          await issuer.verify(authority, decision.challengeProof, gate.binding, command),
        );
        if (canonicalJsonStringify(verified) !== canonicalJsonStringify(challenge)) {
          throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
            details: { reason: "decision_challenge_verification_mismatch" },
          });
        }
        const approval = ApprovalSchema.parse(
          await issuer.createApproval(authority, verified, command),
        );
        const now = this.#config.clock.now();
        const maximumExpiry = Date.parse(now) + (this.#config.approvalTtlMs ?? 300_000);
        this.#assertExactBinding(
          {
            challengeId: approval.challengeId,
            challengeProofDigest: approval.challengeProofDigest,
            binding: approval.binding,
            approvedBy: approval.approvedBy,
            authenticationStrength: approval.authenticationStrength,
          },
          {
            challengeId: challenge.id,
            challengeProofDigest: challenge.proofDigest,
            binding: gate.binding,
            approvedBy: claims.actor,
            authenticationStrength: claims.authenticationStrength,
          },
          "approval_binding_mismatch",
        );
        if (
          Date.parse(approval.createdAt) < Date.parse(challenge.issuedAt) ||
          Date.parse(approval.createdAt) > Date.parse(now) ||
          Date.parse(approval.expiresAt) <= Date.parse(now) ||
          Date.parse(approval.expiresAt) > maximumExpiry
        ) {
          throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
            details: { reason: "approval_binding_mismatch" },
          });
        }
        const workOrder = await this.#loadWorkOrder(claims.tenant.id, projection.workOrderId);
        const event = this.#event(
          workOrder,
          runId,
          projection.lastSequence + 1,
          "ApprovalRecorded",
          {
            stepId: gate.binding.stepId,
            decisionId: decision.decisionId,
            approvalId: approval.id,
            resumeTarget: "running",
          },
        );
        const next = reduceRunEvent(projection, event);
        const automaticResume = this.#canCommitAutomaticWakeup();
        const response = { approvalId: approval.id, runId, automaticResume };
        await transaction.consumeDecisionChallenge(
          claims.tenant.id,
          challenge.id,
          command.commandId,
          now,
        );
        await transaction.putApproval(approval);
        await transaction.appendRunEvent(event);
        await transaction.putRunProjection(next);
        await this.#recordCommand(transaction, claims, command, response);
        if (automaticResume)
          await this.#enqueueCommandWakeup(
            transaction,
            claims.tenant.id,
            runId,
            command,
            "decision_recorded",
          );
        return response;
      },
    );
    return result.value;
  }

  async #decideReject(
    authority: AuthorityContext,
    runId: string,
    decision: DecisionRejectionSubmission,
    command: CommandContext,
  ): Promise<Readonly<{ decisionId: string; runId: string; automaticResume: boolean }>> {
    const claims = this.#verifyAuthority(authority, {
      kind: "run",
      operation: "run.reject",
      runId,
    });
    await this.#assertAuthorityStoredRunScope(claims, runId);
    this.#assertCommand(command, "run.reject", decision);
    this.#assertCommandResourceScope(command, [runId, decision.decisionId]);
    this.#assertCommandWindow(command);
    const result = await this.#config.runCommandUnitOfWork.transactCommand(
      this.#commandScope(claims, command),
      command,
      async (transaction) => {
        const { issuer, projection, gate, challenge } = await this.#decisionContext(
          authority,
          claims,
          runId,
          decision.decisionId,
          decision.challengeProof,
        );
        const verified = DecisionSubmissionChallengeSchema.parse(
          await issuer.verify(authority, decision.challengeProof, gate.binding, command),
        );
        if (canonicalJsonStringify(verified) !== canonicalJsonStringify(challenge)) {
          throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
            details: { reason: "decision_challenge_verification_mismatch" },
          });
        }
        const now = this.#config.clock.now();
        const rejection = DecisionRejectionSchema.parse({
          schemaVersion: "1",
          decisionId: decision.decisionId,
          tenantId: claims.tenant.id,
          runId,
          challengeId: challenge.id,
          binding: gate.binding,
          rejectedBy: claims.actor,
          authenticationStrength: claims.authenticationStrength,
          reasonCode: decision.reasonCode,
          rejectedAt: now,
        });
        const workOrder = await this.#loadWorkOrder(claims.tenant.id, projection.workOrderId);
        const event = this.#event(
          workOrder,
          runId,
          projection.lastSequence + 1,
          "ApprovalRejected",
          {
            stepId: gate.binding.stepId,
            decisionId: decision.decisionId,
            nextStatus: "failed",
            reasonCode: decision.reasonCode,
          },
        );
        const next = reduceRunEvent(projection, event);
        const automaticResume = this.#canCommitAutomaticWakeup();
        const response = { decisionId: decision.decisionId, runId, automaticResume };
        await transaction.consumeDecisionChallenge(
          claims.tenant.id,
          challenge.id,
          command.commandId,
          now,
        );
        await transaction.putDecisionRejection(rejection);
        await transaction.appendRunEvent(event);
        await transaction.putRunProjection(next);
        await this.#recordCommand(transaction, claims, command, response);
        if (automaticResume)
          await this.#enqueueCommandWakeup(
            transaction,
            claims.tenant.id,
            runId,
            command,
            "decision_recorded",
          );
        return response;
      },
    );
    return result.value;
  }

  async #decisionContext(
    authority: AuthorityContext,
    claims: VerifiedAuthority,
    runId: string,
    decisionId: string,
    challengeProof: string,
  ) {
    const store = this.#config.decisionStore;
    const issuer = this.#config.decisionChallengeIssuer;
    if (store === undefined || issuer === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { requiredCapability: "humanDecisions" },
      });
    }
    const projection = await this.getRun(authority, runId);
    if (
      projection.status !== "waiting_for_approval" ||
      projection.waitingDecisionId !== decisionId
    ) {
      throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
        details: { reason: "run_not_waiting_for_exact_decision" },
      });
    }
    const gate = await store.getGate(claims.tenant.id, runId, decisionId);
    const challenge = await store.getActiveChallenge(claims.tenant.id, runId, decisionId);
    if (gate === undefined || challenge === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    this.#assertDecisionGateAuthority(gate, claims, projection);
    const now = Date.parse(this.#config.clock.now());
    this.#assertExactBinding(
      {
        consumingCommandId: challenge.consumingCommandId ?? null,
        proofDigest: challenge.proofDigest,
        binding: challenge.binding,
      },
      {
        consumingCommandId: null,
        proofDigest: digestBytes(new TextEncoder().encode(challengeProof)),
        binding: gate.binding,
      },
      "decision_challenge_invalid",
    );
    if (now >= Date.parse(challenge.expiresAt)) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "decision_challenge_invalid" },
      });
    }
    this.#assertAuthenticationStrength(
      claims.authenticationStrength,
      challenge.requiredAuthenticationStrength,
    );
    if (
      challenge.requiredAuthenticationStrength === "user_presence" &&
      now - Date.parse(claims.authenticatedAt) >
        (this.#config.freshAuthenticationMaximumAgeMs ?? 300_000)
    ) {
      throw new KafError("KAF_AUTHORIZATION_EXPIRED", {
        details: { reason: "fresh_authentication_required" },
      });
    }
    return { store, issuer, projection, gate, challenge };
  }

  #assertDecisionGateAuthority(
    gate: DecisionGate,
    claims: VerifiedAuthority,
    projection: RunProjection,
  ): void {
    this.#assertExactBinding(
      {
        tenantId: gate.tenantId,
        runId: gate.runId,
        bindingTenantId: gate.binding.tenant.id,
        principal: gate.binding.principal,
        workOrderBindingDigest: gate.binding.workOrderBindingDigest,
        executionDefinitionDigest: gate.binding.executionDefinitionDigest,
        decisionGateDigest: gate.decisionGateDigest,
      },
      {
        tenantId: claims.tenant.id,
        runId: projection.runId,
        bindingTenantId: claims.tenant.id,
        principal: claims.actor,
        workOrderBindingDigest: projection.workOrderBindingDigest,
        executionDefinitionDigest: projection.executionDefinitionDigest,
        decisionGateDigest: digestCanonicalJson({
          decisionId: gate.decisionId,
          requestingEventId: gate.requestingEventId,
          binding: gate.binding,
          requiredAuthenticationStrength: gate.requiredAuthenticationStrength,
        }),
      },
      "decision_gate_binding_mismatch",
    );
  }

  #assertExactBinding(
    actual: unknown,
    expected: unknown,
    reason: string,
    code:
      | "KAF_AUTHORIZATION_BINDING_MISMATCH"
      | "KAF_HTTP_IDEMPOTENCY_CONFLICT" = "KAF_AUTHORIZATION_BINDING_MISMATCH",
  ): void {
    if (canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) {
      throw new KafError(code, { details: { reason } });
    }
  }

  #assertAuthenticationStrength(
    actual: VerifiedAuthority["authenticationStrength"],
    required: VerifiedAuthority["authenticationStrength"],
  ): void {
    const rank = {
      single_factor: 0,
      multi_factor: 1,
      phishing_resistant: 2,
      user_presence: 3,
    } as const;
    if (rank[actual] < rank[required]) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "authentication_strength_insufficient" },
      });
    }
  }

  #canCommitAutomaticWakeup(): boolean {
    return (
      this.#config.wakeupScheduler?.capabilities.backgroundWakeup === true &&
      this.#config.wakeupScheduler.capabilities.atomicCommandAndWakeup &&
      this.#config.runCommandUnitOfWork.atomicCommandAndWakeup
    );
  }

  async #enqueueCommandWakeup(
    transaction: RunCommandTransaction,
    tenantId: string,
    runId: string,
    command: CommandContext,
    reason: "input_submitted" | "decision_recorded",
  ): Promise<void> {
    await transaction.enqueueWakeup({
      schemaVersion: "1",
      tenantId,
      runId,
      reason,
      notBefore: this.#config.clock.now(),
      deduplicationKey: command.commandId,
      payload: {},
    });
  }

  async #findEvent(
    tenantId: string,
    runId: string,
    eventId: string | null,
  ): Promise<RunEvent | undefined> {
    if (eventId === null) return undefined;
    for await (const event of this.#config.eventStore.read(tenantId, runId)) {
      if (event.eventId === eventId) return event;
    }
    return undefined;
  }

  #assertBoundary(
    workOrder: AcceptedWorkOrder,
    signal: AbortSignal,
    usage: Readonly<{
      dispatch: "turn" | "model" | "tool" | "internal";
      turns: number;
      modelCalls: number;
      toolCalls: number;
      activeExecutionMs: number;
    }>,
  ): void {
    if (signal.aborted) throw new DOMException("Run aborted", "AbortError");
    if (
      workOrder.deadline !== undefined &&
      Date.parse(this.#config.clock.now()) >= Date.parse(workOrder.deadline)
    ) {
      throw new KafError("KAF_RUNTIME_TERMINAL", { details: { reason: "deadline_elapsed" } });
    }
    const exhausted =
      (usage.dispatch === "turn" && usage.turns >= workOrder.budget.maxTurns) ||
      (usage.dispatch === "model" && usage.modelCalls >= workOrder.budget.maxModelCalls) ||
      (usage.dispatch === "tool" && usage.toolCalls >= workOrder.budget.maxToolCalls) ||
      usage.activeExecutionMs >= workOrder.budget.maxActiveExecutionMs;
    if (exhausted) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "budget_exhausted", boundary: usage.dispatch },
      });
    }
  }

  #assertJsonByteLimit(value: JsonValue, limit: number | undefined, category: string): void {
    if (limit === undefined) return;
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > limit) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { reason: "byte_limit_exceeded", category, bytes, limit },
      });
    }
  }

  #toolCallCounts(events: readonly RunEvent[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const event of events) {
      if (event.eventType !== "ToolCallRequested") continue;
      const digest = event.payload.toolRegistrationDigest;
      counts.set(digest, (counts.get(digest) ?? 0) + 1);
    }
    return counts;
  }

  #persistedActiveExecutionMs(events: readonly RunEvent[]): number {
    const modelStarts = new Map<string, number>();
    const toolStarts = new Map<string, number>();
    let total = 0;
    for (const event of events) {
      const at = Date.parse(event.occurredAt);
      if (event.eventType === "ModelCallStarted") {
        modelStarts.set(event.payload.modelCallReservationId, at);
      } else if (event.eventType === "ModelCallCompleted") {
        const started = modelStarts.get(event.payload.modelCallReservationId);
        if (started !== undefined) total += Math.max(0, at - started);
      } else if (event.eventType === "ToolCallRequested") {
        toolStarts.set(event.payload.toolCallId, at);
      } else if (event.eventType === "ToolCallCompleted") {
        const started = toolStarts.get(event.payload.toolCallId);
        if (started !== undefined) total += Math.max(0, at - started);
      }
    }
    return total;
  }

  async #loadWorkOrder(tenantId: string, workOrderId: string): Promise<AcceptedAgentWorkOrder> {
    const workOrder = await this.#loadAcceptedWorkOrder(tenantId, workOrderId);
    if (workOrder.kind !== "agent") throw new KafError("KAF_STORAGE_NOT_FOUND");
    return workOrder;
  }

  async #loadAcceptedWorkOrder(tenantId: string, workOrderId: string): Promise<AcceptedWorkOrder> {
    const workOrder = await this.#config.acceptedWorkOrderStore.get(tenantId, workOrderId);
    if (workOrder === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    return workOrder;
  }

  async #readEvents(tenantId: string, runId: string): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    for await (const event of this.#config.eventStore.read(tenantId, runId)) events.push(event);
    return events;
  }

  #assertCommandWindow(command: CommandContext): void {
    const result = validateCommandIdWindow(command.commandId, {
      now: new Date(this.#config.clock.now()),
      maximumFutureSkewMs: this.#config.commandMaximumFutureSkewMs ?? 300_000,
      idempotencyHorizonMs: this.#config.commandIdempotencyHorizonMs ?? 86_400_000,
    });
    if (!result.valid) {
      const code =
        result.code === "KAF_COMMAND_IDEMPOTENCY_EXPIRED"
          ? "KAF_COMMAND_IDEMPOTENCY_EXPIRED"
          : "KAF_HTTP_IDEMPOTENCY_CONFLICT";
      throw new KafError(code, { details: { reason: result.code } });
    }
  }

  async #recordCommand(
    transaction: RunCommandTransaction,
    claims: VerifiedAuthority,
    command: CommandContext,
    safeResult: unknown,
  ): Promise<CommandRecord> {
    const now = this.#config.clock.now();
    const horizon = this.#config.commandIdempotencyHorizonMs ?? 86_400_000;
    const expiresAt = new Date(Date.parse(now) + horizon).toISOString();
    const safeResponseDigest = digestCanonicalJson(safeResult);
    const record = CommandRecordSchema.parse({
      schemaVersion: "1",
      scope: {
        issuerId: claims.issuerId,
        tenant: claims.tenant,
        principal: claims.actor,
        operation: command.operation,
        normalizedResourceScope: command.normalizedResourceScope,
        commandId: command.commandId,
      },
      requestDigest: command.requestDigest,
      status: "committed",
      resultReference: { kind: "response", responseReference: safeResponseDigest },
      safeResponseDigest,
      firstSeenAt: now,
      committedAt: now,
      detailRetentionExpiresAt: expiresAt,
      idempotencyExpiresAt: expiresAt,
    });
    await transaction.putCommandRecord(record);
    return record;
  }

  #commandScope(claims: VerifiedAuthority, command: CommandContext): CommandScope {
    return {
      issuerId: claims.issuerId,
      tenant: claims.tenant,
      principal: claims.actor,
      operation: command.operation,
      normalizedResourceScope: command.normalizedResourceScope,
      commandId: command.commandId,
    };
  }

  #asRun(projection: RunProjection): Run {
    return {
      schemaVersion: projection.schemaVersion,
      runId: projection.runId,
      tenantId: projection.tenantId,
      workOrderId: projection.workOrderId,
      workOrderBindingDigest: projection.workOrderBindingDigest,
      executionDefinition: projection.executionDefinition,
      executionDefinitionDigest: projection.executionDefinitionDigest,
      status: projection.status,
      createdAt: projection.createdAt,
      updatedAt: projection.updatedAt,
      dataClass: projection.dataClass,
      correlationId: projection.correlationId,
    };
  }

  #leastDurableProfile(
    profiles: readonly RuntimeCapabilities["executionProfile"][],
  ): RuntimeCapabilities["executionProfile"] {
    const rank = { ephemeral: 0, resumable: 1, durable: 2 } as const;
    let least: RuntimeCapabilities["executionProfile"] = "durable";
    for (const current of profiles) if (rank[current] < rank[least]) least = current;
    return least;
  }

  #readinessCheck(
    id: string,
    ready: boolean,
    safeMessage: string,
    remediationSlug: string,
  ): RuntimeReadinessReport["checks"][number] {
    return {
      schemaVersion: "1",
      id,
      status: ready ? "pass" : "fail",
      code: "KAF_RUNTIME_NOT_READY",
      safeMessage,
      remediationSlug,
    };
  }

  #artifactRetention(
    workOrder: AcceptedWorkOrder,
  ):
    | { mode: "session" }
    | { mode: "until"; expiresAt: string }
    | { mode: "policy"; policyId: string } {
    if (workOrder.retention.mode === "host_policy")
      return { mode: "policy", policyId: workOrder.retention.policyId };
    return workOrder.retention;
  }
}

export function createRuntime(config: RuntimeKernelConfig): AgentRuntime {
  return new AgentRuntime(config);
}
