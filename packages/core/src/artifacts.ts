import { z } from "zod";
import { ExecutionDefinitionRefSchema } from "./agent.js";
import { DigestSchema, JsonValueSchema } from "./serialization.js";
import { RetentionRequestSchema } from "./storage.js";
import { DataClassSchema } from "./work-order.js";

export const ArtifactLocationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("inline"),
      encoding: z.enum(["utf8", "base64"]),
      content: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal("store"), storeId: z.string().min(1), objectRef: z.string().min(1) })
    .strict(),
]);
export const ArtifactProvenanceSchema = z
  .object({
    schemaVersion: z.literal("1"),
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    workOrderBindingDigest: DigestSchema,
    producingEventId: z.string().min(1),
    sourceArtifactDigests: z.array(DigestSchema),
    toolRegistrationDigests: z.array(DigestSchema),
    metadata: z.record(z.string(), JsonValueSchema),
  })
  .strict();
export const ArtifactSchema = z
  .object({
    schemaVersion: z.literal("1"),
    artifactId: z.string().min(1),
    artifactDigest: DigestSchema,
    contentDigest: DigestSchema,
    mediaType: z.string().regex(/^[\w.+-]+\/[\w.+-]+(?:;.*)?$/),
    byteSize: z.number().int().nonnegative(),
    location: ArtifactLocationSchema,
    tenantId: z.string().min(1),
    producingRunId: z.string().min(1),
    producingStepId: z.string().min(1),
    owner: z
      .object({ type: z.enum(["principal", "tenant", "system"]), id: z.string().min(1) })
      .strict(),
    visibility: z.enum(["private", "tenant", "shared", "public"]),
    dataClass: DataClassSchema.exclude(["highly_restricted"]),
    purposeCode: z.string().min(1),
    retention: RetentionRequestSchema,
    provenance: ArtifactProvenanceSchema,
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
