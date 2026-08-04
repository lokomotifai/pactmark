import { z } from "zod";
import { KafError } from "./errors.js";
import { DigestSchema } from "./serialization.js";
import { DataClassSchema } from "./work-order.js";

export const PatternMaturitySchema = z.enum([
  "candidate",
  "locally_verified",
  "peer_reviewed",
  "repeated",
  "proven",
  "deprecated",
]);
export type PatternMaturity = z.infer<typeof PatternMaturitySchema>;
export const PATTERN_TRANSITIONS = {
  candidate: ["locally_verified", "deprecated"],
  locally_verified: ["peer_reviewed", "deprecated"],
  peer_reviewed: ["repeated", "deprecated"],
  repeated: ["proven", "deprecated"],
  proven: ["deprecated"],
  deprecated: [],
} as const satisfies Readonly<Record<PatternMaturity, readonly PatternMaturity[]>>;

export const PatternManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    patternId: z.string().min(1),
    version: z.string().min(1),
    patternDigest: DigestSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    maturity: PatternMaturitySchema,
    scaleUnit: z
      .object({
        roleFamily: z.string().min(1),
        workflowId: z.string().min(1),
        riskClass: z.enum(["low", "medium", "high", "critical"]),
      })
      .strict(),
    assetRefs: z
      .array(
        z
          .object({
            kind: z.enum(["agent", "skill", "instruction", "schema"]),
            id: z.string().min(1),
            version: z.string().min(1),
            digest: DigestSchema,
          })
          .strict(),
      )
      .min(1),
    evidenceRecordDigests: z.array(DigestSchema),
    independentObservationCount: z.number().int().nonnegative(),
    baseline: z
      .object({
        metric: z.enum(["quality", "speed", "effort", "risk"]),
        description: z.string().min(1),
        baselineDigest: DigestSchema,
        advantageEvidenceDigest: DigestSchema,
        measuredAdvantage: z.number().positive(),
        unit: z.string().min(1),
      })
      .strict()
      .optional(),
    supportedClaims: z.array(z.string().min(1)).min(1),
    doesNotProve: z.array(z.string().min(1)).min(1),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PatternManifest = z.infer<typeof PatternManifestSchema>;

/** Tenant and purpose routing for one immutable pattern-manifest version. */
export const PatternRecordSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: z.string().min(1),
    purposeCode: z.string().min(1),
    dataClass: DataClassSchema.exclude(["highly_restricted"]),
    pattern: PatternManifestSchema,
  })
  .strict();
export type PatternRecord = z.infer<typeof PatternRecordSchema>;

export function assertPatternPromotion(pattern: PatternManifest, target: PatternMaturity): void {
  if (!(PATTERN_TRANSITIONS[pattern.maturity] as readonly PatternMaturity[]).includes(target))
    throw new KafError("KAF_PATTERN_INSUFFICIENT_EVIDENCE");
  if ((target === "repeated" || target === "proven") && pattern.independentObservationCount < 2)
    throw new KafError("KAF_PATTERN_INSUFFICIENT_EVIDENCE", {
      details: { requiredIndependentObservations: 2 },
    });
  if (target === "proven" && pattern.baseline === undefined)
    throw new KafError("KAF_PATTERN_INSUFFICIENT_EVIDENCE", {
      details: { missing: "declared_baseline" },
    });
}
