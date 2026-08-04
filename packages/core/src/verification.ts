import { z } from "zod";
import { DigestSchema, JsonValueSchema } from "./serialization.js";
import { DataClassSchema } from "./work-order.js";

export const VerificationFindingSchema = z
  .object({
    schemaVersion: z.literal("1"),
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    safeMessage: z.string().min(1),
    path: z.string().min(1).optional(),
    evidence: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();
export const VerificationResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal("1"),
      status: z.literal("pass"),
      verificationId: z.string().min(1),
      verificationDigest: DigestSchema,
      verifierId: z.string().min(1),
      verifierVersion: z.string().min(1),
      verifierRegistrationDigest: DigestSchema,
      method: z.enum(["deterministic", "model", "human"]),
      artifactDigest: DigestSchema,
      findings: z.array(VerificationFindingSchema),
      rubricVersion: z.string().min(1),
      rubricDigest: DigestSchema,
      verifiedAt: z.iso.datetime({ offset: true }),
      reviewerId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("1"),
      status: z.literal("fail"),
      verificationId: z.string().min(1),
      verificationDigest: DigestSchema,
      verifierId: z.string().min(1),
      verifierVersion: z.string().min(1),
      verifierRegistrationDigest: DigestSchema,
      method: z.enum(["deterministic", "model", "human"]),
      artifactDigest: DigestSchema,
      findings: z.array(VerificationFindingSchema).min(1),
      rubricVersion: z.string().min(1),
      rubricDigest: DigestSchema,
      verifiedAt: z.iso.datetime({ offset: true }),
      reviewerId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("1"),
      status: z.literal("needs_review"),
      verificationId: z.string().min(1),
      verificationDigest: DigestSchema,
      verifierId: z.string().min(1),
      verifierVersion: z.string().min(1),
      verifierRegistrationDigest: DigestSchema,
      method: z.enum(["deterministic", "model"]),
      artifactDigest: DigestSchema,
      findings: z.array(VerificationFindingSchema).min(1),
      rubricVersion: z.string().min(1),
      rubricDigest: DigestSchema,
      verifiedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

/** Tenant and purpose routing for an immutable verification result. */
export const VerificationRecordSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    purposeCode: z.string().min(1),
    dataClass: DataClassSchema.exclude(["highly_restricted"]),
    verification: VerificationResultSchema,
  })
  .strict();
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

const VerificationExceptionMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    exceptionId: z.string().min(1),
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    artifactDigest: DigestSchema,
    verifierId: z.string().min(1),
    verifierRegistrationDigest: DigestSchema,
    rubricVersion: z.string().min(1),
    rubricDigest: DigestSchema,
    reviewer: z.object({ principalId: z.string().min(1), role: z.string().min(1) }).strict(),
    reason: z.string().min(1),
    compensatingControls: z.array(z.string().min(1)).min(1),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const VerificationExceptionSchema = VerificationExceptionMaterialSchema.extend({
  exceptionDigest: DigestSchema,
})
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.issuedAt) >= Date.parse(value.expiresAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "KAF_VERIFICATION_EXCEPTION_WINDOW_INVALID",
      });
    }
  });
export type VerificationException = z.infer<typeof VerificationExceptionSchema>;
