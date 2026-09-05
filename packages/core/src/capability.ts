import { z } from "zod";

import { ExecutionDefinitionRefSchema } from "./agent.js";
import type { AuthorityContext } from "./authority.js";
import { PrincipalSchema, TenantSchema } from "./authority.js";
import { DigestSchema } from "./serialization.js";
import { PurposeSchema, ResourceScopeSchema } from "./work-order.js";

export const CapabilityGrantSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().trim().min(1).max(256),
    issuerId: z.string().trim().min(1).max(256),
    principal: PrincipalSchema,
    tenant: TenantSchema,
    workOrderId: z.string().trim().min(1).max(256),
    workOrderBindingDigest: DigestSchema,
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    capability: z.string().trim().min(1).max(256),
    action: z.string().trim().min(1).max(256),
    toolId: z.string().trim().min(1).max(256),
    toolVersion: z.string().trim().min(1).max(128),
    toolRegistrationDigest: DigestSchema,
    normalizedResources: z.array(ResourceScopeSchema).min(1).max(256),
    purpose: PurposeSchema,
    policyRegistrationDigest: DigestSchema,
    maximumUses: z.number().int().positive(),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    revokedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export const CapabilityGrantIssueRequestSchema = CapabilityGrantSchema.omit({
  schemaVersion: true,
  id: true,
  issuerId: true,
  issuedAt: true,
  revokedAt: true,
});
export type CapabilityGrantIssueRequest = z.infer<typeof CapabilityGrantIssueRequestSchema>;

export const CapabilityGrantBindingSchema = CapabilityGrantSchema.pick({
  issuerId: true,
  principal: true,
  tenant: true,
  workOrderId: true,
  workOrderBindingDigest: true,
  executionDefinition: true,
  executionDefinitionDigest: true,
  capability: true,
  action: true,
  toolId: true,
  toolVersion: true,
  toolRegistrationDigest: true,
  normalizedResources: true,
  purpose: true,
  policyRegistrationDigest: true,
});
export type CapabilityGrantBinding = z.infer<typeof CapabilityGrantBindingSchema>;

export const CapabilityGrantUseClaimSchema = z
  .object({
    schemaVersion: z.literal("1"),
    grantId: z.string().trim().min(1).max(256),
    authorizationKey: z.string().trim().min(1).max(512),
    useNumber: z.number().int().positive(),
    claimedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CapabilityGrantUseClaim = z.infer<typeof CapabilityGrantUseClaimSchema>;

export interface GrantIssuer {
  issue(
    authority: AuthorityContext,
    requests: readonly CapabilityGrantIssueRequest[],
  ): Promise<readonly CapabilityGrant[]>;
}

export type CapabilityGrantResolution =
  | { readonly status: "active"; readonly grant: CapabilityGrant; readonly usesRemaining: number }
  | { readonly status: "missing" | "expired" | "revoked" | "exhausted" | "binding_mismatch" };

export interface CapabilityGrantStore {
  issue(grant: CapabilityGrant): Promise<void>;
  revoke(tenantId: string, grantId: string, revokedAt: string): Promise<void>;
  resolve(
    grantId: string,
    binding: CapabilityGrantBinding,
    at: string,
  ): Promise<CapabilityGrantResolution>;
  reserveUse(
    tenantId: string,
    grantId: string,
    authorizationKey: string,
    at: string,
  ): Promise<CapabilityGrantUseClaim>;
}
