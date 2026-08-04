import { z } from "zod";

import { ExecutionDefinitionRefSchema } from "./agent.js";
import type { AuthorityContext, AuthorityIssuer } from "./authority.js";
import { PrincipalSchema, TenantSchema } from "./authority.js";
import { DigestSchema } from "./serialization.js";
import { PurposeSchema, ResourceScopeSchema } from "./work-order.js";

export const RunDelegationDescriptorSchema = z
  .object({
    schemaVersion: z.literal("1"),
    actor: z
      .object({ type: z.literal("system_worker"), id: z.string().trim().min(1).max(256) })
      .strict(),
    initiatingPrincipal: PrincipalSchema,
    tenant: TenantSchema,
    runId: z.string().trim().min(1).max(256),
    workOrderId: z.string().trim().min(1).max(256),
    workOrderBindingDigest: DigestSchema,
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    purpose: PurposeSchema,
    maximumScopes: z.array(ResourceScopeSchema).max(256),
    schedulerReceiptId: z.string().trim().min(1).max(256),
    schedulerReceiptDigest: DigestSchema,
    leaseId: z.string().trim().min(1).max(256),
    fencingToken: z.number().int().nonnegative(),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    decisionRights: z.tuple([]),
  })
  .strict();
export type RunDelegationDescriptor = z.infer<typeof RunDelegationDescriptorSchema>;

declare const DELEGATED_RUN_AUTHORITY_BRAND: unique symbol;
export type DelegatedRunAuthority = AuthorityContext &
  Readonly<{ [DELEGATED_RUN_AUTHORITY_BRAND]: "DelegatedRunAuthority" }>;

export type DelegatedAuthorityVerification =
  | { readonly valid: true; readonly descriptor: RunDelegationDescriptor }
  | {
      readonly valid: false;
      readonly reason:
        | "not_issued"
        | "other_issuer"
        | "expired"
        | "lease_mismatch"
        | "fencing_mismatch"
        | "scheduler_receipt_mismatch";
    };

export interface DelegatingAuthorityIssuer extends AuthorityIssuer {
  issueDelegated(descriptor: RunDelegationDescriptor): DelegatedRunAuthority;
  verifyDelegated(authority: unknown, at: Date): DelegatedAuthorityVerification;
}
