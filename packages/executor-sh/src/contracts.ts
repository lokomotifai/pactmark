import { z } from "zod";

import {
  DigestSchema,
  JsonValueSchema,
  ToolRegistrationContractSchema,
  ToolSecuritySchema,
  digestCanonicalJson,
  type Digest,
  type JsonValue,
  type ToolRegistrationContract,
  type ToolSecurity,
} from "@pactmark/core";
import { ExecutorAdapterError } from "./errors.js";

export const EXECUTOR_ADAPTER_VERSION = "0.1.0" as const;
export const EXECUTOR_CODE_TEMPLATE_VERSION = "1" as const;

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
const IdentifierSchema = z.string().min(1).max(200);
const VersionSchema = z.string().min(1).max(100);
const ExecutorToolAddressSchema = z
  .string()
  .min(3)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/u);

const ExecutorToolPinMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    pinFormat: z.literal("pactmark.executor-sh-tool-pin@1"),
    registrationId: z.string().regex(/^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*@\d+$/u),
    implementationVersion: VersionSchema,
    serverIdentityDigest: DigestSchema,
    executeToolRegistrationDigest: DigestSchema,
    connectionBindingDigest: DigestSchema,
    toolAddress: ExecutorToolAddressSchema,
    safeDescription: z.string().min(1).max(1_024),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema,
    inputSchemaDigest: DigestSchema,
    outputSchemaDigest: DigestSchema,
    security: ToolSecuritySchema,
    securityMetadataDigest: DigestSchema,
    effectStrategyKind: z.literal("read"),
    effectStrategyRegistrationDigest: DigestSchema,
    codeTemplateVersion: z.literal(EXECUTOR_CODE_TEMPLATE_VERSION),
  })
  .strict();

export const ExecutorToolPinSchema = ExecutorToolPinMaterialSchema.extend({
  executorToolPinDigest: DigestSchema,
  toolRegistrationDigest: DigestSchema,
}).strict();
export type ExecutorToolPin = z.infer<typeof ExecutorToolPinSchema>;

export interface DefineExecutorToolPinInput {
  readonly registrationId: string;
  readonly implementationVersion: string;
  readonly serverIdentityDigest: Digest;
  readonly executeToolRegistrationDigest: Digest;
  readonly connectionBindingDigest: Digest;
  readonly toolAddress: string;
  readonly safeDescription: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly outputSchema: Readonly<Record<string, JsonValue>>;
  readonly security: ToolSecurity;
  readonly effectStrategyRegistrationDigest: Digest;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function executorToolSchemaDigest(
  direction: "input" | "output",
  schema: Readonly<Record<string, JsonValue>>,
): Digest {
  return digestCanonicalJson({
    schemaFormat: "pactmark.executor-sh-json-schema@1",
    direction,
    schema,
  });
}

function registrationDigest(material: z.output<typeof ExecutorToolPinMaterialSchema>): Digest {
  return digestCanonicalJson({
    registrationFormat: "pactmark.executor-sh-tool-registration@1",
    registrationId: material.registrationId,
    implementationVersion: material.implementationVersion,
    serverIdentityDigest: material.serverIdentityDigest,
    executeToolRegistrationDigest: material.executeToolRegistrationDigest,
    connectionBindingDigest: material.connectionBindingDigest,
    toolAddress: material.toolAddress,
    safeDescription: material.safeDescription,
    inputSchemaDigest: material.inputSchemaDigest,
    outputSchemaDigest: material.outputSchemaDigest,
    securityMetadataDigest: material.securityMetadataDigest,
    effectStrategyKind: material.effectStrategyKind,
    effectStrategyRegistrationDigest: material.effectStrategyRegistrationDigest,
    codeTemplateVersion: material.codeTemplateVersion,
    adapterVersion: EXECUTOR_ADAPTER_VERSION,
  });
}

function assertSupportedPolicy(pin: ExecutorToolPin): void {
  if (
    (pin.security.riskClass !== "R0" && pin.security.riskClass !== "R1") ||
    pin.security.reversibility !== "not_applicable" ||
    pin.security.networkEnforcement !== "declared_ok" ||
    pin.security.egress.mode !== "allowlist"
  ) {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_POLICY_UNSUPPORTED",
      "The Executor adapter accepts only declared-egress R0/R1 read tools",
    );
  }
}

