import { z } from "zod";

export const KAF_ERROR_REGISTRY = {
  KAF_SCHEMA_INVALID: {
    retryable: false,
    httpStatus: 400,
    message: "The value does not match the required schema.",
    documentationSlug: "schema-invalid",
  },
  KAF_SERIALIZATION_INVALID_JSON: {
    retryable: false,
    httpStatus: 400,
    message: "The JSON representation is invalid.",
    documentationSlug: "serialization-invalid-json",
  },
  KAF_SERIALIZATION_DUPLICATE_KEY: {
    retryable: false,
    httpStatus: 400,
    message: "The JSON representation contains a duplicate key.",
    documentationSlug: "serialization-duplicate-key",
  },
  KAF_SERIALIZATION_INVALID_UNICODE: {
    retryable: false,
    httpStatus: 400,
    message: "The value contains invalid Unicode.",
    documentationSlug: "serialization-invalid-unicode",
  },
  KAF_SERIALIZATION_NON_I_JSON_NUMBER: {
    retryable: false,
    httpStatus: 400,
    message: "The value contains a non-I-JSON number.",
    documentationSlug: "serialization-number",
  },
  KAF_SERIALIZATION_UNSUPPORTED_VALUE: {
    retryable: false,
    httpStatus: 400,
    message: "The value cannot be represented as canonical JSON.",
    documentationSlug: "serialization-unsupported-value",
  },
  KAF_SERIALIZATION_CYCLIC_VALUE: {
    retryable: false,
    httpStatus: 400,
    message: "The value contains a cycle.",
    documentationSlug: "serialization-cycle",
  },
  KAF_RUNTIME_INVALID_TRANSITION: {
    retryable: false,
    httpStatus: 409,
    message: "The run event is not valid in the current state.",
    documentationSlug: "runtime-invalid-transition",
  },
  KAF_RUNTIME_TERMINAL: {
    retryable: false,
    httpStatus: 409,
    message: "The run is already terminal.",
    documentationSlug: "runtime-terminal",
  },
  KAF_RUNTIME_EVENT_SEQUENCE: {
    retryable: true,
    httpStatus: 409,
    message: "The run event sequence conflicts with stored state.",
    documentationSlug: "runtime-event-sequence",
  },
  KAF_RUNTIME_EVENT_BINDING: {
    retryable: false,
    httpStatus: 409,
    message: "The event does not belong to this run definition.",
    documentationSlug: "runtime-event-binding",
  },
  KAF_RUNTIME_AGENT_DEFINITION_MISMATCH: {
    retryable: false,
    httpStatus: 409,
    message: "The registered agent definition does not match the accepted run.",
    documentationSlug: "runtime-agent-definition-mismatch",
  },
  KAF_EFFECT_INVALID_TRANSITION: {
    retryable: false,
    httpStatus: 409,
    message: "The effect event is not valid in the current state.",
    documentationSlug: "effect-invalid-transition",
  },
  KAF_EFFECT_ABANDONED_UNCERTAIN: {
    retryable: false,
    httpStatus: 409,
    message: "The uncertain effect was abandoned and may have occurred.",
    documentationSlug: "effect-abandoned-uncertain",
  },
  KAF_AUTHORIZATION_BINDING_MISMATCH: {
    retryable: false,
    httpStatus: 403,
    message: "The authorization does not match the requested operation.",
    documentationSlug: "authorization-binding-mismatch",
  },
  KAF_AUTHORIZATION_EXPIRED: {
    retryable: false,
    httpStatus: 403,
    message: "The authorization has expired.",
    documentationSlug: "authorization-expired",
  },
  KAF_POLICY_DENIED: {
    retryable: false,
    httpStatus: 403,
    message: "Policy denied the operation.",
    documentationSlug: "policy-denied",
  },
  KAF_ADMISSION_DENIED: {
    retryable: true,
    httpStatus: 429,
    message: "The configured admission or quota limit was reached.",
    documentationSlug: "admission-denied",
  },
  KAF_STORAGE_CONCURRENCY_CONFLICT: {
    retryable: true,
    httpStatus: 409,
    message: "Stored state changed concurrently.",
    documentationSlug: "storage-concurrency-conflict",
  },
  KAF_STORAGE_NOT_FOUND: {
    retryable: false,
    httpStatus: 404,
    message: "The requested resource was not found.",
    documentationSlug: "storage-not-found",
  },
  KAF_STORAGE_SECURITY_PROFILE: {
    retryable: false,
    httpStatus: 503,
    message: "The storage security profile cannot accept this operation.",
    documentationSlug: "storage-security-profile",
  },
  KAF_RUNTIME_CAPABILITY_MISSING: {
    retryable: false,
    httpStatus: 503,
    message: "A required runtime capability is unavailable.",
    documentationSlug: "runtime-capability-missing",
  },
  KAF_RUNTIME_NOT_READY: {
    retryable: false,
    httpStatus: 503,
    message: "The runtime is not ready for the requested profile.",
    documentationSlug: "runtime-not-ready",
  },
  KAF_MODEL_RESOURCE_LIMIT_EXCEEDED: {
    retryable: false,
    httpStatus: 422,
    message: "The model call exceeded its registered resource profile.",
    documentationSlug: "model-resource-limit-exceeded",
  },
  KAF_MODEL_CREDENTIAL_REQUIRED: {
    retryable: false,
    httpStatus: 503,
    message: "The model credential boundary is unavailable.",
    documentationSlug: "model-credential-required",
  },
  KAF_MODEL_ADAPTER_MISMATCH: {
    retryable: false,
    httpStatus: 409,
    message: "The model adapter does not match the registered model profile.",
    documentationSlug: "model-adapter-mismatch",
  },
  KAF_VERIFICATION_REQUIRED: {
    retryable: false,
    httpStatus: 409,
    message: "Required verification has not passed.",
    documentationSlug: "verification-required",
  },
  KAF_EVIDENCE_INVALID_REFERENCE: {
    retryable: false,
    httpStatus: 409,
    message: "Evidence refers to a missing or incompatible record.",
    documentationSlug: "evidence-invalid-reference",
  },
  KAF_PATTERN_INSUFFICIENT_EVIDENCE: {
    retryable: false,
    httpStatus: 409,
    message: "The evidence does not support the requested pattern maturity.",
    documentationSlug: "pattern-insufficient-evidence",
  },
  KAF_COMMAND_IDEMPOTENCY_EXPIRED: {
    retryable: false,
    httpStatus: 409,
    message: "The command idempotency horizon has elapsed.",
    documentationSlug: "command-idempotency-expired",
  },
  KAF_HTTP_IDEMPOTENCY_CONFLICT: {
    retryable: false,
    httpStatus: 409,
    message: "The idempotency key was already used for different content.",
    documentationSlug: "http-idempotency-conflict",
  },
} as const;

