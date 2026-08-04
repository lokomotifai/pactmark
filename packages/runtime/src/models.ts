import {
  ModelAdapterRegistrationSchema,
  ModelCallBindingSchema,
  ModelCallReservationSchema,
  ModelCredentialRefSchema,
  ModelResourceProfileSchema,
  ModelSecurityProfileSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  KafError,
  type Digest,
  type JsonValue,
  type ModelAdapterRegistration,
  type ModelCallBinding,
  type ModelCallReservation,
  type ModelCallSettlement,
  type ModelCredentialIssuer,
  type ModelCredentialRef,
  type ModelCredentialResolver,
  type ModelResourceProfile,
  type ModelSecurityProfile,
  type ResolvedModelCredential,
  type Run,
  type RunCommandTransaction,
} from "@pactmark/core";

export type RuntimeModelCallContext = Readonly<{
  schemaVersion: "1";
  binding: ModelCallBinding;
  reservation: ModelCallReservation;
  credentialRef: ModelCredentialRef;
}>;

export type RuntimeModelCallSettlement = Readonly<
  Omit<
    ModelCallSettlement,
    | "schemaVersion"
    | "chargedTokens"
    | "chargedIoBytes"
    | "chargedCostMinor"
    | "currency"
    | "settledAt"
  > & {
    trustedProviderUsage?: Readonly<{
      inputTokens: number;
      outputTokens: number;
      callCostMinor?: number;
      currency?: string;
    }>;
  }
>;

export interface RuntimeSealedModelAdapter {
  readonly registration: ModelAdapterRegistration;
  estimateInputTokens(input: Readonly<{ canonicalRequest: string; inputBytes: number }>): number;
  invoke(
    input: Readonly<{
      run: Run;
      providerRequest: JsonValue;
      outputTokenMaximum: number;
      context: RuntimeModelCallContext;
      signal: AbortSignal;
      resolveCredential(): Promise<ResolvedModelCredential>;
    }>,
  ): AsyncIterable<Readonly<{ type: string; value: JsonValue }>>;
  trustedUsage?(
    context: RuntimeModelCallContext,
  ): RuntimeModelCallSettlement["trustedProviderUsage"];
  classifyError?(
    error: unknown,
  ): "aborted" | "timed_out" | "retryable" | "non_retryable" | "uncertain";
}

export interface RuntimeModelAdapterRegistry {
  resolve(modelAdapterRegistrationDigest: Digest): RuntimeSealedModelAdapter | undefined;
}

export interface RuntimeModelProfileRegistry {
  resolveSecurity(modelSecurityProfileDigest: Digest): ModelSecurityProfile | undefined;
  resolveResource(modelResourceProfileDigest: Digest): ModelResourceProfile | undefined;
}

export interface RuntimeModelCallReservationServices {
  readonly transactionDomain: string;
  readonly durable: boolean;
  /**
   * Must atomically persist and pessimistically debit the maximum reservation.
   * The tenant/run/step/attempt key is idempotent: exact replay returns the
   * existing reservation and changed binding fails closed.
   */
  reserve(
    transaction: RunCommandTransaction,
    reservation: ModelCallReservation,
  ): Promise<ModelCallReservation>;
  markDispatched(
    transaction: RunCommandTransaction,
    reservation: ModelCallReservation,
  ): Promise<ModelCallReservation>;
  /** Refunds at most once and never below conservative local usage floors. */
  settle(
    transaction: RunCommandTransaction,
    reservation: ModelCallReservation,
    settlement: RuntimeModelCallSettlement,
  ): Promise<ModelCallReservation>;
  /** Closes an uncertain dispatch at the original maximum with no refund. */
  markUncertain(
    transaction: RunCommandTransaction,
    reservation: ModelCallReservation,
  ): Promise<ModelCallReservation>;
}

export interface RuntimeProductionModelServices {
  readonly adapters: RuntimeModelAdapterRegistry;
  readonly profiles: RuntimeModelProfileRegistry;
  readonly credentialIssuer: ModelCredentialIssuer;
  readonly credentialResolver: ModelCredentialResolver;
  readonly reservations: RuntimeModelCallReservationServices;
  readonly reservationReader: Readonly<{
    get(
      tenantId: string,
      runId: string,
      stepId: string,
      attempt: number,
    ): Promise<ModelCallReservation | undefined>;
  }>;
  readonly credentialRefTtlMs?: number;
}