export function defineExecutorToolPin(input: DefineExecutorToolPinInput): ExecutorToolPin {
  const material = ExecutorToolPinMaterialSchema.parse({
    schemaVersion: "1",
    pinFormat: "pactmark.executor-sh-tool-pin@1",
    ...input,
    inputSchemaDigest: executorToolSchemaDigest("input", input.inputSchema),
    outputSchemaDigest: executorToolSchemaDigest("output", input.outputSchema),
    securityMetadataDigest: digestCanonicalJson(input.security),
    effectStrategyKind: "read",
    codeTemplateVersion: EXECUTOR_CODE_TEMPLATE_VERSION,
  });
  const pin = ExecutorToolPinSchema.parse({
    ...material,
    executorToolPinDigest: digestCanonicalJson(material),
    toolRegistrationDigest: registrationDigest(material),
  });
  assertSupportedPolicy(pin);
  return deepFreeze(pin);
}

export function verifyExecutorToolPin(input: ExecutorToolPin): ExecutorToolPin {
  let pin: ExecutorToolPin;
  try {
    pin = ExecutorToolPinSchema.parse(input);
  } catch {
    throw new ExecutorAdapterError("KAF_EXECUTOR_PIN_DRIFT", "The Executor tool pin is malformed");
  }
  const {
    executorToolPinDigest: claimedPinDigest,
    toolRegistrationDigest: claimedRegistrationDigest,
    ...material
  } = pin;
  const valid =
    digestCanonicalJson(material) === claimedPinDigest &&
    registrationDigest(material) === claimedRegistrationDigest &&
    executorToolSchemaDigest("input", pin.inputSchema) === pin.inputSchemaDigest &&
    executorToolSchemaDigest("output", pin.outputSchema) === pin.outputSchemaDigest &&
    digestCanonicalJson(pin.security) === pin.securityMetadataDigest;
  if (!valid) {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_PIN_DRIFT",
      "The Executor tool pin digest does not match its canonical material",
    );
  }
  assertSupportedPolicy(pin);
  return deepFreeze(pin);
}

export function executorRegistrationFromPin(pin: ExecutorToolPin): ToolRegistrationContract {
  const verified = verifyExecutorToolPin(pin);
  return ToolRegistrationContractSchema.parse({
    schemaVersion: "1",
    id: verified.registrationId,
    implementationVersion: verified.implementationVersion,
    description: verified.safeDescription,
    inputSchemaDigest: verified.inputSchemaDigest,
    outputSchemaDigest: verified.outputSchemaDigest,
    security: verified.security,
    effectStrategyKind: "read",
    effectStrategyRegistrationDigest: verified.effectStrategyRegistrationDigest,
    executorKind: "executor-sh-mcp",
    executorVersion: EXECUTOR_ADAPTER_VERSION,
    toolRegistrationDigest: verified.toolRegistrationDigest,
  });
}

export const ExecutorCompletedEnvelopeSchema = z
  .object({
    status: z.literal("completed"),
    result: JsonValueSchema,
    logs: z.array(z.string()).optional(),
  })
  .loose();

export function executorConnectionBindingDigest(input: {
  readonly tenantId: string;
  readonly executorOrigin: string;
  readonly opaqueConnectionRef: string;
}): Digest {
  const tenantId = IdentifierSchema.parse(input.tenantId);
  const origin = new URL(input.executorOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new TypeError("KAF_EXECUTOR_ORIGIN_INVALID");
  }
  return digestCanonicalJson({
    bindingFormat: "pactmark.executor-sh-connection-binding@1",
    tenantId,
    executorOrigin: origin.origin,
    opaqueConnectionRef: IdentifierSchema.parse(input.opaqueConnectionRef),
  });
}
