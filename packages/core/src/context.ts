import { z } from "zod";
import { ExecutionDefinitionRefSchema } from "./agent.js";
import { DigestSchema } from "./serialization.js";
import { DataClassSchema } from "./work-order.js";
import { RetentionRequestSchema } from "./storage.js";

export const ProtectedValueRefSchema = z
  .object({
    schemaVersion: z.literal("1"),
    protectorId: z.string().min(1),
    keyId: z.string().min(1),
    ciphertextRef: z.string().min(1),
    ciphertextDigest: DigestSchema,
    aadDigest: DigestSchema,
    algorithm: z.string().min(1),
  })
  .strict();
export type ProtectedValueRef = z.infer<typeof ProtectedValueRefSchema>;

export const ContextSnapshotSchema = z
  .object({
    schemaVersion: z.literal("1"),
    snapshotId: z.string().min(1),
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    stepId: z.string().min(1),
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    workOrderBindingDigest: DigestSchema,
    contextSchemaDigest: DigestSchema,
    contextDigest: DigestSchema,
    protectedValue: ProtectedValueRefSchema,
    byteSize: z.number().int().nonnegative(),
    purposeCode: z.string().min(1),
    purposeRegistryVersion: z.string().min(1),
    dataClass: DataClassSchema.exclude(["highly_restricted"]),
    retention: z
      .object({
        mode: z.enum(["session", "until", "policy"]),
        expiresAt: z.iso.datetime({ offset: true }).optional(),
        policyId: z.string().min(1).optional(),
      })
      .strict(),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

export const InputSubmissionRecordSchema = z
  .object({
    schemaVersion: z.literal("1"),
    inputSubmissionRecordId: z.string().min(1),
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    requestId: z.string().min(1),
    requestingStepId: z.string().min(1),
    requestingEventId: z.string().min(1),
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    workOrderBindingDigest: DigestSchema,
    inputSchemaDigest: DigestSchema,
    valueDigest: DigestSchema,
    protectedValue: ProtectedValueRefSchema,
    submittingPrincipalId: z.string().min(1),
    purposeCode: z.string().min(1),
    purposeRegistryVersion: z.string().min(1),
    dataClass: DataClassSchema.exclude(["highly_restricted"]),
    retention: RetentionRequestSchema,
    consumingCommandId: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type InputSubmissionRecord = z.infer<typeof InputSubmissionRecordSchema>;
