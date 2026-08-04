import { z } from "zod";
import type { AgentDefinition, CompensationRunDefinition } from "./agent.js";
import type { Artifact } from "./artifacts.js";
import type { AuthorityContext } from "./authority.js";
import type { InputSubmissionRecord, ContextSnapshot, ProtectedValueRef } from "./context.js";
import type { EvidenceRecord } from "./evidence.js";
import type { RunEvent } from "./events.js";
import type { Digest, JsonValue } from "./serialization.js";
import type { PatternRecord } from "./patterns.js";
import type { Run, RunProjection } from "./run.js";
import type { RunLease } from "./storage.js";
import type { EgressHttpClient, ToolRegistrationContract } from "./tool.js";
import type { VerificationRecord, VerificationResult } from "./verification.js";
import type { AcceptedWorkOrder } from "./work-order.js";

export interface Clock {
  now(): string;
  monotonicMilliseconds(): number;
}
export interface IdGenerator {
  generate(kind: string): string;
}

export const RuntimeReadinessProfileSchema = z.enum(["local", "preview", "production"]);
export type RuntimeReadinessProfile = z.infer<typeof RuntimeReadinessProfileSchema>;
export const NetworkPolicySchema = z.enum(["none", "declared", "enforced"]);
export const RuntimeCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal("1"),
    executionProfile: z.enum(["ephemeral", "resumable", "durable"]),
    durableStorage: z.boolean(),
    protectedContext: z.boolean(),
    protectedWorkOrders: z.boolean(),
    protectedInputSubmissions: z.boolean(),
    streaming: z.boolean(),
    cancellation: z.boolean(),
    sandbox: z.enum(["none", "unsafe_local", "isolated"]),
    networkPolicy: NetworkPolicySchema,
    backgroundWakeup: z.boolean(),
    atomicCommandAndWakeup: z.boolean(),
    humanDecisions: z.boolean(),
    typedInput: z.boolean(),
    effectReconciliation: z.boolean(),
    compensation: z.boolean(),
    modelCredentials: z.boolean(),
    toolCredentials: z.boolean(),
    telemetry: z.enum(["none", "metadata_only"]),
    transactionDomains: z.array(z.string().min(1)),
  })
  .strict();
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
export const RuntimeReadinessCheckSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().min(1),
    status: z.enum(["pass", "fail", "warning", "not_applicable"]),
    code: z.string().regex(/^KAF_[A-Z0-9_]+$/),
    safeMessage: z.string().min(1),
    remediationSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    requiredCapability: z.string().min(1).optional(),
  })
  .strict();
export type RuntimeReadinessCheck = z.infer<typeof RuntimeReadinessCheckSchema>;
export const RuntimeReadinessReportSchema = z
  .object({
    schemaVersion: z.literal("1"),
    ready: z.boolean(),
    profile: RuntimeReadinessProfileSchema,
    capabilities: RuntimeCapabilitiesSchema,
    checks: z.array(RuntimeReadinessCheckSchema),
    evaluatedAt: z.iso.datetime({ offset: true }),
    rulesVersion: z.string().min(1),
  })
  .strict();
export type RuntimeReadinessReport = z.infer<typeof RuntimeReadinessReportSchema>;

