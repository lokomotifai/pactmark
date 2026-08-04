import { describe, expect, it } from "vitest";
import {
  defineMCPServerIdentity,
  defineMCPToolPin,
  defineMCPTransportSecurityProfile,
  evaluateMCPReadiness,
  mcpOriginDigest,
  mcpCallArguments,
  verifyMCPServerIdentity,
  verifyMCPToolPin,
  verifyMCPTransportSecurityProfile,
} from "../src/index.js";
import {
  digestA,
  digestB,
  digestC,
  inputSchema,
  outputSchema,
  readSecurity,
  serverIdentity,
  stdioProfile,
} from "./fixtures.js";
import { mcpToolSchemaDigest } from "../src/adapter.js";

describe("MCP identity contracts", () => {
  it("materializes deterministic transport, server, and tool identities", () => {
    const first = stdioProfile({ environmentVariableNames: ["SAFE_B", "SAFE_A"] });
    const second = stdioProfile({ environmentVariableNames: ["SAFE_A", "SAFE_B"] });
    expect(first.environmentVariableNames).toEqual(["SAFE_A", "SAFE_B"]);
    expect(first.mcpTransportSecurityProfileDigest).toBe(second.mcpTransportSecurityProfileDigest);
    const identity = serverIdentity(first);
    const pin = defineMCPToolPin({
      registrationId: "fixture.read@1",
      implementationVersion: "1.0.0",
      serverIdentityDigest: identity.mcpServerIdentityDigest,
      toolName: "fixture_read",
      safeDescription: "Host-authored description",
      inputSchemaDigest: mcpToolSchemaDigest(inputSchema),
      outputSchemaDigest: mcpToolSchemaDigest(outputSchema),
      security: readSecurity,
      allowedPurposeCodes: ["z-purpose", "a-purpose"],
      effectStrategyKind: "read",
      effectStrategyRegistrationDigest: digestC,
    });
    expect(pin.allowedPurposeCodes).toEqual(["a-purpose", "z-purpose"]);
    expect(pin.securityMetadataDigest).toMatch(/^sha256:/u);
    expect(Object.isFrozen(pin)).toBe(true);
  });

  it("rejects ambiguous environment and purpose allowlists", () => {
    expect(() =>
      defineMCPTransportSecurityProfile({
        id: "duplicate-env",
        implementationVersion: "1",
        transport: "stdio",
        executablePath: "/fixture/server",
        executableArtifactDigest: digestA,
        arguments: [],
        workingDirectory: "/fixture",
        environmentVariableNames: ["SAFE", "SAFE"],
        processLimit: 1,
        filesystemPolicyId: "filesystem",
        networkPolicyId: "network",
        connectionTimeoutMs: 100,
        requestTimeoutMs: 100,
        maxRequestBytes: 100,
        maxResponseBytes: 100,
        maxTools: 1,
      }),
    ).toThrow("KAF_MCP_STDIO_ENVIRONMENT_DUPLICATE");
    const identity = serverIdentity(stdioProfile());
    expect(() =>
      defineMCPToolPin({
        registrationId: "fixture.read@1",
        implementationVersion: "1",
        serverIdentityDigest: identity.mcpServerIdentityDigest,
        toolName: "fixture_read",
        safeDescription: "safe",
        inputSchemaDigest: digestA,
        outputSchemaDigest: digestB,
        security: readSecurity,
        allowedPurposeCodes: ["same", "same"],
        effectStrategyKind: "read",
        effectStrategyRegistrationDigest: digestC,
      }),
    ).toThrow("KAF_MCP_PURPOSE_DUPLICATE");
  });

  it("normalizes HTTP origins and rejects credentials embedded in endpoints", () => {
    const profile = defineMCPTransportSecurityProfile({
      id: "remote",
      implementationVersion: "1",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc?tenant=fixed",
      trustedPrivateEndpoint: false,
      connectionTimeoutMs: 100,
      requestTimeoutMs: 100,
      maxRequestBytes: 100,
      maxResponseBytes: 100,
      maxTools: 2,
    });
    expect(profile.exactOrigin).toBe("https://mcp.example.test");
    expect(mcpOriginDigest(profile.exactOrigin)).toMatch(/^sha256:/u);
    expect(() =>
      defineMCPTransportSecurityProfile({
        id: "bad-remote",
        implementationVersion: "1",
        transport: "streamable_http",
        endpoint: "https://user:secret@mcp.example.test/rpc",
        trustedPrivateEndpoint: false,
        connectionTimeoutMs: 100,
        requestTimeoutMs: 100,
        maxRequestBytes: 100,
        maxResponseBytes: 100,
        maxTools: 2,
      }),
    ).toThrow("KAF_MCP_HTTP_ENDPOINT_INVALID");
  });

  it("reports preview and production stdio readiness honestly", () => {
    const profile = stdioProfile();
    expect(evaluateMCPReadiness(profile, { runtimeProfile: "preview" }).ready).toBe(true);
    const notReady = evaluateMCPReadiness(profile, { runtimeProfile: "production" });
    expect(notReady.ready).toBe(false);
    expect(notReady.checks[1]?.code).toBe("KAF_MCP_STDIO_SANDBOX_READY");
    const ready = evaluateMCPReadiness(profile, {
      runtimeProfile: "production",
      productionSandbox: {
        transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
        capabilities: {
          processIsolation: true,
          filesystemIsolation: true,
          networkIsolation: true,
          resourceLimits: true,
        },
        verifyExecutable: () => Promise.resolve(true),
        launch: () => Promise.reject(new Error("not launched by readiness")),
      },
    });
    expect(ready.ready).toBe(true);
  });

  it("includes exact negotiated capabilities in the server identity", () => {
    const profile = stdioProfile();
    const first = defineMCPServerIdentity({
      serverName: "server",
      serverVersion: "1",
      serverArtifactDigest: digestA,
      negotiatedProtocolVersion: "2025-11-25",
      negotiatedCapabilities: { tools: {} },
      transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
    });
    const second = defineMCPServerIdentity({
      serverName: first.serverName,
      serverVersion: first.serverVersion,
      serverArtifactDigest: first.serverArtifactDigest,
      negotiatedProtocolVersion: first.negotiatedProtocolVersion,
      negotiatedCapabilities: { tools: { listChanged: true } },
      transportProfileDigest: first.transportProfileDigest,
    });
    expect(first.mcpServerIdentityDigest).not.toBe(second.mcpServerIdentityDigest);
  });

  it("accepts only ordinary JSON objects as MCP call arguments", () => {
    expect(mcpCallArguments({ value: "ok" })).toEqual({ value: "ok" });
    expect(() => mcpCallArguments(null)).toThrow("MCP tool arguments");
    expect(() => mcpCallArguments([])).toThrow("MCP tool arguments");
  });

  it("rejects drift in claimed transport, server, and tool pin digests", () => {
    const profile = stdioProfile();
    expect(() => verifyMCPTransportSecurityProfile({ ...profile, requestTimeoutMs: 101 })).toThrow(
      "transport security profile digest",
    );
    const identity = serverIdentity(profile);
    expect(() => verifyMCPServerIdentity({ ...identity, serverVersion: "tampered" })).toThrow(
      "server identity digest",
    );
    const pin = defineMCPToolPin({
      registrationId: "fixture.read@1",
      implementationVersion: "1",
      serverIdentityDigest: identity.mcpServerIdentityDigest,
      toolName: "fixture_read",
      safeDescription: "safe",
      inputSchemaDigest: digestA,
      outputSchemaDigest: digestB,
      security: readSecurity,
      allowedPurposeCodes: ["fixture.read"],
      effectStrategyKind: "read",
      effectStrategyRegistrationDigest: digestC,
    });
    expect(() => verifyMCPToolPin({ ...pin, safeDescription: "tampered" })).toThrow(
      "tool pin digest",
    );
    expect(verifyMCPTransportSecurityProfile(profile)).toEqual(profile);
    expect(verifyMCPServerIdentity(identity)).toEqual(identity);
    expect(verifyMCPToolPin(pin)).toEqual(pin);
  });
});
