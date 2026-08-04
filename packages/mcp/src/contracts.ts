import { z } from "zod";
import { isAbsolute } from "node:path";

import {
  DigestSchema,
  JsonValueSchema,
  SecretRefSchema,
  SecretResolutionBindingSchema,
  ToolSecuritySchema,
  digestCanonicalJson,
  type Digest,
  type SecretRef,
  type SecretResolutionBinding,
  type ToolSecurity,
} from "@pactmark/core";
import { MCPAdapterError } from "./errors.js";

export const MCP_SDK_VERSION = "1.30.0" as const;
export const MCP_LATEST_TESTED_PROTOCOL_VERSION = "2025-11-25" as const;

const IdentifierSchema = z.string().min(1).max(200);
const VersionSchema = z.string().min(1).max(100);
const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), {
    message: "Expected an absolute path",
  });
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

const LimitsShape = {
  connectionTimeoutMs: z.number().int().positive().max(300_000),
  requestTimeoutMs: z.number().int().positive().max(300_000),
  maxRequestBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
  maxTools: z.number().int().positive().max(10_000),
};

const StdioProfileMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    profileFormat: z.literal("pactmark.mcp-transport-security-profile@1"),
    id: IdentifierSchema,
    implementationVersion: VersionSchema,
    transport: z.literal("stdio"),
    executablePath: AbsolutePathSchema,
    executableArtifactDigest: DigestSchema,
    arguments: z.array(z.string().max(8_192)).max(128),
    workingDirectory: AbsolutePathSchema,
    environmentVariableNames: z
      .array(EnvironmentNameSchema)
      .max(128)
      .refine((values) => new Set(values).size === values.length, {
        message: "KAF_MCP_STDIO_ENVIRONMENT_DUPLICATE",
      }),
    shell: z.literal(false),
    sandboxRequirement: z.literal("required_for_production"),
    processLimit: z.number().int().positive().max(64),
    filesystemPolicyId: IdentifierSchema,
    networkPolicyId: IdentifierSchema,
    ...LimitsShape,
  })
  .strict();

const HttpProfileMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    profileFormat: z.literal("pactmark.mcp-transport-security-profile@1"),
    id: IdentifierSchema,
    implementationVersion: VersionSchema,
    transport: z.literal("streamable_http"),
    endpoint: z.url().refine((value) => new URL(value).protocol === "https:", {
      message: "KAF_MCP_HTTP_ENDPOINT_DENIED",
    }),
    exactOrigin: z.url(),
    tlsValidation: z.literal("system"),
    redirectPolicy: z.literal("deny"),
    egressEnforcement: z.literal("required"),
    trustedPrivateEndpoint: z.boolean(),
    credentialSlot: IdentifierSchema.optional(),
    ...LimitsShape,
  })
  .strict();

export const MCPTransportSecurityProfileSchema = z.discriminatedUnion("transport", [
  StdioProfileMaterialSchema.extend({ mcpTransportSecurityProfileDigest: DigestSchema }).strict(),
  HttpProfileMaterialSchema.extend({ mcpTransportSecurityProfileDigest: DigestSchema }).strict(),
]);
export type MCPTransportSecurityProfile = z.infer<typeof MCPTransportSecurityProfileSchema>;
export type MCPStdioTransportSecurityProfile = Extract<
  MCPTransportSecurityProfile,
  { readonly transport: "stdio" }
>;
export type MCPHttpTransportSecurityProfile = Extract<
  MCPTransportSecurityProfile,
  { readonly transport: "streamable_http" }
>;

const ServerIdentityMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    identityFormat: z.literal("pactmark.mcp-server-identity@1"),
    sdkVersion: z.literal(MCP_SDK_VERSION),
    serverName: IdentifierSchema,
    serverVersion: VersionSchema,
    serverArtifactDigest: DigestSchema,
    negotiatedProtocolVersion: z.string().min(1).max(100),
    negotiatedCapabilities: JsonValueSchema,
    transportProfileDigest: DigestSchema,
  })
  .strict();

export const MCPServerIdentitySchema = ServerIdentityMaterialSchema.extend({
  mcpServerIdentityDigest: DigestSchema,
}).strict();
export type MCPServerIdentity = z.infer<typeof MCPServerIdentitySchema>;
export type MCPServerIdentityDigest = MCPServerIdentity["mcpServerIdentityDigest"];

const ToolPinMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    pinFormat: z.literal("pactmark.mcp-tool-pin@1"),
    registrationId: z.string().regex(/^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*@\d+$/u),
    implementationVersion: VersionSchema,
    serverIdentityDigest: DigestSchema,
    toolName: z.string().min(1).max(128),
    safeDescription: z.string().min(1).max(1_024),
    inputSchemaDigest: DigestSchema,
    outputSchemaDigest: DigestSchema,
    security: ToolSecuritySchema,
    securityMetadataDigest: DigestSchema,
    allowedPurposeCodes: z.array(IdentifierSchema).min(1).max(128),
    previewStrategyRegistrationDigest: DigestSchema.optional(),
    effectStrategyKind: z.enum(["read", "native", "transactional", "reconcilable", "none"]),
    effectStrategyRegistrationDigest: DigestSchema,
    compensationStrategyRegistrationDigest: DigestSchema.optional(),
  })
  .strict();

