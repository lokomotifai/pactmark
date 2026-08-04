import { z } from "zod";
import { ExecutionDefinitionRefSchema } from "./agent.js";
import { DigestSchema } from "./serialization.js";
import { RetentionRequestSchema } from "./storage.js";
import { DataClassSchema } from "./work-order.js";

export const EvidenceAvailabilitySchema = z.enum([
  "not_collected",
  "not_permitted",
  "not_applicable",
  "unknown",
]);
export type EvidenceAvailability = z.infer<typeof EvidenceAvailabilitySchema>;
export const EvidenceMetricValueSchema = z.union([
  z.object({ kind: z.literal("numeric"), value: z.number(), unit: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("unavailable"), reason: EvidenceAvailabilitySchema }).strict(),
]);

export const EvidenceRecordSchema = z
  .object({
    schemaVersion: z.literal("1"),
    evidenceRecordId: z.string().min(1),
    evidenceDigest: DigestSchema,
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    workOrderBindingDigest: DigestSchema,
    claim: z
      .object({
        statement: z.string().min(1),
        claimType: z.string().min(1),
        scope: z.string().min(1),
      })
      .strict(),
    supports: z.array(z.string().min(1)).min(1),
    doesNotProve: z.array(z.string().min(1)).min(1),
    context: z
      .object({
        roleFamily: z.string().min(1),
        workflowId: z.string().min(1),
        riskClass: z.enum(["low", "medium", "high", "critical"]),
        purposeCode: z.string().min(1),
      })
      .strict(),
    workSplit: z
      .object({
        ai: EvidenceMetricValueSchema,
        human: EvidenceMetricValueSchema,
        description: z.string().min(1),
      })
      .strict(),
    artifactRefs: z.array(
      z.object({ artifactId: z.string().min(1), artifactDigest: DigestSchema }).strict(),
    ),
    eventRefs: z
      .array(
        z.object({ eventId: z.string().min(1), sequence: z.number().int().positive() }).strict(),
      )
      .min(1),
    approvalRefs: z.array(
      z.object({ approvalId: z.string().min(1), approvalDigest: DigestSchema }).strict(),
    ),
    verificationRefs: z.array(
      z
        .object({
          verificationId: z.string().min(1),
          verificationDigest: DigestSchema,
          status: z.enum(["pass", "fail", "needs_review"]),
          artifactDigest: DigestSchema,
          verifierId: z.string().min(1),
          verifierVersion: z.string().min(1),
          verifierRegistrationDigest: DigestSchema,
          method: z.enum(["deterministic", "model", "human"]),
          rubricVersion: z.string().min(1),
          rubricDigest: DigestSchema,
        })
        .strict(),
    ),
    verificationExceptionRefs: z.array(
      z
        .object({
          exceptionId: z.string().min(1),
          exceptionDigest: DigestSchema,
          verifierId: z.string().min(1),
          verifierRegistrationDigest: DigestSchema,
          artifactDigest: DigestSchema,
          rubricVersion: z.string().min(1),
          rubricDigest: DigestSchema,
        })
        .strict(),
    ),
    reviewer: z
      .object({
        reviewerId: z.string().min(1),
        role: z.string().min(1),
        conflictOfInterest: z.enum(["none_declared", "declared", "unknown"]),
        conflictDetails: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    permission: z
      .object({
        purposeCode: z.string().min(1),
        purposeRegistryVersion: z.string().min(1),
        visibility: z.enum(["private", "tenant", "shared", "public"]),
        dataClass: DataClassSchema.exclude(["highly_restricted"]),
        retention: RetentionRequestSchema,
      })
      .strict(),
    freshness: z
      .object({
        observedAt: z.iso.datetime({ offset: true }),
        validAt: z.iso.datetime({ offset: true }),
        expiresAt: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
    observation: z
      .object({
        firstObservedAt: z.iso.datetime({ offset: true }),
        lastObservedAt: z.iso.datetime({ offset: true }),
        count: z.number().int().positive(),
        repetitionStatus: z.enum(["single", "repeated_independent", "repeated_dependent"]),
        independentObservationIds: z.array(z.string().min(1)),
      })
      .strict(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.reviewer?.conflictOfInterest === "declared" &&
      value.reviewer.conflictDetails === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["reviewer", "conflictDetails"],
        message: "KAF_EVIDENCE_REVIEWER_CONFLICT_DETAILS_REQUIRED",
      });
    }
    if (
      value.reviewer?.conflictOfInterest === "none_declared" &&
      value.reviewer.conflictDetails !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["reviewer", "conflictDetails"],
        message: "KAF_EVIDENCE_REVIEWER_CONFLICT_STATE_INVALID",
      });
    }
  });
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
