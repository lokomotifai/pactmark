import {
  ResolvedToolCredential,
  SecretRefSchema,
  SecretResolutionBindingSchema,
  ToolCredentialIssueRequestSchema,
  canonicalJsonStringify,
  type Clock,
  type IdGenerator,
  type SecretRef,
  type SecretRefStore,
  type SecretResolutionBinding,
  type SecretResolver,
  type ToolCredentialIssueRequest,
  type ToolCredentialIssuer,
} from "@pactmark/core";

export class SecretBoundaryError extends Error {
  readonly code = "KAF_TOOL_CREDENTIAL_DENIED" as const;

  constructor(readonly reason: string) {
    super("Tool credential access is unavailable");
    this.name = "SecretBoundaryError";
  }
}

export type RegisteredCredentialSlot = Readonly<{
  slot: string;
  value: string;
  allowedToolRegistrationDigests: readonly string[];
  allowedDestinationDigests: readonly string[];
  allowedPurposes: readonly string[];
  allowedExecutionKinds: readonly ("agent" | "compensation")[];
}>;

function sameBinding(ref: SecretRef, binding: SecretResolutionBinding): boolean {
  return (
    ref.tenantId === binding.tenantId &&
    ref.workOrderBindingDigest === binding.workOrderBindingDigest &&
    ref.executionDefinitionDigest === binding.executionDefinitionDigest &&
    ref.grantId === binding.grantId &&
    ref.toolRegistrationDigest === binding.toolRegistrationDigest &&
    ref.credentialSlot === binding.credentialSlot &&
    ref.normalizedDestinationDigest === binding.normalizedDestinationDigest &&
    ref.effectDigest === binding.effectDigest
  );
}

/**
 * Opaque process-local test/development boundary. Secret values remain only in
 * the resolver closure and are never written through SecretRefStore.
 */
export function createMemoryToolCredentialBoundary(input: {
  readonly issuerId: string;
  readonly resolverId: string;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly slots: readonly RegisteredCredentialSlot[];
  readonly authorizeIssue: (request: ToolCredentialIssueRequest) => boolean;
}): Readonly<{
  issuer: ToolCredentialIssuer;
  store: SecretRefStore;
  resolver: SecretResolver;
}> {
  const slotDefinitions = new Map(input.slots.map((slot) => [slot.slot, Object.freeze(slot)]));
  const metadata = new Map<string, SecretRef>();
  const uses = new Map<string, Map<string, string>>();

  const store: SecretRefStore = Object.freeze({
    putImmutable(rawRef: SecretRef) {
      return Promise.resolve().then(() => {
        const ref = SecretRefSchema.parse(rawRef);
        const key = `${ref.tenantId}:${ref.refId}`;
        const existing = metadata.get(key);
        if (
          existing !== undefined &&
          canonicalJsonStringify(existing) !== canonicalJsonStringify(ref)
        ) {
          throw new SecretBoundaryError("SecretRef immutable binding conflict");
        }
        metadata.set(key, Object.freeze(ref));
      });
    },
    get(tenantId: string, refId: string) {
      return Promise.resolve(metadata.get(`${tenantId}:${refId}`));
    },
    revoke(tenantId: string, refId: string, revokedAt: string) {
      return Promise.resolve().then(() => {
        const key = `${tenantId}:${refId}`;
        const ref = metadata.get(key);
        if (ref === undefined) throw new SecretBoundaryError("SecretRef is unavailable");
        metadata.set(key, Object.freeze(SecretRefSchema.parse({ ...ref, revokedAt })));
      });
    },
  });

  const issuer: ToolCredentialIssuer = Object.freeze({
    issuerId: input.issuerId,
    issue(rawRequest: ToolCredentialIssueRequest) {
      return Promise.resolve().then(() => {
        const request = ToolCredentialIssueRequestSchema.parse(rawRequest);
        const slot = slotDefinitions.get(request.credentialSlot);
        if (
          slot === undefined ||
          slot.value.length === 0 ||
          !input.authorizeIssue(request) ||
          !slot.allowedToolRegistrationDigests.includes(request.toolRegistrationDigest) ||
          !slot.allowedDestinationDigests.includes(request.normalizedDestinationDigest) ||
          !slot.allowedPurposes.includes(request.purpose) ||
          !slot.allowedExecutionKinds.includes(request.executionDefinitionKind) ||
          Date.parse(request.expiresAt) <= Date.parse(input.clock.now())
        ) {
          throw new SecretBoundaryError("Credential issuance binding is denied");
        }
        return SecretRefSchema.parse({
          ...request,
          credentialKind: "tool",
          refId: input.idGenerator.generate("secret_ref"),
          issuerId: input.issuerId,
          issuedAt: input.clock.now(),
        });
      });
    },
  });

  const resolver: SecretResolver = Object.freeze({
    resolverId: input.resolverId,
    resolve(rawRef: SecretRef, rawBinding: SecretResolutionBinding) {
      return Promise.resolve().then(async () => {
        const ref = SecretRefSchema.parse(rawRef);
        const binding = SecretResolutionBindingSchema.parse(rawBinding);
        const stored = await store.get(ref.tenantId, ref.refId);
        const slot = slotDefinitions.get(ref.credentialSlot);
        if (
          stored === undefined ||
          canonicalJsonStringify(stored) !== canonicalJsonStringify(ref) ||
          stored.issuerId !== input.issuerId ||
          stored.revokedAt !== undefined ||
          Date.parse(input.clock.now()) >= Date.parse(stored.expiresAt) ||
          slot === undefined ||
          !sameBinding(stored, binding)
        ) {
          throw new SecretBoundaryError("Credential resolution binding is denied");
        }
        const refUses = uses.get(ref.refId) ?? new Map<string, string>();
        const replay = refUses.get(binding.authorizationReservationId);
        if (replay !== undefined && replay !== canonicalJsonStringify(binding)) {
          throw new SecretBoundaryError("Authorization reservation binding changed");
        }
        if (replay === undefined && refUses.size >= ref.maximumUses) {
          throw new SecretBoundaryError("Credential use is exhausted");
        }
        refUses.set(binding.authorizationReservationId, canonicalJsonStringify(binding));
        uses.set(ref.refId, refUses);
        return ResolvedToolCredential.fromAdapter(slot.value);
      });
    },
  });

  return Object.freeze({ issuer, store, resolver });
}
