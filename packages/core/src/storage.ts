import { z } from "zod";
import { DigestSchema } from "./serialization.js";

export const StoredRecordRefSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: z.string().min(1),
    storeId: z.string().min(1),
    recordId: z.string().min(1),
    recordDigest: DigestSchema,
    storageSecurityProfileDigest: DigestSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type StoredRecordRef = z.infer<typeof StoredRecordRefSchema>;

export const RetentionRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("session") }).strict(),
  z.object({ mode: z.literal("until"), expiresAt: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ mode: z.literal("policy"), policyId: z.string().min(1) }).strict(),
]);
export type RetentionRequest = z.infer<typeof RetentionRequestSchema>;

export const RunLeaseSchema = z
  .object({
    schemaVersion: z.literal("1"),
    leaseId: z.string().min(1),
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    holderId: z.string().min(1),
    fencingToken: z.number().int().nonnegative(),
    acquiredAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    state: z.enum(["active", "released", "expired"]),
  })
  .strict();
export type RunLease = z.infer<typeof RunLeaseSchema>;
