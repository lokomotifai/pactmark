import { z } from "zod";

import { ModelCallBindingSchema, ModelCallReservationSchema } from "./model.js";
import { DigestSchema } from "./serialization.js";

const IdSchema = z.string().min(1).max(250);

export const ModelCredentialRefSchema = z
  .object({
    schemaVersion: z.literal("1"),
    credentialKind: z.literal("model"),
    refId: IdSchema,
    issuerId: IdSchema,
    tenantId: IdSchema,
    authoritySubject: IdSchema,
    workOrderBindingDigest: DigestSchema,
    agentDefinitionDigest: DigestSchema,
    modelSecurityProfileDigest: DigestSchema,
    modelResourceProfileDigest: DigestSchema,
    modelAdapterRegistrationDigest: DigestSchema,
    reservationId: IdSchema,
    providerEndpointOrigin: z.url(),
    purpose: z.string().min(1),
    permittedDataClasses: z
      .array(z.enum(["public", "internal", "confidential", "restricted"]))
      .min(1),
    credentialSlot: z.string().min(1),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .brand<"ModelCredentialRef">();
export type ModelCredentialRef = z.infer<typeof ModelCredentialRefSchema>;

export const ModelCredentialIssueRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    binding: ModelCallBindingSchema,
    reservation: ModelCallReservationSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.binding.reservationId !== value.reservation.reservationId) {
      context.addIssue({
        code: "custom",
        path: ["reservation"],
        message: "Reservation binding mismatch",
      });
    }
    for (const field of [
      "tenantId",
      "workOrderBindingDigest",
      "agentDefinitionDigest",
      "modelSecurityProfileDigest",
      "modelResourceProfileDigest",
      "modelAdapterRegistrationDigest",
    ] as const) {
      if (value.binding[field] !== value.reservation[field]) {
        context.addIssue({
          code: "custom",
          path: ["binding", field],
          message: `${field} binding mismatch`,
        });
      }
    }
    if (value.reservation.status !== "accepted") {
      context.addIssue({
        code: "custom",
        path: ["reservation", "status"],
        message: "Reservation must be accepted",
      });
    }
  });
export type ModelCredentialIssueRequest = z.infer<typeof ModelCredentialIssueRequestSchema>;

export class ResolvedModelCredential {
  readonly credentialKind = "resolved_model" as const;
  readonly #value: string;

  private constructor(value: string) {
    if (value.length === 0) throw new TypeError("A resolved model credential cannot be empty");
    this.#value = value;
    Object.freeze(this);
  }

  static fromAdapter(value: string): ResolvedModelCredential {
    return new ResolvedModelCredential(value);
  }

  use<R>(consumer: (value: string) => R): R {
    return consumer(this.#value);
  }

  toJSON(): never {
    throw new TypeError("KAF_CREDENTIAL_SERIALIZATION_FORBIDDEN");
  }
}

export interface ModelCredentialIssuer {
  readonly issuerId: string;
  issue(request: ModelCredentialIssueRequest): Promise<ModelCredentialRef>;
}

export interface ModelCredentialResolutionRequest {
  readonly ref: ModelCredentialRef;
  readonly binding: z.infer<typeof ModelCallBindingSchema>;
  readonly reservation: z.infer<typeof ModelCallReservationSchema>;
}

export interface ModelCredentialResolver {
  readonly resolverId: string;
  resolve(request: ModelCredentialResolutionRequest): Promise<ResolvedModelCredential>;
}

export class ModelCredentialDeniedError extends Error {
  readonly code = "KAF_MODEL_CREDENTIAL_DENIED" as const;
  constructor() {
    super("Model credential access is unavailable");
    this.name = "ModelCredentialDeniedError";
  }
}

export const DenyAllModelCredentialIssuer: ModelCredentialIssuer = Object.freeze({
  issuerId: "pactmark.deny-all-model-credential-issuer@1",
  issue: async () => Promise.reject(new ModelCredentialDeniedError()),
});

export const DenyAllModelCredentialResolver: ModelCredentialResolver = Object.freeze({
  resolverId: "pactmark.deny-all-model-credential-resolver@1",
  resolve: async () => Promise.reject(new ModelCredentialDeniedError()),
});
