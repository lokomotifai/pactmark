import { describe, expect, it } from "vitest";

import { digestCanonicalJson, type JsonValue, type ToolSecurity } from "@pactmark/core";
import {
  connectMCPServer,
  defineMCPServerIdentity,
  defineMCPToolPin,
  defineMCPTransportSecurityProfile,
  mcpToolOutputSchemaDigest,
  mcpToolSchemaDigest,
  type MCPClientTransport,
  type MCPExposureAuthority,
} from "@pactmark/mcp";

import {
  createExecutorToolExecutor,
  defineExecutorDeploymentProfile,
  defineExecutorSelfHostConformanceReceipt,
  defineExecutorToolPin,
  executorConnectionBindingDigest,
  executorSelfHostManifestDigest,
} from "../src/index.js";

const evaluatedAt = "2026-08-11T16:30:00.000Z";
const conformanceReceipt = defineExecutorSelfHostConformanceReceipt({
  platform: "linux/arm64",
  containerRuntimeVersion: "29.3.1",
  environmentDigest: digestCanonicalJson("executor-conformance-environment"),
  observedAt: "2026-08-11T16:00:00.000Z",
  expiresAt: "2026-08-18T15:59:59.000Z",
  checks: {
    imagePinMatched: true,
    sourceRevisionMatched: true,
    mainProcessNonRoot: true,
    readOnlyRootFilesystem: true,
    capabilitiesDropped: true,
    noNewPrivileges: true,
    resourceLimitsApplied: true,
    dedicatedDataVolume: true,
    restartPersistence: true,
    backupRestore: true,
    telemetryDisabled: true,
    analyticsIdAbsent: true,
    outboundNetworkDenied: true,
    privateNetworkDenied: true,
    stdioMcpDisabled: true,
    bootstrapCompleted: true,
    unauthenticatedMcpDenied: true,
    apiKeyMcpAuthenticated: true,
    oauthPkceAuthenticated: true,
    crossTenantCredentialDenied: true,
    credentialCanariesAbsent: true,
    executeEnvelopeMatched: true,
  },
});
const deploymentProfile = defineExecutorDeploymentProfile({
  tenantId: "tenant-a",
  executorOrigin: "https://executor.example",
  opaqueConnectionRef: "records-main",
  backupPolicyId: "executor-backup-policy",
  receipt: conformanceReceipt,
  evaluatedAt,
});

const readSecurity: ToolSecurity = {
  schemaVersion: "1",
  riskClass: "R1",
  dataClasses: ["internal"],
  reversibility: "not_applicable",
  requiredScopes: ["records:read"],
  egress: {
    mode: "allowlist",
    destinations: ["https://api.example.com"],
    methods: ["GET"],
    credentialSlots: ["executor-connection"],
  },
  networkEnforcement: "declared_ok",
  maxCallsPerRun: 1,
  timeoutMs: 1_000,
};

const executeInputSchema = {
  type: "object",
  properties: { code: { type: "string" } },
  required: ["code"],
  additionalProperties: false,
} as const;

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ExecutorWireTransport implements MCPClientTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JsonValue) => void;
  setProtocolVersion?: (version: string) => void;
  readonly toolCalls: JsonValue[] = [];

  start(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }

  send(message: JsonValue): Promise<void> {
    if (!isRecord(message) || !("method" in message) || !("id" in message)) {
      return Promise.resolve();
    }
    const requestId = message.id;
    const respond = (result: JsonValue): void => {
      this.onmessage?.({ jsonrpc: "2.0", id: requestId, result });
    };
    if (message.method === "initialize") {
      respond({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "executor", version: "1.5.40" },
      });
    } else if (message.method === "tools/list") {
      respond({
        tools: [
          {
            name: "execute",
            description: "Untrusted generic code execution description",
            inputSchema: executeInputSchema,
          },
        ],
      });
    } else if (message.method === "tools/call") {
      this.toolCalls.push(message);
      respond({
        content: [],
        structuredContent: {
          status: "completed",
          result: { items: ["record-a"] },
          logs: [],
        },
      });
    }
    return Promise.resolve();
  }
}