export function createModelCallReservationId(input: {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly workOrderBindingDigest: Digest;
  readonly agentDefinitionDigest: Digest;
  readonly modelSecurityProfileDigest: Digest;
  readonly modelResourceProfileDigest: Digest;
  readonly modelAdapterRegistrationDigest: Digest;
}): string {
  return `model-call-reservation:${digestCanonicalJson({ schemaVersion: "1", ...input })}`;
}

export function validateModelCallContext(input: {
  readonly context: RuntimeModelCallContext;
  readonly registration: ModelAdapterRegistration;
  readonly securityProfile: ModelSecurityProfile;
  readonly resourceProfile: ModelResourceProfile;
  readonly now: string;
}): RuntimeModelCallContext {
  const registration = ModelAdapterRegistrationSchema.parse(input.registration);
  const security = ModelSecurityProfileSchema.parse(input.securityProfile);
  const resource = ModelResourceProfileSchema.parse(input.resourceProfile);
  const binding = ModelCallBindingSchema.parse(input.context.binding);
  const reservation = ModelCallReservationSchema.parse(input.context.reservation);
  const ref = ModelCredentialRefSchema.parse(input.context.credentialRef);
  const exact = {
    tenantId: binding.tenantId,
    authoritySubject: binding.authoritySubject,
    workOrderBindingDigest: binding.workOrderBindingDigest,
    agentDefinitionDigest: binding.agentDefinitionDigest,
    modelSecurityProfileDigest: binding.modelSecurityProfileDigest,
    modelResourceProfileDigest: binding.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: binding.modelAdapterRegistrationDigest,
    reservationId: binding.reservationId,
    providerEndpointOrigin: binding.providerEndpointOrigin,
    purpose: binding.purpose,
    permittedDataClasses: binding.permittedDataClasses,
    credentialSlot: binding.credentialSlot,
  };
  const refBinding = {
    tenantId: ref.tenantId,
    authoritySubject: ref.authoritySubject,
    workOrderBindingDigest: ref.workOrderBindingDigest,
    agentDefinitionDigest: ref.agentDefinitionDigest,
    modelSecurityProfileDigest: ref.modelSecurityProfileDigest,
    modelResourceProfileDigest: ref.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: ref.modelAdapterRegistrationDigest,
    reservationId: ref.reservationId,
    providerEndpointOrigin: ref.providerEndpointOrigin,
    purpose: ref.purpose,
    permittedDataClasses: ref.permittedDataClasses,
    credentialSlot: ref.credentialSlot,
  };
  if (
    canonicalJsonStringify(exact) !== canonicalJsonStringify(refBinding) ||
    reservation.status !== "accepted" ||
    reservation.tenantId !== binding.tenantId ||
    reservation.workOrderBindingDigest !== binding.workOrderBindingDigest ||
    reservation.agentDefinitionDigest !== binding.agentDefinitionDigest ||
    reservation.modelSecurityProfileDigest !== binding.modelSecurityProfileDigest ||
    reservation.modelResourceProfileDigest !== binding.modelResourceProfileDigest ||
    reservation.modelAdapterRegistrationDigest !== binding.modelAdapterRegistrationDigest ||
    reservation.reservationId !== binding.reservationId ||
    registration.modelAdapterRegistrationDigest !== binding.modelAdapterRegistrationDigest ||
    registration.modelSecurityProfileDigest !== security.modelSecurityProfileDigest ||
    registration.modelResourceProfileDigest !== resource.modelResourceProfileDigest ||
    registration.credentialSlot !== binding.credentialSlot ||
    registration.endpointOrigin !== binding.providerEndpointOrigin ||
    Date.parse(ref.issuedAt) < Date.parse(reservation.createdAt) ||
    Date.parse(ref.expiresAt) > Date.parse(reservation.expiresAt) ||
    Date.parse(ref.issuedAt) > Date.parse(input.now) ||
    Date.parse(ref.expiresAt) <= Date.parse(input.now) ||
    Date.parse(reservation.expiresAt) <= Date.parse(input.now)
  ) {
    throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
      details: { reason: "model_call_context_binding_mismatch" },
    });
  }
  return { schemaVersion: "1", binding, reservation, credentialRef: ref };
}