export interface AgentRegistry {
  register(definition: AgentDefinition): Promise<void>;
  resolve(id: string, version: string, digest: Digest): Promise<AgentDefinition | undefined>;
}
export interface CompensationRunRegistry {
  register(definition: CompensationRunDefinition): Promise<void>;
  resolve(
    id: string,
    version: string,
    digest: Digest,
  ): Promise<CompensationRunDefinition | undefined>;
}
export interface PurposeRegistry {
  readonly version: string;
  has(code: string): boolean;
}
export interface AcceptedWorkOrderStore {
  readonly capabilities: RuntimeCapabilities;
  putImmutable(workOrder: AcceptedWorkOrder): Promise<void>;
  get(tenantId: string, workOrderId: string): Promise<AcceptedWorkOrder | undefined>;
  delete(tenantId: string, workOrderId: string): Promise<void>;
}
export interface InputSubmissionStore {
  readonly capabilities: RuntimeCapabilities;
  putOnce(record: InputSubmissionRecord): Promise<InputSubmissionRecord>;
  get(
    tenantId: string,
    runId: string,
    requestId: string,
  ): Promise<InputSubmissionRecord | undefined>;
  delete(tenantId: string, runId: string, requestId: string): Promise<void>;
}
export interface EventStore {
  readonly capabilities: RuntimeCapabilities;
  append(
    event: RunEvent,
    expectedSequence: number,
  ): Promise<{ sequence: number; replayed: boolean }>;
  read(tenantId: string, runId: string, afterSequence?: number): AsyncIterable<RunEvent>;
  getProjection(tenantId: string, runId: string): Promise<RunProjection | undefined>;
}
export interface ContextStore {
  readonly capabilities: RuntimeCapabilities;
  put(snapshot: ContextSnapshot): Promise<void>;
  getLatest(tenantId: string, runId: string): Promise<ContextSnapshot | undefined>;
  delete(tenantId: string, runId: string): Promise<void>;
}
export interface ContextProtector {
  protect(tenantId: string, purposeCode: string, value: Uint8Array): Promise<ProtectedValueRef>;
  unprotect(reference: ProtectedValueRef): Promise<Uint8Array>;
}
export interface ArtifactStore {
  readonly capabilities: RuntimeCapabilities;
  put(artifact: Artifact, content: Uint8Array): Promise<void>;
  get(
    tenantId: string,
    artifactId: string,
  ): Promise<{ artifact: Artifact; content: Uint8Array } | undefined>;
  delete(tenantId: string, artifactId: string): Promise<void>;
}
export interface EvidenceRecordStore {
  readonly capabilities: RuntimeCapabilities;
  putImmutable(record: EvidenceRecord): Promise<void>;
  get(tenantId: string, evidenceRecordId: string): Promise<EvidenceRecord | undefined>;
  getByDigest(tenantId: string, evidenceDigest: Digest): Promise<EvidenceRecord | undefined>;
}
export interface VerificationRecordStore {
  readonly capabilities: RuntimeCapabilities;
  putImmutable(record: VerificationRecord): Promise<void>;
  get(
    tenantId: string,
    runId: string,
    verificationId: string,
  ): Promise<VerificationRecord | undefined>;
  getByDigest(
    tenantId: string,
    verificationDigest: Digest,
  ): Promise<VerificationRecord | undefined>;
}
export interface PatternRecordStore {
  readonly capabilities: RuntimeCapabilities;
  putImmutable(record: PatternRecord): Promise<void>;
  get(tenantId: string, patternId: string, version: string): Promise<PatternRecord | undefined>;
  getByDigest(tenantId: string, patternDigest: Digest): Promise<PatternRecord | undefined>;
}
export interface DataProtector {
  protect(
    binding: Readonly<Record<string, string>>,
    plaintext: Uint8Array,
  ): Promise<ProtectedValueRef>;
  unprotect(
    binding: Readonly<Record<string, string>>,
    reference: ProtectedValueRef,
  ): Promise<Uint8Array>;
}
export interface RunLeaseStore {
  acquire(
    tenantId: string,
    runId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<RunLease | undefined>;
  renew(lease: RunLease, ttlMs: number): Promise<RunLease>;
  release(lease: RunLease): Promise<void>;
}

/** Compile-only boundary: model callbacks and provider objects are deliberately adapter-owned and never serialized. */
export interface ModelDriver {
  readonly capabilities: RuntimeCapabilities;
  invoke(
    request: Readonly<{ run: Run; input: JsonValue; signal: AbortSignal }>,
  ): AsyncIterable<Readonly<{ type: string; value: JsonValue }>>;
  classifyError?(
    error: unknown,
  ): "aborted" | "timed_out" | "retryable" | "non_retryable" | "uncertain";
}
export interface ToolExecutor {
  readonly capabilities: RuntimeCapabilities;
  readonly networkPolicy: z.infer<typeof NetworkPolicySchema>;
  execute(
    request: Readonly<{
      registration: ToolRegistrationContract;
      input: JsonValue;
      signal: AbortSignal;
    }>,
  ): Promise<JsonValue>;
  classifyError?(
    error: unknown,
    registration: ToolRegistrationContract,
  ): "aborted" | "timed_out" | "retryable" | "non_retryable" | "uncertain";
}
export interface EgressBroker {
  readonly capabilities: RuntimeCapabilities;
  bind(
    request: Readonly<{ tenantId: string; runId: string; toolRegistrationDigest: Digest }>,
  ): EgressHttpClient;
}
export interface PolicyEngine {
  evaluate(
    input: Readonly<{
      workOrder: AcceptedWorkOrder;
      tool: ToolRegistrationContract;
      argumentsDigest: Digest;
      targetDigest: Digest;
    }>,
  ): Promise<
    Readonly<{ decision: "deny" | "allow_with_grant" | "require_approval"; reasonCode: string }>
  >;
}
export interface VerifierRegistry {
  verify(verifierId: string, artifact: Artifact, signal: AbortSignal): Promise<VerificationResult>;
  has(verifierId: string): boolean;
}
export interface EvidenceBuilder {
  build(
    input: Readonly<{
      run: RunProjection;
      events: readonly RunEvent[];
      artifacts: readonly Artifact[];
      verifications: readonly VerificationResult[];
    }>,
  ): Promise<EvidenceRecord>;
}
export interface TelemetrySink {
  emit(
    record: Readonly<{
      operation: string;
      status: string;
      durationMs: number;
      identifiers: Readonly<Record<string, string>>;
      counters: Readonly<Record<string, number>>;
    }>,
  ): void;
}

export const WakeupRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    reason: z.string().min(1),
    scheduledAt: z.iso.datetime({ offset: true }),
    notBefore: z.iso.datetime({ offset: true }).optional(),
    deduplicationKey: z.string().min(1),
  })
  .strict();
export type WakeupRequest = z.infer<typeof WakeupRequestSchema>;
export const WakeupReceiptSchema = z
  .object({
    schemaVersion: z.literal("1"),
    receiptId: z.string().min(1),
    schedulerId: z.string().min(1),
    requestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    durable: z.boolean(),
    atomicWithCommand: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type WakeupReceipt = z.infer<typeof WakeupReceiptSchema>;
export interface RunDriver {
  readonly capabilities: RuntimeCapabilities;
  execute(
    authority: AuthorityContext,
    ref: Readonly<{ tenantId: string; runId: string }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<Readonly<{ status: "completed" | "parked" | "failed"; runId: string }>>;
}
export interface WakeupScheduler {
  readonly capabilities: RuntimeCapabilities;
  schedule(request: WakeupRequest): Promise<WakeupReceipt>;
  cancel(receipt: WakeupReceipt): Promise<void>;
}
export interface MigrationManager {
  status(): Promise<Readonly<{ currentVersion: string; pending: readonly string[] }>>;
  migrate(targetVersion?: string): Promise<void>;
}
export interface SandboxAdapter {
  readonly capabilities: RuntimeCapabilities;
  readonly safety: "unsafe_local" | "isolated";
  execute(
    request: Readonly<{ command: string; arguments: readonly string[]; signal: AbortSignal }>,
  ): Promise<Readonly<{ exitCode: number; stdoutDigest: Digest; stderrDigest: Digest }>>;
}