export const KafErrorCodeSchema = z.enum(
  Object.keys(KAF_ERROR_REGISTRY) as [
    keyof typeof KAF_ERROR_REGISTRY,
    ...(keyof typeof KAF_ERROR_REGISTRY)[],
  ],
);
export type KafErrorCode = z.infer<typeof KafErrorCodeSchema>;

export const KafPublicErrorSchema = z
  .object({
    schemaVersion: z.literal("1"),
    code: KafErrorCodeSchema,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    requestId: z.string().min(1).optional(),
    causeCode: KafErrorCodeSchema.optional(),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict();
export type KafPublicError = z.infer<typeof KafPublicErrorSchema>;

export class KafError extends Error {
  readonly code: KafErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly documentationSlug: string;
  readonly requestId: string | undefined;
  readonly causeCode: KafErrorCode | undefined;
  readonly details: Readonly<Record<string, string | number | boolean | null>> | undefined;

  constructor(
    code: KafErrorCode,
    options: {
      requestId?: string;
      causeCode?: KafErrorCode;
      details?: Readonly<Record<string, string | number | boolean | null>>;
      internalCause?: unknown;
    } = {},
  ) {
    const descriptor = KAF_ERROR_REGISTRY[code];
    super(descriptor.message);
    this.name = "KafError";
    this.code = code;
    this.retryable = descriptor.retryable;
    this.httpStatus = descriptor.httpStatus;
    this.documentationSlug = descriptor.documentationSlug;
    this.requestId = options.requestId;
    this.causeCode = options.causeCode;
    this.details = options.details;
    if (options.internalCause !== undefined)
      Object.defineProperty(this, "cause", { value: options.internalCause, enumerable: false });
  }

  toJSON(): KafPublicError {
    return KafPublicErrorSchema.parse({
      schemaVersion: "1",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.causeCode === undefined ? {} : { causeCode: this.causeCode }),
      ...(this.details === undefined ? {} : { details: this.details }),
    });
  }
}

export function parseWire<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new KafError("KAF_SCHEMA_INVALID", {
    details: {
      path: result.error.issues[0]?.path.join(".") ?? "$",
      issue: result.error.issues[0]?.code ?? "invalid",
    },
    internalCause: result.error,
  });
}
