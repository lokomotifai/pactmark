import { z } from "zod";

import {
  JsonValueSchema,
  ToolRegistrationContractSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type Digest,
  type JsonValue,
  type ToolRegistrationContract,
} from "@pactmark/core";
import type { KillSwitchRegistry } from "@pactmark/policy";
import {
  MCPExposureRequestSchema,
  MCPAuditEventSchema,
  defineMCPServerIdentity,
  verifyMCPServerIdentity,
  verifyMCPToolPin,
  verifyMCPTransportSecurityProfile,
  type MCPExposureAuthority,
  type MCPAuditSink,
  type MCPExposureRequest,
  type MCPServerIdentity,
  type MCPToolPin,
  type MCPTransportSecurityProfile,
} from "./contracts.js";
import { MCPAdapterError } from "./errors.js";
import {
  createOfficialMCPProtocolClient,
  createOfficialMCPTransport,
  mcpCallArguments,
  type MCPClientTransport,
  type MCPProtocolClientFactory,
  type MCPTransportHostOptions,
} from "./transports.js";

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
const MCPToolSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(100_000).optional(),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema.optional(),
    annotations: JsonValueSchema.optional(),
    _meta: JsonValueSchema.optional(),
  })
  .loose();
const MCPToolPageSchema = z
  .object({
    tools: z.array(MCPToolSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .loose();
const MCPCallResultSchema = z
  .object({
    content: JsonValueSchema,
    structuredContent: JsonObjectSchema.optional(),
    isError: z.boolean().optional(),
  })
  .loose();

interface DiscoveredTool {
  readonly name: string;
  readonly inputSchemaDigest: Digest;
  readonly outputSchemaDigest: Digest;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly outputSchema: Readonly<Record<string, JsonValue>>;
}

export interface MCPExposedTool {
  readonly registration: ToolRegistrationContract;
  readonly toolName: string;
  readonly serverIdentityDigest: Digest;
  readonly pinDigest: Digest;
  readonly grantId: string;
}

export interface MCPAdapterConfig {
  readonly transportProfile: MCPTransportSecurityProfile;
  readonly expectedServerIdentity: MCPServerIdentity;
  readonly toolPins: readonly MCPToolPin[];
  readonly host: MCPTransportHostOptions;
  readonly clientFactory?: MCPProtocolClientFactory;
  readonly transportFactory?: (
    profile: MCPTransportSecurityProfile,
    host: MCPTransportHostOptions,
    signal: AbortSignal,
  ) => Promise<MCPClientTransport>;
  readonly audit?: MCPAuditSink;
  readonly killSwitches?: Pick<KillSwitchRegistry, "isKilled">;
}

interface BoundMCPTool extends MCPExposedTool {
  readonly inputValidator: z.ZodType;
  readonly outputValidator: z.ZodType;
}

function assertServerActive(config: MCPAdapterConfig, serverIdentityDigest: Digest): void {
  if (config.killSwitches?.isKilled("mcp_server", serverIdentityDigest) === true) {
    throw new MCPAdapterError(
      "KAF_MCP_SERVER_KILLED",
      "The pinned MCP server is disabled by the host kill switch",
    );
  }
}

export interface MCPConnection {
  readonly serverIdentity: MCPServerIdentity;
  listExposedTools(): readonly MCPExposedTool[];
  callTool(
    toolRegistrationDigest: Digest,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  close(): Promise<void>;
}

export function mcpToolSchemaDigest(schema: JsonValue): Digest {
  return digestCanonicalJson({
    identityFormat: "pactmark.mcp-json-schema@1",
    schema,
  });
}

function audit(
  sink: MCPAuditSink | undefined,
  event: Omit<z.input<typeof MCPAuditEventSchema>, "schemaVersion">,
): void {
  sink?.emit(MCPAuditEventSchema.parse({ schemaVersion: "1", ...event }));
}

function registrationFromPin(pin: MCPToolPin): ToolRegistrationContract {
  const material = {
    schemaVersion: "1" as const,
    id: pin.registrationId,
    implementationVersion: pin.implementationVersion,
    description: pin.safeDescription,
    inputSchemaDigest: pin.inputSchemaDigest,
    outputSchemaDigest: pin.outputSchemaDigest,
    security: pin.security,
    ...(pin.previewStrategyRegistrationDigest === undefined
      ? {}
      : { previewStrategyRegistrationDigest: pin.previewStrategyRegistrationDigest }),
    effectStrategyKind: pin.effectStrategyKind,
    effectStrategyRegistrationDigest: pin.effectStrategyRegistrationDigest,
    ...(pin.compensationStrategyRegistrationDigest === undefined
      ? {}
      : {
          compensationStrategyRegistrationDigest: pin.compensationStrategyRegistrationDigest,
        }),
    executorKind: "mcp",
    executorVersion: "@modelcontextprotocol/sdk@1.30.0",
    toolRegistrationDigest: pin.toolRegistrationDigest,
  };
  return ToolRegistrationContractSchema.parse(material);
}

function observeProtocolVersion(transport: MCPClientTransport): () => string | undefined {
  let negotiated: string | undefined;
  const original = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (version: string): void => {
    negotiated = version;
    original?.(version);
  };
  return () => negotiated;
}

function boundedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  if (signal.aborted) {
    throw new MCPAdapterError("KAF_MCP_ABORTED", "MCP operation was cancelled");
  }
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function boundedJson(value: unknown, maximumBytes: number, operation: string): JsonValue {
  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new MCPAdapterError("KAF_MCP_MALFORMED_RESPONSE", `${operation} returned non-JSON data`, {
      cause: parsed.error,
    });
  }
  if (new TextEncoder().encode(canonicalJsonStringify(parsed.data)).byteLength > maximumBytes) {
    throw new MCPAdapterError("KAF_MCP_LIMIT_EXCEEDED", `${operation} exceeded its byte limit`);
  }
  return parsed.data;
}

function validatorFromJsonSchema(
  schema: Readonly<Record<string, JsonValue>>,
  label: string,
): z.ZodType {
  try {
    return z.fromJSONSchema(schema);
  } catch (error) {
    throw new MCPAdapterError(
      "KAF_MCP_TOOL_SCHEMA_DRIFT",
      `The pinned MCP ${label} schema is not executable`,
      { cause: error },
    );
  }
}

function verifyStaticBindings(
  profile: MCPTransportSecurityProfile,
  identity: MCPServerIdentity,
  pins: readonly MCPToolPin[],
): readonly MCPToolPin[] {
  if (
    identity.transportProfileDigest !== profile.mcpTransportSecurityProfileDigest ||
    (profile.transport === "stdio" &&
      identity.serverArtifactDigest !== profile.executableArtifactDigest)
  ) {
    throw new MCPAdapterError(
      "KAF_MCP_IDENTITY_DRIFT",
      "The host-pinned MCP server identity does not match the transport profile",
    );
  }
  const verified = pins.map((pin) => verifyMCPToolPin(pin));
  const names = new Set<string>();
  const registrations = new Set<string>();
  for (const pin of verified) {
    if (
      pin.serverIdentityDigest !== identity.mcpServerIdentityDigest ||
      names.has(pin.toolName) ||
      registrations.has(pin.toolRegistrationDigest)
    ) {
      throw new MCPAdapterError(
        "KAF_MCP_IDENTITY_DRIFT",
        "The host-pinned MCP tool identities are ambiguous or bound to another server",
      );
    }
    names.add(pin.toolName);
    registrations.add(pin.toolRegistrationDigest);
  }
  return Object.freeze(verified);
}

async function discoverTools(
  client: ReturnType<MCPProtocolClientFactory>,
  profile: MCPTransportSecurityProfile,
  signal: AbortSignal,
): Promise<readonly DiscoveredTool[]> {
  const tools: DiscoveredTool[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = MCPToolPageSchema.safeParse(
      await client.listTools(cursor === undefined ? {} : { cursor }, {
        signal: boundedSignal(signal, profile.requestTimeoutMs),
        timeout: profile.requestTimeoutMs,
        maxTotalTimeout: profile.requestTimeoutMs,
      }),
    );
    if (!page.success) {
      throw new MCPAdapterError(
        "KAF_MCP_MALFORMED_RESPONSE",
        "MCP tools/list returned a malformed response",
        { cause: page.error },
      );
    }
    boundedJson(page.data, profile.maxResponseBytes, "MCP tools/list");
    for (const tool of page.data.tools) {
      if (names.has(tool.name)) {
        throw new MCPAdapterError(
          "KAF_MCP_MALFORMED_RESPONSE",
          "MCP tools/list returned a duplicate tool name",
        );
      }
      names.add(tool.name);
      tools.push(
        Object.freeze({
          name: tool.name,
          inputSchemaDigest: mcpToolSchemaDigest(tool.inputSchema),
          outputSchemaDigest: mcpToolSchemaDigest(tool.outputSchema ?? { type: "object" }),
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? { type: "object" },
        }),
      );
      if (tools.length > profile.maxTools) {
        throw new MCPAdapterError(
          "KAF_MCP_LIMIT_EXCEEDED",
          "MCP discovery exceeded the configured tool limit",
        );
      }
    }
    cursor = page.data.nextCursor;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) {
        throw new MCPAdapterError(
          "KAF_MCP_MALFORMED_RESPONSE",
          "MCP discovery returned a repeated cursor",
        );
      }
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return Object.freeze(tools);
}

function verifyServerIdentity(
  profile: MCPTransportSecurityProfile,
  expected: MCPServerIdentity,
  serverVersion: Readonly<{ name: string; version: string }> | undefined,
  capabilities: unknown,
  protocolVersion: string | undefined,
): MCPServerIdentity {
  if (serverVersion === undefined || protocolVersion === undefined) {
    throw new MCPAdapterError(
      "KAF_MCP_MALFORMED_RESPONSE",
      "MCP initialization did not provide complete server identity",
    );
  }
  const parsedCapabilities = boundedJson(
    { serverVersion, capabilities: capabilities ?? {}, protocolVersion },
    profile.maxResponseBytes,
    "MCP initialize",
  ) as Readonly<{ capabilities: JsonValue }>;
  const actual = defineMCPServerIdentity({
    serverName: serverVersion.name,
    serverVersion: serverVersion.version,
    serverArtifactDigest: expected.serverArtifactDigest,
    negotiatedProtocolVersion: protocolVersion,
    negotiatedCapabilities: parsedCapabilities.capabilities,
    transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
  });
  if (
    expected.transportProfileDigest !== profile.mcpTransportSecurityProfileDigest ||
    actual.mcpServerIdentityDigest !== expected.mcpServerIdentityDigest
  ) {
    throw new MCPAdapterError(
      "KAF_MCP_IDENTITY_DRIFT",
      "The negotiated MCP server identity differs from the host pin",
    );
  }
  return actual;
}

async function exposeTools(
  discovered: readonly DiscoveredTool[],
  pins: readonly MCPToolPin[],
  identity: MCPServerIdentity,
  exposure: MCPExposureRequest,
  authority: MCPExposureAuthority,
): Promise<ReadonlyMap<Digest, BoundMCPTool>> {
  const discoveredByName = new Map(discovered.map((tool) => [tool.name, tool]));
  const exposed = new Map<Digest, BoundMCPTool>();
  for (const pin of pins) {
    const discoveredTool = discoveredByName.get(pin.toolName);
    if (discoveredTool === undefined) continue;
    if (
      pin.inputSchemaDigest !== discoveredTool.inputSchemaDigest ||
      pin.outputSchemaDigest !== discoveredTool.outputSchemaDigest
    ) {
      throw new MCPAdapterError("KAF_MCP_TOOL_SCHEMA_DRIFT", "A pinned MCP tool schema changed");
    }
    if (!pin.allowedPurposeCodes.includes(exposure.purposeCode)) continue;
    const authorization = await authority.authorize({
      exposure,
      serverIdentityDigest: identity.mcpServerIdentityDigest,
      toolRegistrationDigest: pin.toolRegistrationDigest,
      requiredScopes: pin.security.requiredScopes,
    });
    if (!authorization.allowed || authorization.grantId === undefined) continue;
    exposed.set(
      pin.toolRegistrationDigest,
      Object.freeze({
        registration: registrationFromPin(pin),
        toolName: pin.toolName,
        serverIdentityDigest: identity.mcpServerIdentityDigest,
        pinDigest: pin.mcpToolPinDigest,
        grantId: authorization.grantId,
        inputValidator: validatorFromJsonSchema(discoveredTool.inputSchema, "input"),
        outputValidator: validatorFromJsonSchema(discoveredTool.outputSchema, "output"),
      }),
    );
  }
  return exposed;
}

export async function connectMCPServer(
  config: MCPAdapterConfig,
  untrustedExposure: MCPExposureRequest,
  authority: MCPExposureAuthority,
  signal: AbortSignal,
): Promise<MCPConnection> {
  const profile = verifyMCPTransportSecurityProfile(config.transportProfile);
  const expectedIdentity = verifyMCPServerIdentity(config.expectedServerIdentity);
  assertServerActive(config, expectedIdentity.mcpServerIdentityDigest);
  const exposure = MCPExposureRequestSchema.parse(untrustedExposure);
  boundedSignal(signal, profile.connectionTimeoutMs);
  const pins = verifyStaticBindings(profile, expectedIdentity, config.toolPins);
  const credentialToolRegistrationDigest =
    config.host.httpCredential?.secretRef.toolRegistrationDigest;
  if (
    credentialToolRegistrationDigest !== undefined &&
    !pins.some((pin) => pin.toolRegistrationDigest === credentialToolRegistrationDigest)
  ) {
    throw new MCPAdapterError(
      "KAF_MCP_CREDENTIAL_BINDING_INVALID",
      "The MCP credential is not bound to a pinned tool registration",
    );
  }
  const client = (config.clientFactory ?? createOfficialMCPProtocolClient)();
  let transport: MCPClientTransport | undefined;
  try {
    audit(config.audit, { operation: "connect", status: "attempted" });
    const transportHost = Object.freeze({
      ...config.host,
      credentialToolRegistrationDigests: pins.map((pin) => pin.toolRegistrationDigest),
    });
    transport = await (config.transportFactory ?? createOfficialMCPTransport)(
      profile,
      transportHost,
      signal,
    );
    const negotiatedProtocolVersion = observeProtocolVersion(transport);
    const connectionSignal = boundedSignal(signal, profile.connectionTimeoutMs);
    await client.connect(transport, {
      signal: connectionSignal,
      timeout: profile.connectionTimeoutMs,
      maxTotalTimeout: profile.connectionTimeoutMs,
    });
    const identity = verifyServerIdentity(
      profile,
      expectedIdentity,
      client.getServerVersion(),
      client.getServerCapabilities(),
      negotiatedProtocolVersion(),
    );
    assertServerActive(config, identity.mcpServerIdentityDigest);
    audit(config.audit, {
      operation: "connect",
      status: "succeeded",
      serverIdentityDigest: identity.mcpServerIdentityDigest,
    });
    const discovered = await discoverTools(client, profile, signal);
    const exposed = await exposeTools(discovered, pins, identity, exposure, authority);
    audit(config.audit, {
      operation: "discover",
      status: "succeeded",
      serverIdentityDigest: identity.mcpServerIdentityDigest,
      itemCount: exposed.size,
    });
    let closed = false;
    return Object.freeze({
      serverIdentity: identity,
      listExposedTools: () => {
        assertServerActive(config, identity.mcpServerIdentityDigest);
        return Object.freeze(
          [...exposed.values()].map((tool) =>
            Object.freeze({
              registration: tool.registration,
              toolName: tool.toolName,
              serverIdentityDigest: tool.serverIdentityDigest,
              pinDigest: tool.pinDigest,
              grantId: tool.grantId,
            }),
          ),
        );
      },
      async callTool(
        toolRegistrationDigest: Digest,
        input: JsonValue,
        callSignal: AbortSignal,
      ): Promise<JsonValue> {
        if (closed) {
          throw new MCPAdapterError("KAF_MCP_CONNECTION_FAILED", "MCP connection is closed");
        }
        assertServerActive(config, identity.mcpServerIdentityDigest);
        audit(config.audit, {
          operation: "call",
          status: "attempted",
          serverIdentityDigest: identity.mcpServerIdentityDigest,
          toolRegistrationDigest,
        });
        const tool = exposed.get(toolRegistrationDigest);
        if (tool === undefined) {
          throw new MCPAdapterError(
            "KAF_MCP_TOOL_NOT_EXPOSED",
            "The MCP tool is not exposed by the pinned host policy",
          );
        }
        const authorization = await authority.authorize({
          exposure,
          serverIdentityDigest: identity.mcpServerIdentityDigest,
          toolRegistrationDigest,
          requiredScopes: tool.registration.security.requiredScopes,
        });
        if (!authorization.allowed || authorization.grantId !== tool.grantId) {
          audit(config.audit, {
            operation: "call",
            status: "denied",
            serverIdentityDigest: identity.mcpServerIdentityDigest,
            toolRegistrationDigest,
            safeCode: "KAF_MCP_EXPOSURE_DENIED",
          });
          throw new MCPAdapterError(
            "KAF_MCP_EXPOSURE_DENIED",
            "MCP authority was revoked or changed",
          );
        }
        const parsedInput = JsonValueSchema.parse(input);
        if (
          new TextEncoder().encode(canonicalJsonStringify(parsedInput)).byteLength >
          profile.maxRequestBytes
        ) {
          throw new MCPAdapterError(
            "KAF_MCP_LIMIT_EXCEEDED",
            "MCP tool arguments exceed their byte limit",
          );
        }
        const argumentsValue = mcpCallArguments(parsedInput);
        if (!tool.inputValidator.safeParse(argumentsValue).success) {
          throw new MCPAdapterError(
            "KAF_MCP_TOOL_INPUT_INVALID",
            "MCP tool arguments do not match the pinned input schema",
          );
        }
        let rawResult: unknown;
        try {
          rawResult = await client.callTool(
            {
              name: tool.toolName,
              arguments: argumentsValue,
            },
            {
              signal: boundedSignal(callSignal, profile.requestTimeoutMs),
              timeout: profile.requestTimeoutMs,
              maxTotalTimeout: profile.requestTimeoutMs,
            },
          );
        } catch (error) {
          if (callSignal.aborted) {
            throw new MCPAdapterError("KAF_MCP_ABORTED", "MCP tool call was cancelled", {
              cause: error,
            });
          }
          const sdkCode =
            typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
          if (sdkCode === -32_602) {
            throw new MCPAdapterError(
              "KAF_MCP_TOOL_OUTPUT_INVALID",
              "MCP tool output does not match the pinned output schema",
              { cause: error },
            );
          }
          throw new MCPAdapterError("KAF_MCP_CONNECTION_FAILED", "MCP tool call failed", {
            cause: error,
          });
        }
        const result = MCPCallResultSchema.safeParse(rawResult);
        if (!result.success) {
          throw new MCPAdapterError(
            "KAF_MCP_MALFORMED_RESPONSE",
            "MCP tools/call returned a malformed response",
            { cause: result.error },
          );
        }
        boundedJson(result.data, profile.maxResponseBytes, "MCP tools/call");
        if (result.data.isError === true) {
          throw new MCPAdapterError(
            "KAF_MCP_CONNECTION_FAILED",
            "The MCP server reported a tool error",
          );
        }
        const output = JsonValueSchema.parse(result.data.structuredContent ?? result.data.content);
        if (!tool.outputValidator.safeParse(output).success) {
          throw new MCPAdapterError(
            "KAF_MCP_TOOL_OUTPUT_INVALID",
            "MCP tool output does not match the pinned output schema",
          );
        }
        audit(config.audit, {
          operation: "call",
          status: "succeeded",
          serverIdentityDigest: identity.mcpServerIdentityDigest,
          toolRegistrationDigest,
        });
        return output;
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await client.close();
        audit(config.audit, {
          operation: "close",
          status: "succeeded",
          serverIdentityDigest: identity.mcpServerIdentityDigest,
        });
      },
    });
  } catch (error) {
    await client.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    audit(config.audit, {
      operation: "connect",
      status: signal.aborted ? "cancelled" : "failed",
      safeCode: error instanceof MCPAdapterError ? error.code : "KAF_MCP_CONNECTION_FAILED",
    });
    if (error instanceof MCPAdapterError) throw error;
    if (signal.aborted) {
      throw new MCPAdapterError("KAF_MCP_ABORTED", "MCP operation was cancelled", {
        cause: error,
      });
    }
    throw new MCPAdapterError("KAF_MCP_CONNECTION_FAILED", "MCP connection failed", {
      cause: error,
    });
  }
}
