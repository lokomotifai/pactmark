import { describe, expect, it, vi } from "vitest";
import {
  ResolvedToolCredential,
  SecretRefSchema,
  SecretResolutionBindingSchema,
  type EgressHttpClient,
} from "@pactmark/core";
import {
  connectMCPServer,
  createOfficialMCPTransport,
  defineMCPServerIdentity,
  defineMCPToolPin,
  defineMCPTransportSecurityProfile,
  evaluateMCPReadiness,
  mcpOriginDigest,
  mcpToolSchemaDigest,
  type MCPHttpCredentialBinding,
  type MCPHttpEgressBoundary,
  type MCPHttpTransportSecurityProfile,
} from "../src/index.js";
import {
  digestA,
  digestB,
  digestC,
  digestD,
  exposure,
  inputSchema,
  outputSchema,
  readSecurity,
} from "./fixtures.js";

function httpFixture(credentialSlot?: string) {
  const profile = defineMCPTransportSecurityProfile({
    id: "fixture-http",
    implementationVersion: "1",
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/rpc",
    trustedPrivateEndpoint: false,
    ...(credentialSlot === undefined ? {} : { credentialSlot }),
    connectionTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    maxRequestBytes: 8_192,
    maxResponseBytes: 8_192,
    maxTools: 8,
  });
  const identity = defineMCPServerIdentity({
    serverName: "fixture-http-server",
    serverVersion: "2.0.0",
    serverArtifactDigest: digestB,
    negotiatedProtocolVersion: "2025-11-25",
    negotiatedCapabilities: { tools: {} },
    transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
  });
  const pin = defineMCPToolPin({
    registrationId: "fixture.http_read@1",
    implementationVersion: "1",
    serverIdentityDigest: identity.mcpServerIdentityDigest,
    toolName: "fixture_read",
    safeDescription: "Pinned HTTP fixture reader",
    inputSchemaDigest: mcpToolSchemaDigest(inputSchema),
    outputSchemaDigest: mcpToolSchemaDigest(outputSchema),
    security: readSecurity,
    allowedPurposeCodes: ["fixture.read"],
    effectStrategyKind: "read",
    effectStrategyRegistrationDigest: digestC,
  });
  return { profile, identity, pin };
}

function fakeHttpServer(inspect?: (url: URL, init: RequestInit) => void): EgressHttpClient {
  return {
    fetch: (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      inspect?.(url, init);
      if (init.method === "DELETE") return Promise.resolve(new Response(null, { status: 200 }));
      if (typeof init.body !== "string") throw new TypeError("Expected an SDK JSON body");
      const body = JSON.parse(init.body) as {
        id?: string | number;
        method: string;
      };
      if (body.id === undefined) return Promise.resolve(new Response(null, { status: 202 }));
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture-http-server", version: "2.0.0" },
            }
          : body.method === "tools/list"
            ? {
                tools: [{ name: "fixture_read", inputSchema, outputSchema }],
              }
            : { content: [], structuredContent: { echo: "http-ok" } };
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "fixture-session",
          },
        }),
      );
    },
  };
}

function enforcedBoundary(
  profile: MCPHttpTransportSecurityProfile,
  client: EgressHttpClient,
): MCPHttpEgressBoundary {
  return {
    transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
    exactEndpoint: profile.endpoint,
    capabilities: {
      dnsRebindingProtection: true,
      redirectOriginEnforcement: true,
      credentialOriginEnforcement: true,
      requestResponseLimits: true,
    },
    validateResolvedEndpoint: () => Promise.resolve(),
    client,
  };
}