export const MCPToolPinSchema = ToolPinMaterialSchema.extend({
  mcpToolPinDigest: DigestSchema,
  toolRegistrationDigest: DigestSchema,
}).strict();
export type MCPToolPin = z.infer<typeof MCPToolPinSchema>;

export const MCPHttpCredentialBindingSchema = z
  .object({
    secretRef: SecretRefSchema,
    resolutionBinding: SecretResolutionBindingSchema,
    expectedOriginDigest: DigestSchema,
  })
  .strict();
export interface MCPHttpCredentialBinding {
  readonly secretRef: SecretRef;
  readonly resolutionBinding: SecretResolutionBinding;
  readonly expectedOriginDigest: Digest;
}

export const MCPExposureRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: IdentifierSchema,
    runId: IdentifierSchema,
    workOrderBindingDigest: DigestSchema,
    purposeCode: IdentifierSchema,
  })
  .strict();
export type MCPExposureRequest = z.infer<typeof MCPExposureRequestSchema>;

export interface MCPExposureAuthority {
  authorize(
    request: Readonly<{
      exposure: MCPExposureRequest;
      serverIdentityDigest: MCPServerIdentityDigest;
      toolRegistrationDigest: Digest;
      requiredScopes: readonly string[];
    }>,
  ): Promise<Readonly<{ allowed: boolean; grantId?: string }>>;
}

