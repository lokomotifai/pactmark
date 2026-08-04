import { z } from "zod";
import { ExecutionDefinitionRefSchema } from "./agent.js";
import { DigestSchema } from "./serialization.js";

export const AuthorizationReservationSchema = z
  .object({
    schemaVersion: z.literal("1"),
    authorizationReservationId: z.string().min(1),
    authorizationKey: z.string().min(1),
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    stepId: z.string().min(1),
    toolCallId: z.string().min(1),
    effectKey: z.string().min(1).optional(),
    workOrderBindingDigest: DigestSchema,
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    toolId: z.string().min(1),
    toolVersion: z.string().min(1),
    toolRegistrationDigest: DigestSchema,
    policyRegistrationDigest: DigestSchema,
    argumentsDigest: DigestSchema,
    normalizedTargetDigest: DigestSchema,
    grantId: z.string().min(1),
    approvalId: z.string().min(1).optional(),
    secretRefIds: z.array(z.string().min(1)),
    purposeCode: z.string().min(1),
    purposeRegistryVersion: z.string().min(1),
    state: z.enum(["reserved", "consumed", "expired", "revoked"]),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    consumedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type AuthorizationReservation = z.infer<typeof AuthorizationReservationSchema>;
