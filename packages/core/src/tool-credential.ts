import { z } from "zod";

import { DigestSchema } from "./serialization.js";

const IdSchema = z.string().min(1).max(250);

export const SecretRefSchema = z
  .object({
    schemaVersion: z.literal("1"),
    credentialKind: z.literal("tool"),
    refId: IdSchema,
    issuerId: IdSchema,
    tenantId: IdSchema,
    authoritySubject: IdSchema,
    workOrderBindingDigest: DigestSchema,
    executionDefinitionKind: z.enum(["agent", "compensation"]),
    executionDefinitionDigest: DigestSchema,
    grantId: IdSchema,
    toolId: IdSchema,
    toolVersion: z.string().min(1),
    toolRegistrationDigest: DigestSchema,
    credentialSlot: z.string().min(1),
    normalizedDestinationDigest: DigestSchema,
    effectDigest: DigestSchema.optional(),
    purpose: z.string().min(1),
    maximumUses: z.number().int().positive(),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    revokedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .brand<"ToolSecretRef">();
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const ToolCredentialIssueRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: IdSchema,
    authoritySubject: IdSchema,
    workOrderBindingDigest: DigestSchema,
    executionDefinitionKind: z.enum(["agent", "compensation"]),
    executionDefinitionDigest: DigestSchema,
    grantId: IdSchema,
    toolId: IdSchema,
    toolVersion: z.string().min(1),
    toolRegistrationDigest: DigestSchema,
    credentialSlot: z.string().min(1),
    normalizedDestinationDigest: DigestSchema,
    effectDigest: DigestSchema.optional(),
    purpose: z.string().min(1),
    maximumUses: z.number().int().positive(),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ToolCredentialIssueRequest = z.infer<typeof ToolCredentialIssueRequestSchema>;

export const SecretResolutionBindingSchema = z
  .object({
    schemaVersion: z.literal("1"),
    authorizationReservationId: IdSchema,
    tenantId: IdSchema,
    workOrderBindingDigest: DigestSchema,
    executionDefinitionDigest: DigestSchema,
    grantId: IdSchema,
    toolRegistrationDigest: DigestSchema,
    credentialSlot: z.string().min(1),
    normalizedDestinationDigest: DigestSchema,
    effectDigest: DigestSchema.optional(),
  })
  .strict();
export type SecretResolutionBinding = z.infer<typeof SecretResolutionBindingSchema>;

export class ResolvedToolCredential {
  readonly credentialKind = "resolved_tool" as const;
  readonly #value: string;

  private constructor(value: string) {
    if (value.length === 0) throw new TypeError("A resolved tool credential cannot be empty");
    this.#value = value;
    Object.freeze(this);
  }

  static fromAdapter(value: string): ResolvedToolCredential {
    return new ResolvedToolCredential(value);
  }

  use<R>(consumer: (value: string) => R): R {
    return consumer(this.#value);
  }

  toJSON(): never {
    throw new TypeError("KAF_CREDENTIAL_SERIALIZATION_FORBIDDEN");
  }
}

export interface ToolCredentialIssuer {
  readonly issuerId: string;
  issue(request: ToolCredentialIssueRequest): Promise<SecretRef>;
}

export interface SecretRefStore {
  putImmutable(ref: SecretRef): Promise<void>;
  get(tenantId: string, refId: string): Promise<SecretRef | undefined>;
  revoke(tenantId: string, refId: string, revokedAt: string): Promise<void>;
}

export interface SecretResolver {
  readonly resolverId: string;
  resolve(ref: SecretRef, binding: SecretResolutionBinding): Promise<ResolvedToolCredential>;
}

export class ToolCredentialDeniedError extends Error {
  readonly code = "KAF_TOOL_CREDENTIAL_DENIED" as const;
  constructor() {
    super("Tool credential access is unavailable");
    this.name = "ToolCredentialDeniedError";
  }
}

export const DenyAllToolCredentialIssuer: ToolCredentialIssuer = Object.freeze({
  issuerId: "pactmark.deny-all-tool-credential-issuer@1",
  issue: async () => Promise.reject(new ToolCredentialDeniedError()),
});

export const DenyAllSecretRefStore: SecretRefStore = Object.freeze({
  putImmutable: async () => Promise.reject(new ToolCredentialDeniedError()),
  get: async () => Promise.reject(new ToolCredentialDeniedError()),
  revoke: async () => Promise.reject(new ToolCredentialDeniedError()),
});

export const DenyAllSecretResolver: SecretResolver = Object.freeze({
  resolverId: "pactmark.deny-all-secret-resolver@1",
  resolve: async () => Promise.reject(new ToolCredentialDeniedError()),
});