describe("Streamable HTTP transport", () => {
  it("discovers and calls a fake Streamable HTTP server only through injected egress", async () => {
    const { profile, identity, pin } = httpFixture();
    const observed = vi.fn<(url: URL, init: RequestInit) => void>();
    const connection = await connectMCPServer(
      {
        transportProfile: profile,
        expectedServerIdentity: identity,
        toolPins: [pin],
        host: { runtimeProfile: "preview", egress: fakeHttpServer(observed) },
      },
      exposure,
      { authorize: () => Promise.resolve({ allowed: true, grantId: "grant-http" }) },
      new AbortController().signal,
    );
    await expect(
      connection.callTool(
        connection.listExposedTools()[0]!.registration.toolRegistrationDigest,
        { value: "http" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ echo: "http-ok" });
    await connection.close();
    expect(observed).toHaveBeenCalled();
    for (const [url, init] of observed.mock.calls) {
      expect(url.href).toBe("https://mcp.example.test/rpc");
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
    }
  });

  it("requires injected egress and denies private or insecure endpoints", async () => {
    const { profile } = httpFixture();
    await expect(
      createOfficialMCPTransport(profile, { runtimeProfile: "preview" }),
    ).rejects.toMatchObject({ code: "KAF_MCP_EGRESS_REQUIRED" });

    expect(() =>
      defineMCPTransportSecurityProfile({
        id: "insecure-private",
        implementationVersion: "1",
        transport: "streamable_http",
        endpoint: "http://169.254.169.254/latest",
        trustedPrivateEndpoint: false,
        connectionTimeoutMs: 100,
        requestTimeoutMs: 100,
        maxRequestBytes: 100,
        maxResponseBytes: 100,
        maxTools: 1,
      }),
    ).toThrow();
    const privateProfile = defineMCPTransportSecurityProfile({
      id: "private",
      implementationVersion: "1",
      transport: "streamable_http",
      endpoint: "https://169.254.169.254/latest",
      trustedPrivateEndpoint: false,
      connectionTimeoutMs: 100,
      requestTimeoutMs: 100,
      maxRequestBytes: 100,
      maxResponseBytes: 100,
      maxTools: 1,
    });
    await expect(
      createOfficialMCPTransport(privateProfile, {
        runtimeProfile: "preview",
        egress: fakeHttpServer(),
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_HTTP_ENDPOINT_DENIED" });
    const readiness = evaluateMCPReadiness(profile, { runtimeProfile: "production" });
    expect(readiness.ready).toBe(false);
    expect(readiness.checks[0]?.code).toBe("KAF_MCP_HTTP_EGRESS_READY");
    expect(
      evaluateMCPReadiness(profile, {
        runtimeProfile: "production",
        egress: fakeHttpServer(),
      }).ready,
    ).toBe(false);
    expect(
      evaluateMCPReadiness(profile, {
        runtimeProfile: "production",
        httpEgressBoundary: enforcedBoundary(profile, fakeHttpServer()),
      }).ready,
    ).toBe(true);

    const loopbackProfile = defineMCPTransportSecurityProfile({
      id: "trusted-loopback",
      implementationVersion: "1",
      transport: "streamable_http",
      endpoint: "https://127.0.0.1:8443/rpc",
      trustedPrivateEndpoint: true,
      connectionTimeoutMs: 100,
      requestTimeoutMs: 100,
      maxRequestBytes: 100,
      maxResponseBytes: 100,
      maxTools: 1,
    });
    const loopbackServer = fakeHttpServer();
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      loopbackServer.fetch(input, init),
    );
    await expect(
      createOfficialMCPTransport(loopbackProfile, {
        runtimeProfile: "preview",
        egress: { fetch },
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_HTTP_ENDPOINT_DENIED" });
    expect(fetch).not.toHaveBeenCalled();
    const trustedHostCapability = {
      transportProfileDigest: loopbackProfile.mcpTransportSecurityProfileDigest,
      exactOrigin: loopbackProfile.exactOrigin,
    };
    const loopback = await createOfficialMCPTransport(loopbackProfile, {
      runtimeProfile: "preview",
      egress: { fetch },
      trustedHostCapability,
    });
    await loopback.close();
    expect(
      evaluateMCPReadiness(loopbackProfile, {
        runtimeProfile: "production",
        httpEgressBoundary: enforcedBoundary(loopbackProfile, { fetch }),
        trustedHostCapability,
      }).ready,
    ).toBe(true);

    expect(() =>
      defineMCPTransportSecurityProfile({
        id: "insecure-loopback",
        implementationVersion: "1",
        transport: "streamable_http",
        endpoint: "http://127.0.0.1:8080/rpc",
        trustedPrivateEndpoint: true,
        connectionTimeoutMs: 100,
        requestTimeoutMs: 100,
        maxRequestBytes: 100,
        maxResponseBytes: 100,
        maxTools: 1,
      }),
    ).toThrow();
  });

  it("classifies textual private, metadata, and public hosts fail closed", () => {
    const profileFor = (id: string, hostname: string) =>
      defineMCPTransportSecurityProfile({
        id,
        implementationVersion: "1",
        transport: "streamable_http",
        endpoint: `https://${hostname}/rpc`,
        trustedPrivateEndpoint: false,
        connectionTimeoutMs: 100,
        requestTimeoutMs: 100,
        maxRequestBytes: 100,
        maxResponseBytes: 100,
        maxTools: 1,
      });
    const privateHosts = [
      "localhost",
      "agent.localhost",
      "agent.local",
      "metadata.google.internal",
      "0.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "[::]",
      "[::1]",
      "[fc00::1]",
      "[fe80::1]",
      "[::ffff:10.0.0.1]",
    ];
    for (const [index, hostname] of privateHosts.entries()) {
      const readiness = evaluateMCPReadiness(profileFor(`private-${String(index)}`, hostname), {
        runtimeProfile: "preview",
        egress: fakeHttpServer(),
      });
      expect(readiness.checks[2]?.passed, hostname).toBe(false);
    }
    for (const [index, hostname] of [
      "example.test",
      "8.8.8.8",
      "100.63.255.255",
      "172.15.255.255",
      "198.20.0.1",
      "223.255.255.255",
      "[2001:4860:4860::8888]",
    ].entries()) {
      const readiness = evaluateMCPReadiness(profileFor(`public-${String(index)}`, hostname), {
        runtimeProfile: "preview",
        httpEgressBoundary: enforcedBoundary(
          profileFor(`public-boundary-${String(index)}`, hostname),
          fakeHttpServer(),
        ),
      });
      expect(readiness.checks[2]?.passed, hostname).toBe(true);
    }
  });

  it("rejects drifted or ambiguous enforced HTTP boundaries before use", async () => {
    const { profile } = httpFixture();
    const egress = fakeHttpServer();
    await expect(
      createOfficialMCPTransport(profile, {
        runtimeProfile: "production",
        httpEgressBoundary: {
          ...enforcedBoundary(profile, egress),
          exactEndpoint: "https://other.example.test/rpc",
        },
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_IDENTITY_DRIFT" });
    await expect(
      createOfficialMCPTransport(profile, {
        runtimeProfile: "production",
        egress,
        httpEgressBoundary: enforcedBoundary(profile, egress),
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_EGRESS_REQUIRED" });
  });

  it("routes production bytes only through the enforced boundary and never global fetch", async () => {
    const { profile, identity, pin } = httpFixture();
    const boundaryServer = fakeHttpServer();
    const boundaryFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      boundaryServer.fetch(input, init),
    );
    const validateResolvedEndpoint = vi.fn(() => Promise.resolve());
    const globalFetch = vi.fn(() => Promise.reject(new Error("global fetch must stay unused")));
    vi.stubGlobal("fetch", globalFetch);
    try {
      const connection = await connectMCPServer(
        {
          transportProfile: profile,
          expectedServerIdentity: identity,
          toolPins: [pin],
          host: {
            runtimeProfile: "production",
            httpEgressBoundary: {
              ...enforcedBoundary(profile, { fetch: boundaryFetch }),
              validateResolvedEndpoint,
            },
          },
        },
        exposure,
        { authorize: () => Promise.resolve({ allowed: true, grantId: "grant-http" }) },
        new AbortController().signal,
      );
      await expect(
        connection.callTool(
          connection.listExposedTools()[0]!.registration.toolRegistrationDigest,
          { value: "production" },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ echo: "http-ok" });
      await connection.close();
      expect(boundaryFetch).toHaveBeenCalled();
      expect(validateResolvedEndpoint).toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("denies redirects, oversized requests, and declared oversized responses", async () => {
    const { profile } = httpFixture();
    const redirect = await createOfficialMCPTransport(profile, {
      runtimeProfile: "preview",
      egress: {
        fetch: () =>
          Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://evil.example.test/steal" },
            }),
          ),
      },
    });
    await redirect.start();
    await expect(
      redirect.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { huge: "x" },
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_HTTP_REDIRECT_DENIED" });
    await redirect.close();

    const smallRequestProfile = defineMCPTransportSecurityProfile({
      id: "small-request",
      implementationVersion: "1",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      trustedPrivateEndpoint: false,
      connectionTimeoutMs: 100,
      requestTimeoutMs: 100,
      maxRequestBytes: 1,
      maxResponseBytes: 100,
      maxTools: 1,
    });
    const smallRequest = await createOfficialMCPTransport(smallRequestProfile, {
      runtimeProfile: "preview",
      egress: fakeHttpServer(),
    });
    await smallRequest.start();
    await expect(
      smallRequest.send({ jsonrpc: "2.0", id: 1, method: "ping" }),
    ).rejects.toMatchObject({ code: "KAF_MCP_LIMIT_EXCEEDED" });
    await smallRequest.close();

    const declaredOversized = await createOfficialMCPTransport(profile, {
      runtimeProfile: "preview",
      egress: {
        fetch: () =>
          Promise.resolve(
            new Response("{}", {
              status: 200,
              headers: {
                "content-type": "application/json",
                "content-length": "999999",
              },
            }),
          ),
      },
    });
    await declaredOversized.start();
    await expect(
      declaredOversized.send({ jsonrpc: "2.0", id: 1, method: "ping" }),
    ).rejects.toMatchObject({ code: "KAF_MCP_LIMIT_EXCEEDED" });
    await declaredOversized.close();

    const invalidLength = await createOfficialMCPTransport(profile, {
      runtimeProfile: "preview",
      egress: {
        fetch: () =>
          Promise.resolve(
            new Response("{}", {
              status: 200,
              headers: {
                "content-type": "application/json",
                "content-length": "not-a-number",
              },
            }),
          ),
      },
    });
    await invalidLength.start();
    await expect(
      invalidLength.send({ jsonrpc: "2.0", id: 1, method: "ping" }),
    ).rejects.toMatchObject({ code: "KAF_MCP_MALFORMED_RESPONSE" });
    await invalidLength.close();
  });

  it("resolves only an origin-bound SecretRef and strips ambient authorization", async () => {
    const { profile, identity, pin } = httpFixture("mcp-token");
    const originDigest = mcpOriginDigest(profile.exactOrigin);
    const secretRef = SecretRefSchema.parse({
      schemaVersion: "1",
      credentialKind: "tool",
      refId: "secret-a",
      issuerId: "issuer-a",
      tenantId: "tenant-a",
      authoritySubject: "subject-a",
      workOrderBindingDigest: digestD,
      executionDefinitionKind: "agent",
      executionDefinitionDigest: digestA,
      grantId: "grant-a",
      toolId: "fixture.http_read",
      toolVersion: "1",
      toolRegistrationDigest: pin.toolRegistrationDigest,
      credentialSlot: "mcp-token",
      normalizedDestinationDigest: originDigest,
      purpose: "fixture.read",
      maximumUses: 2,
      issuedAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2026-08-04T00:00:00.000Z",
    });
    const resolutionBinding = SecretResolutionBindingSchema.parse({
      schemaVersion: "1",
      authorizationReservationId: "reservation-a",
      tenantId: "tenant-a",
      workOrderBindingDigest: digestD,
      executionDefinitionDigest: digestA,
      grantId: "grant-a",
      toolRegistrationDigest: pin.toolRegistrationDigest,
      credentialSlot: "mcp-token",
      normalizedDestinationDigest: originDigest,
    });
    const resolver = vi.fn(() => Promise.resolve(ResolvedToolCredential.fromAdapter("sealed")));
    const headers: string[] = [];
    const connection = await connectMCPServer(
      {
        transportProfile: profile,
        expectedServerIdentity: identity,
        toolPins: [pin],
        host: {
          runtimeProfile: "preview",
          egress: fakeHttpServer((_url, init) => {
            headers.push(new Headers(init.headers).get("authorization") ?? "missing");
          }),
          secretResolver: { resolverId: "fixture", resolve: resolver },
          httpCredential: { secretRef, resolutionBinding, expectedOriginDigest: originDigest },
        },
      },
      exposure,
      { authorize: () => Promise.resolve({ allowed: true, grantId: "grant-http" }) },
      new AbortController().signal,
    );
    await connection.close();
    expect(resolver).toHaveBeenCalledOnce();
    expect(headers.every((header) => header === "Bearer sealed")).toBe(true);

    await expect(
      createOfficialMCPTransport(profile, {
        runtimeProfile: "preview",
        egress: fakeHttpServer(),
        secretResolver: { resolverId: "fixture", resolve: resolver },
        httpCredential: { secretRef, resolutionBinding, expectedOriginDigest: digestA },
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_CREDENTIAL_BINDING_INVALID" });

    const deniedResolver = vi.fn(() => Promise.resolve(ResolvedToolCredential.fromAdapter("bad")));
    const deniedServer = fakeHttpServer();
    const deniedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      deniedServer.fetch(input, init),
    );
    await expect(
      connectMCPServer(
        {
          transportProfile: profile,
          expectedServerIdentity: identity,
          toolPins: [],
          host: {
            runtimeProfile: "preview",
            egress: { fetch: deniedFetch },
            secretResolver: { resolverId: "fixture", resolve: deniedResolver },
            httpCredential: { secretRef, resolutionBinding, expectedOriginDigest: originDigest },
          },
        },
        exposure,
        { authorize: () => Promise.resolve({ allowed: true, grantId: "grant-http" }) },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "KAF_MCP_CREDENTIAL_BINDING_INVALID" });
    expect(deniedResolver).not.toHaveBeenCalled();
    expect(deniedFetch).not.toHaveBeenCalled();
  });

  it("fails closed when HTTP credential presence disagrees with the profile", async () => {
    const withoutSlot = httpFixture().profile;
    await expect(
      createOfficialMCPTransport(withoutSlot, {
        runtimeProfile: "preview",
        egress: fakeHttpServer(),
        httpCredential: {} as MCPHttpCredentialBinding,
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_CREDENTIAL_BINDING_INVALID" });

    const withSlot = httpFixture("required-token").profile;
    await expect(
      createOfficialMCPTransport(withSlot, {
        runtimeProfile: "preview",
        egress: fakeHttpServer(),
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_CREDENTIAL_BINDING_INVALID" });
  });

  it("stops a streamed response after its byte limit", async () => {
    const profile = defineMCPTransportSecurityProfile({
      id: "stream-limit",
      implementationVersion: "1",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      trustedPrivateEndpoint: false,
      connectionTimeoutMs: 100,
      requestTimeoutMs: 100,
      maxRequestBytes: 1_000,
      maxResponseBytes: 8,
      maxTools: 1,
    });
    const transport = await createOfficialMCPTransport(profile, {
      runtimeProfile: "preview",
      egress: {
        fetch: () => Promise.resolve(new Response("response-is-too-large", { status: 200 })),
      },
    });
    await transport.start();
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toBeDefined();
    await transport.close();
  });

  it("propagates cancellation through Streamable HTTP egress", async () => {
    const { profile, identity, pin } = httpFixture();
    const base = fakeHttpServer();
    let markCallStarted: (() => void) | undefined;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    const egress: EgressHttpClient = {
      fetch: (input, init = {}) => {
        if (typeof init.body !== "string") return base.fetch(input, init);
        const body = JSON.parse(init.body) as { method?: string };
        if (body.method !== "tools/call") return base.fetch(input, init);
        markCallStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("cancelled", "AbortError"));
            },
            { once: true },
          );
        });
      },
    };
    const connection = await connectMCPServer(
      {
        transportProfile: profile,
        expectedServerIdentity: identity,
        toolPins: [pin],
        host: { runtimeProfile: "preview", egress },
      },
      exposure,
      { authorize: () => Promise.resolve({ allowed: true, grantId: "grant-http" }) },
      new AbortController().signal,
    );
    const controller = new AbortController();
    const pending = connection.callTool(
      connection.listExposedTools()[0]!.registration.toolRegistrationDigest,
      { value: "wait" },
      controller.signal,
    );
    await callStarted;
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await connection.close();
  });
});
