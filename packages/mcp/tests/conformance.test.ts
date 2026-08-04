import { runMCPUntrustedToolAdapterContract } from "@pactmark/testing";
import { expect, it } from "vitest";

import { connectMCPServer, type MCPExposureAuthority } from "../src/index.js";
import {
  FakeMCPServerTransport,
  digestA,
  exposure,
  serverIdentity,
  stdioProfile,
  toolPin,
} from "./fixtures.js";

function jsonObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

class ContractTransport extends FakeMCPServerTransport {
  protocolCalls = 0;

  override send(message: Parameters<FakeMCPServerTransport["send"]>[0]): Promise<void> {
    if (
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      message["method"] === "tools/call" &&
      "id" in message
    ) {
      this.received.push(message);
      this.protocolCalls += 1;
      const parameters = jsonObject(message["params"]);
      const argumentsValue = jsonObject(parameters?.["arguments"]);
      const mode = argumentsValue?.["mode"];
      const result =
        mode === "malformed"
          ? { unexpected: true }
          : mode === "failure"
            ? { content: [], isError: true }
            : { content: [], structuredContent: { echo: "ok" } };
      this.onmessage?.({ jsonrpc: "2.0", id: message["id"], result });
      return Promise.resolve();
    }
    return super.send(message);
  }
}

function authorityForTenant(tenantId: string): MCPExposureAuthority {
  return {
    authorize: ({ exposure: requestedExposure }) =>
      Promise.resolve(
        requestedExposure.tenantId === tenantId
          ? { allowed: true, grantId: `grant-${tenantId}` }
          : { allowed: false },
      ),
  };
}

it("passes the untrusted MCP adapter contract", async () => {
  const profile = stdioProfile();
  const identity = serverIdentity(profile);
  const pin = toolPin(identity);
  const transport = new ContractTransport();
  const connection = await connectMCPServer(
    {
      transportProfile: profile,
      expectedServerIdentity: identity,
      toolPins: [pin],
      host: {
        runtimeProfile: "preview",
        previewStdioTransportFactory: () => transport,
      },
    },
    exposure,
    authorityForTenant("tenant-a"),
    new AbortController().signal,
  );
  const crossTenantTransport = new ContractTransport();
  const crossTenantConnection = await connectMCPServer(
    {
      transportProfile: profile,
      expectedServerIdentity: identity,
      toolPins: [pin],
      host: {
        runtimeProfile: "preview",
        previewStdioTransportFactory: () => crossTenantTransport,
      },
    },
    { ...exposure, tenantId: "tenant-b" },
    authorityForTenant("tenant-a"),
    new AbortController().signal,
  );
  const exposedDigest = connection.listExposedTools()[0]!.registration.toolRegistrationDigest;
  const sensitiveErrorMarker = "mcp-secret-canary";

  try {
    const report = await runMCPUntrustedToolAdapterContract(() => ({
      exposedToolDigest: exposedDigest,
      unexposedToolDigest: digestA,
      input: { value: "hello" },
      expectedOutput: { echo: "ok" },
      malformedResponseInput: { mode: "malformed" },
      failureInput: { mode: "failure", marker: sensitiveErrorMarker },
      sensitiveErrorMarker,
      declaredCancellation: true,
      errorSurface: (error) => ({
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "KAF_MCP_CONNECTION_FAILED",
      }),
      callAuthorized: (input, signal) => connection.callTool(exposedDigest, input as never, signal),
      callUnexposed: (toolDigest, signal) => connection.callTool(toolDigest, {}, signal),
      callCrossTenant: (signal) => crossTenantConnection.callTool(exposedDigest, {}, signal),
      protocolDispatchCount: () => transport.protocolCalls + crossTenantTransport.protocolCalls,
    }));
    expect(report.suite).toBe("MCPUntrustedToolAdapter");
  } finally {
    await connection.close();
    await crossTenantConnection.close();
  }
});