export const MCPReadinessSchema = z
  .object({
    schemaVersion: z.literal("1"),
    profile: z.enum(["preview", "production"]),
    ready: z.boolean(),
    checks: z.array(
      z
        .object({
          code: z.string().startsWith("KAF_"),
          passed: z.boolean(),
          remediation: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type MCPReadiness = z.infer<typeof MCPReadinessSchema>;

export const MCPAuditEventSchema = z
  .object({
    schemaVersion: z.literal("1"),
    operation: z.enum(["connect", "discover", "call", "close"]),
    status: z.enum(["attempted", "succeeded", "denied", "failed", "cancelled"]),
    serverIdentityDigest: DigestSchema.optional(),
    toolRegistrationDigest: DigestSchema.optional(),
    safeCode: z.string().startsWith("KAF_").optional(),
    itemCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type MCPAuditEvent = z.infer<typeof MCPAuditEventSchema>;

export interface MCPAuditSink {
  emit(event: MCPAuditEvent): void;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function normalizedOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.username || url.password || url.hash)
    throw new TypeError("KAF_MCP_HTTP_ENDPOINT_INVALID");
  return url.origin;
}

function sortedUnique(values: readonly string[], code: string): string[] {
  const normalized = [...new Set(values)].sort();
  if (normalized.length !== values.length) throw new TypeError(code);
  return normalized;
}

export type DefineMCPStdioTransportSecurityProfileInput = Omit<
  z.input<typeof StdioProfileMaterialSchema>,
  "schemaVersion" | "profileFormat" | "shell" | "sandboxRequirement"
>;
export type DefineMCPHttpTransportSecurityProfileInput = Omit<
  z.input<typeof HttpProfileMaterialSchema>,
  | "schemaVersion"
  | "profileFormat"
  | "tlsValidation"
  | "redirectPolicy"
  | "egressEnforcement"
  | "exactOrigin"
>;

export function defineMCPTransportSecurityProfile(
  input: DefineMCPStdioTransportSecurityProfileInput,
): MCPStdioTransportSecurityProfile;
export function defineMCPTransportSecurityProfile(
  input: DefineMCPHttpTransportSecurityProfileInput,
): MCPHttpTransportSecurityProfile;
export function defineMCPTransportSecurityProfile(
  input: DefineMCPStdioTransportSecurityProfileInput | DefineMCPHttpTransportSecurityProfileInput,
): MCPTransportSecurityProfile {
  const material =
    input.transport === "stdio"
      ? StdioProfileMaterialSchema.parse({
          schemaVersion: "1",
          profileFormat: "pactmark.mcp-transport-security-profile@1",
          ...input,
          environmentVariableNames: sortedUnique(
            input.environmentVariableNames,
            "KAF_MCP_STDIO_ENVIRONMENT_DUPLICATE",
          ),
          shell: false,
          sandboxRequirement: "required_for_production",
        })
      : HttpProfileMaterialSchema.parse({
          schemaVersion: "1",
          profileFormat: "pactmark.mcp-transport-security-profile@1",
          ...input,
          exactOrigin: normalizedOrigin(input.endpoint),
          tlsValidation: "system",
          redirectPolicy: "deny",
          egressEnforcement: "required",
        });
  return deepFreeze(
    MCPTransportSecurityProfileSchema.parse({
      ...material,
      mcpTransportSecurityProfileDigest: digestCanonicalJson(material),
    }),
  );
}

export function defineMCPServerIdentity(
  input: Omit<
    z.input<typeof ServerIdentityMaterialSchema>,
    "schemaVersion" | "identityFormat" | "sdkVersion"
  >,
): MCPServerIdentity {
  const material = ServerIdentityMaterialSchema.parse({
    schemaVersion: "1",
    identityFormat: "pactmark.mcp-server-identity@1",
    sdkVersion: MCP_SDK_VERSION,
    ...input,
  });
  return deepFreeze(
    MCPServerIdentitySchema.parse({
      ...material,
      mcpServerIdentityDigest: digestCanonicalJson(material),
    }),
  );
}

export function verifyMCPTransportSecurityProfile(
  input: MCPTransportSecurityProfile,
): MCPTransportSecurityProfile {
  const parsed = MCPTransportSecurityProfileSchema.parse(input);
  const { mcpTransportSecurityProfileDigest: claimed, ...material } = parsed;
  const originMatches =
    parsed.transport === "stdio" || parsed.exactOrigin === normalizedOrigin(parsed.endpoint);
  if (digestCanonicalJson(material) !== claimed || !originMatches) {
    throw new MCPAdapterError(
      "KAF_MCP_IDENTITY_DRIFT",
      "MCP transport security profile digest does not match its canonical material",
    );
  }
  return parsed;
}

export function verifyMCPServerIdentity(input: MCPServerIdentity): MCPServerIdentity {
  const parsed = MCPServerIdentitySchema.parse(input);
  const { mcpServerIdentityDigest: claimed, ...material } = parsed;
  if (digestCanonicalJson(material) !== claimed) {
    throw new MCPAdapterError(
      "KAF_MCP_IDENTITY_DRIFT",
      "MCP server identity digest does not match its canonical material",
    );
  }
  return parsed;
}

function toolRegistrationDigest(material: z.output<typeof ToolPinMaterialSchema>): Digest {
  return digestCanonicalJson({
    registrationFormat: "pactmark.mcp-tool-registration@1",
    registrationId: material.registrationId,
    implementationVersion: material.implementationVersion,
    serverIdentityDigest: material.serverIdentityDigest,
    toolName: material.toolName,
    inputSchemaDigest: material.inputSchemaDigest,
    outputSchemaDigest: material.outputSchemaDigest,
    securityMetadataDigest: material.securityMetadataDigest,
    allowedPurposeCodes: material.allowedPurposeCodes,
    previewStrategyRegistrationDigest: material.previewStrategyRegistrationDigest ?? null,
    effectStrategyKind: material.effectStrategyKind,
    effectStrategyRegistrationDigest: material.effectStrategyRegistrationDigest,
    compensationStrategyRegistrationDigest: material.compensationStrategyRegistrationDigest ?? null,
    sdkVersion: MCP_SDK_VERSION,
  });
}

export function defineMCPToolPin(
  input: Omit<
    z.input<typeof ToolPinMaterialSchema>,
    "schemaVersion" | "pinFormat" | "securityMetadataDigest" | "allowedPurposeCodes"
  > & { readonly allowedPurposeCodes: readonly string[]; readonly security: ToolSecurity },
): MCPToolPin {
  const material = ToolPinMaterialSchema.parse({
    schemaVersion: "1",
    pinFormat: "pactmark.mcp-tool-pin@1",
    ...input,
    security: input.security,
    securityMetadataDigest: digestCanonicalJson(input.security),
    allowedPurposeCodes: sortedUnique(input.allowedPurposeCodes, "KAF_MCP_PURPOSE_DUPLICATE"),
  });
  return deepFreeze(
    MCPToolPinSchema.parse({
      ...material,
      mcpToolPinDigest: digestCanonicalJson(material),
      toolRegistrationDigest: toolRegistrationDigest(material),
    }),
  );
}

export function verifyMCPToolPin(input: MCPToolPin): MCPToolPin {
  const parsed = MCPToolPinSchema.parse(input);
  const {
    mcpToolPinDigest: claimedPinDigest,
    toolRegistrationDigest: claimedRegistrationDigest,
    ...material
  } = parsed;
  const valid = [
    digestCanonicalJson(material) === claimedPinDigest,
    toolRegistrationDigest(material) === claimedRegistrationDigest,
    digestCanonicalJson(parsed.security) === parsed.securityMetadataDigest,
  ].every(Boolean);
  if (!valid) {
    throw new MCPAdapterError(
      "KAF_MCP_IDENTITY_DRIFT",
      "MCP tool pin digest does not match its canonical material",
    );
  }
  return parsed;
}

export function mcpOriginDigest(origin: string): Digest {
  return digestCanonicalJson({ origin: normalizedOrigin(origin) });
}