describe("Executor MCP composition", () => {
  it("pins Executor execute on the wire but exposes only the reviewed virtual tool", async () => {
    const profile = defineMCPTransportSecurityProfile({
      id: "executor-http",
      implementationVersion: "1.5.40",
      transport: "streamable_http",
      endpoint: "https://executor.example/mcp",
      trustedPrivateEndpoint: false,
      connectionTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      maxRequestBytes: 16_384,
      maxResponseBytes: 16_384,
      maxTools: 4,
    });
    const identity = defineMCPServerIdentity({
      serverName: "executor",
      serverVersion: "1.5.40",
      serverArtifactDigest: executorSelfHostManifestDigest("linux/arm64"),
      negotiatedProtocolVersion: "2025-11-25",
      negotiatedCapabilities: { tools: {} },
      transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
    });
    const executePin = defineMCPToolPin({
      registrationId: "executor.execute@1",
      implementationVersion: "1.5.40",
      serverIdentityDigest: identity.mcpServerIdentityDigest,
      toolName: "execute",
      safeDescription: "Host-only Executor execution bridge",
      inputSchemaDigest: mcpToolSchemaDigest(executeInputSchema),
      outputSchemaDigest: mcpToolOutputSchemaDigest(undefined),
      security: readSecurity,
      allowedPurposeCodes: ["records.read"],
      effectStrategyKind: "read",
      effectStrategyRegistrationDigest: digestCanonicalJson("mcp-read-effect"),
    });
    const authority: MCPExposureAuthority = {
      authorize: () => Promise.resolve({ allowed: true, grantId: "grant-executor" }),
    };
    const transport = new ExecutorWireTransport();
    const connection = await connectMCPServer(
      {
        transportProfile: profile,
        expectedServerIdentity: identity,
        toolPins: [executePin],
        host: { runtimeProfile: "preview" },
        transportFactory: () => Promise.resolve(transport),
      },
      {
        schemaVersion: "1",
        tenantId: "tenant-a",
        runId: "run-a",
        workOrderBindingDigest: digestCanonicalJson("work-order-binding"),
        purposeCode: "records.read",
      },
      authority,
      new AbortController().signal,
    );
    const upstreamPin = defineExecutorToolPin({
      registrationId: "records.list@1",
      implementationVersion: "1.0.0",
      serverIdentityDigest: identity.mcpServerIdentityDigest,
      executeToolRegistrationDigest: executePin.toolRegistrationDigest,
      connectionBindingDigest: executorConnectionBindingDigest({
        tenantId: "tenant-a",
        executorOrigin: "https://executor.example",
        opaqueConnectionRef: "records-main",
      }),
      toolAddress: "records.org.main.rows.list",
      safeDescription: "List reviewed records",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { items: { type: "array", items: { type: "string" } } },
        required: ["items"],
        additionalProperties: false,
      },
      security: readSecurity,
      effectStrategyRegistrationDigest: digestCanonicalJson("pactmark-read-effect"),
    });
    const executor = createExecutorToolExecutor({
      connection,
      executeToolRegistrationDigest: executePin.toolRegistrationDigest,
      toolPins: [upstreamPin],
      deploymentProfile,
      conformanceReceipt,
      evaluatedAt,
    });

    expect(connection.listExposedTools().map((tool) => tool.toolName)).toEqual(["execute"]);
    expect(executor.listRegistrations().map((registration) => registration.id)).toEqual([
      "records.list@1",
    ]);
    await expect(
      executor.execute({
        registration: executor.listRegistrations()[0]!,
        input: { query: "active" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ items: ["record-a"] });
    expect(transport.toolCalls).toHaveLength(1);
    expect(transport.toolCalls[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: "execute",
        arguments: {
          code: [
            String.raw`const input = JSON.parse("{\"query\":\"active\"}");`,
            'return await tools["records.org.main.rows.list"](input);',
          ].join("\n"),
        },
      },
    });
    await connection.close();
  });
});
