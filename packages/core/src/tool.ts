import { z } from "zod";
import { DigestSchema, type JsonValue } from "./serialization.js";
import { DataClassSchema, type DataClass } from "./work-order.js";

export const ToolRiskClassSchema = z.enum(["R0", "R1", "R2", "R3", "R4", "R5"]);
export type ToolRiskClass = z.infer<typeof ToolRiskClassSchema>;
export const HttpMethodSchema = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

export const ToolEgressSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z
    .object({
      mode: z.literal("allowlist"),
      destinations: z.array(z.url()).min(1),
      methods: z.array(HttpMethodSchema).min(1),
      credentialSlots: z.array(z.string().min(1)),
    })
    .strict(),
]);
export const ToolSecuritySchema = z
  .object({
    schemaVersion: z.literal("1"),
    riskClass: ToolRiskClassSchema,
    dataClasses: z.array(DataClassSchema).min(1),
    reversibility: z.enum(["not_applicable", "compensatable", "irreversible"]),
    requiredScopes: z.array(z.string().min(1)),
    egress: ToolEgressSchema,
    networkEnforcement: z.enum(["required", "declared_ok"]),
    maxCallsPerRun: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    costCeiling: z.number().nonnegative().optional(),
  })
  .strict();
export type ToolSecurity = z.infer<typeof ToolSecuritySchema>;

export const ApprovalPreviewDisplaySchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1_000),
    materialConsequence: z.string().trim().min(1).max(1_000),
    reversibility: z.enum(["compensatable", "irreversible"]),
    fields: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(80),
            value: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .strict();
export type ApprovalPreviewDisplay = z.infer<typeof ApprovalPreviewDisplaySchema>;

export const EffectPreviewSchema = z
  .object({
    schemaVersion: z.literal("1"),
    normalizedTarget: z.string().min(1),
    operationClass: z.string().min(1),
    contentDigest: DigestSchema,
    reversibility: z.enum(["compensatable", "irreversible"]),
    materialConsequence: z.string().min(1),
    approvalDisplay: ApprovalPreviewDisplaySchema.optional(),
    diffDigest: DigestSchema.optional(),
    previewDigest: DigestSchema,
  })
  .strict();
export type EffectPreview = z.infer<typeof EffectPreviewSchema>;

export const ToolRegistrationContractSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*@\d+$/),
    implementationVersion: z.string().min(1),
    description: z.string().min(1),
    inputSchemaDigest: DigestSchema,
    outputSchemaDigest: DigestSchema,
    security: ToolSecuritySchema,
    previewStrategyRegistrationDigest: DigestSchema.optional(),
    effectStrategyKind: z.enum(["read", "native", "transactional", "reconcilable", "none"]),
    effectStrategyRegistrationDigest: DigestSchema,
    compensationStrategyRegistrationDigest: DigestSchema.optional(),
    executorKind: z.string().min(1),
    executorVersion: z.string().min(1),
    toolRegistrationDigest: DigestSchema,
  })
  .strict();
export type ToolRegistrationContract = z.infer<typeof ToolRegistrationContractSchema>;

export interface SafeRunContext {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly purposeCode: string;
  readonly dataClass: DataClass;
}
export interface NormalizedTarget {
  readonly value: string;
  readonly digest: string;
}
export interface EgressHttpClient {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
export interface ArtifactWriter {
  write(
    content: Uint8Array,
    metadata: Readonly<Record<string, JsonValue>>,
  ): Promise<{ readonly artifactId: string; readonly contentDigest: string }>;
}
export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly run: SafeRunContext;
  readonly egress: EgressHttpClient;
  readonly artifacts: ArtifactWriter;
}
export interface PreviewContext {
  readonly run: SafeRunContext;
  readonly normalizedTarget: NormalizedTarget;
  readonly deterministicClock: DeterministicClock;
}
/** Minimal structural clock needed by deterministic preview executors. */
export interface DeterministicClock {
  now(): string;
  monotonicMilliseconds(): number;
}
export interface EffectBinding {
  readonly effectKey: string;
  readonly normalizedTargetDigest: string;
  readonly toolRegistrationDigest: string;
}

/** Compile-only executable contract: callbacks are intentionally absent from every wire schema. */
export interface PreviewStrategy<I> {
  readonly id: string;
  readonly implementationVersion: string;
  render(input: I, context: PreviewContext): Promise<EffectPreview>;
}
