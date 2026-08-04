import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  connectMCPServer,
  createOfficialMCPTransport,
  defineMCPServerIdentity,
  defineMCPToolPin,
  mcpToolSchemaDigest,
} from "../src/index.js";
import {
  FakeMCPServerTransport,
  digestC,
  exposure,
  inputSchema,
  outputSchema,
  readSecurity,
  stdioProfile,
} from "./fixtures.js";

describe("stdio transport boundary", () => {
  it("passes only the exact resolved environment to a preview transport", async () => {
    const profile = stdioProfile({ environmentVariableNames: ["SAFE_TOKEN"] });
    const factory = vi.fn(() => new FakeMCPServerTransport());
    await createOfficialMCPTransport(profile, {
      runtimeProfile: "preview",
      stdioEnvironmentResolver: {
        resolve: (names) => {
          expect(names).toEqual(["SAFE_TOKEN"]);
          return Promise.resolve({ SAFE_TOKEN: "sealed-value" });
        },
      },
      previewStdioTransportFactory: factory,
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { SAFE_TOKEN: "sealed-value" },
        shell: false,
      }),
    );
  });

  it("rejects missing, extra, and absent environment resolution", async () => {
    const profile = stdioProfile({ environmentVariableNames: ["SAFE_TOKEN"] });
    await expect(
      createOfficialMCPTransport(profile, { runtimeProfile: "preview" }),
    ).rejects.toMatchObject({ code: "KAF_MCP_STDIO_ENVIRONMENT_INVALID" });
    await expect(
      createOfficialMCPTransport(profile, {
        runtimeProfile: "preview",
        stdioEnvironmentResolver: {
          resolve: () => Promise.resolve({ SAFE_TOKEN: "ok", AMBIENT_SECRET: "denied" }),
        },
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_STDIO_ENVIRONMENT_INVALID" });
    await expect(
      createOfficialMCPTransport(profile, {
        runtimeProfile: "preview",
        stdioEnvironmentResolver: { resolve: () => Promise.resolve({}) },
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_STDIO_ENVIRONMENT_INVALID" });
  }, 30_000);

  it("refuses production without an exact capable sandbox", async () => {
    const profile = stdioProfile();
    await expect(
      createOfficialMCPTransport(profile, { runtimeProfile: "production" }),
    ).rejects.toMatchObject({ code: "KAF_MCP_PRODUCTION_SANDBOX_REQUIRED" });
    await expect(
      createOfficialMCPTransport(profile, {
        runtimeProfile: "production",
        productionSandbox: {
          transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
          capabilities: {
            processIsolation: true,
            filesystemIsolation: true,
            networkIsolation: false,
            resourceLimits: true,
          },
          verifyExecutable: () => Promise.resolve(true),
          launch: () => Promise.resolve(new FakeMCPServerTransport()),
        },
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_PRODUCTION_SANDBOX_REQUIRED" });
  });

  it("launches production through the exact sandbox and constructs the default preview transport", async () => {
    const profile = stdioProfile();
    const fake = new FakeMCPServerTransport();
    const launch = vi.fn(() => Promise.resolve(fake));
    await expect(
      createOfficialMCPTransport(profile, {
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
          launch,
        },
      }),
    ).resolves.toBe(fake);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: profile.executablePath,
        environment: {},
        shell: false,
      }),
    );

    const executablePath = "/bin/echo";
    const executableArtifactDigest = `sha256:${createHash("sha256")
      .update(await readFile(executablePath))
      .digest("hex")}`;
    const verifiedProfile = stdioProfile({ executablePath, executableArtifactDigest });
    const transport = await createOfficialMCPTransport(verifiedProfile, {
      runtimeProfile: "preview",
    });
    expect(transport.constructor.name).toBe("ExactEnvironmentStdioTransport");
    await transport.close();

    await expect(
      createOfficialMCPTransport(
        stdioProfile({
          executablePath,
          executableArtifactDigest: profile.executableArtifactDigest,
        }),
        { runtimeProfile: "preview" },
      ),
    ).rejects.toMatchObject({ code: "KAF_MCP_IDENTITY_DRIFT" });
  });

  it("performs zero environment resolution and zero launch on static identity failures", async () => {
    const profile = stdioProfile({ environmentVariableNames: ["SAFE_TOKEN"] });
    const resolve = vi.fn(() => Promise.resolve({ SAFE_TOKEN: "sealed" }));
    const verifyExecutable = vi.fn(() => Promise.resolve(true));
    const launch = vi.fn(() => Promise.resolve(new FakeMCPServerTransport()));
    await expect(
      createOfficialMCPTransport(
        { ...profile, arguments: ["model-selected-argument"] },
        {
          runtimeProfile: "production",
          stdioEnvironmentResolver: { resolve },
          productionSandbox: {
            transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
            capabilities: {
              processIsolation: true,
              filesystemIsolation: true,
              networkIsolation: true,
              resourceLimits: true,
            },
            verifyExecutable,
            launch,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "KAF_MCP_IDENTITY_DRIFT" });
    expect(resolve).not.toHaveBeenCalled();
    expect(verifyExecutable).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("requires sandbox executable proof before resolving environment or launching", async () => {
    const profile = stdioProfile({ environmentVariableNames: ["SAFE_TOKEN"] });
    const resolve = vi.fn(() => Promise.resolve({ SAFE_TOKEN: "sealed" }));
    const launch = vi.fn(() => Promise.resolve(new FakeMCPServerTransport()));
    await expect(
      createOfficialMCPTransport(profile, {
        runtimeProfile: "production",
        stdioEnvironmentResolver: { resolve },
        productionSandbox: {
          transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
          capabilities: {
            processIsolation: true,
            filesystemIsolation: true,
            networkIsolation: true,
            resourceLimits: true,
          },
          verifyExecutable: () => Promise.resolve(false),
          launch,
        },
      }),
    ).rejects.toMatchObject({ code: "KAF_MCP_IDENTITY_DRIFT" });
    expect(resolve).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("verifies preview executable bytes before resolving environment or invoking the factory", async () => {
    const resolve = vi.fn(() => Promise.resolve({ SAFE_TOKEN: "sealed" }));
    const factory = vi.fn(() => new FakeMCPServerTransport());
    await expect(
      createOfficialMCPTransport(
        stdioProfile({
          executableArtifactDigest: `sha256:${"0".repeat(64)}`,
          environmentVariableNames: ["SAFE_TOKEN"],
        }),
        {
          runtimeProfile: "preview",
          stdioEnvironmentResolver: { resolve },
          previewStdioTransportFactory: factory,
        },
      ),
    ).rejects.toMatchObject({ code: "KAF_MCP_IDENTITY_DRIFT" });
    expect(resolve).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("spawns the direct preview transport with no ambient environment inheritance", async () => {
    const serverPath = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
    const profile = stdioProfile({
      id: "exact-environment",
      arguments: [serverPath],
      workingDirectory: tmpdir(),
    });
    const identity = defineMCPServerIdentity({
      serverName: "exact-env-server",
      serverVersion: "1.0.0",
      serverArtifactDigest: profile.executableArtifactDigest,
      negotiatedProtocolVersion: "2025-11-25",
      negotiatedCapabilities: { tools: {} },
      transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
    });
    const pin = defineMCPToolPin({
      registrationId: "fixture.exact_env@1",
      implementationVersion: "1",
      serverIdentityDigest: identity.mcpServerIdentityDigest,
      toolName: "exact_env",
      safeDescription: "Reports whether a test-only ambient canary was inherited",
      inputSchemaDigest: mcpToolSchemaDigest(inputSchema),
      outputSchemaDigest: mcpToolSchemaDigest(outputSchema),
      security: readSecurity,
      allowedPurposeCodes: ["fixture.read"],
      effectStrategyKind: "read",
      effectStrategyRegistrationDigest: digestC,
    });
    const previous = process.env["PACTMARK_MCP_AMBIENT_CANARY"];
    process.env["PACTMARK_MCP_AMBIENT_CANARY"] = "must-not-be-inherited";
    let connection: Awaited<ReturnType<typeof connectMCPServer>> | undefined;
    try {
      connection = await connectMCPServer(
        {
          transportProfile: profile,
          expectedServerIdentity: identity,
          toolPins: [pin],
          host: { runtimeProfile: "preview" },
        },
        exposure,
        { authorize: () => Promise.resolve({ allowed: true, grantId: "grant-exact-env" }) },
        new AbortController().signal,
      );
      await expect(
        connection.callTool(
          connection.listExposedTools()[0]!.registration.toolRegistrationDigest,
          { value: "check" },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ echo: "absent" });
    } finally {
      await connection?.close();
      if (previous === undefined) delete process.env["PACTMARK_MCP_AMBIENT_CANARY"];
      else process.env["PACTMARK_MCP_AMBIENT_CANARY"] = previous;
    }
  });

  it("bounds direct preview lifecycle, input, stdout, stderr, and cancellation", async () => {
    const probePath = fileURLToPath(new URL("./fixtures/stdio-probe.mjs", import.meta.url));
    const createProbe = (mode: "idle" | "stderr" | "malformed", maxRequestBytes = 128) =>
      createOfficialMCPTransport(
        stdioProfile({
          id: `probe-${mode}`,
          arguments: [probePath, mode],
          maxRequestBytes,
          maxResponseBytes: 128,
        }),
        { runtimeProfile: "preview" },
      );

    const idle = await createProbe("idle", 1);
    await idle.start();
    await expect(idle.start()).rejects.toMatchObject({ code: "KAF_MCP_CONNECTION_FAILED" });
    await expect(idle.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toMatchObject({
      code: "KAF_MCP_LIMIT_EXCEEDED",
    });
    await idle.close();
    await idle.close();

    for (const mode of ["stderr", "malformed"] as const) {
      const transport = await createProbe(mode);
      const observed = new Promise<Error>((resolve) => {
        transport.onerror = resolve;
      });
      await transport.start();
      await expect(observed).resolves.toBeInstanceOf(Error);
      await transport.close();
    }

    const controller = new AbortController();
    const cancelled = await createOfficialMCPTransport(
      stdioProfile({ id: "probe-cancelled", arguments: [probePath, "idle"] }),
      { runtimeProfile: "preview" },
      controller.signal,
    );
    controller.abort();
    await expect(cancelled.start()).rejects.toMatchObject({ code: "KAF_MCP_ABORTED" });
    await cancelled.close();

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      createOfficialMCPTransport(
        stdioProfile(),
        { runtimeProfile: "preview" },
        alreadyAborted.signal,
      ),
    ).rejects.toMatchObject({ code: "KAF_MCP_ABORTED" });
  });

  it("rechecks cancellation after production executable verification", async () => {
    const profile = stdioProfile();
    const controller = new AbortController();
    const launch = vi.fn(() => Promise.resolve(new FakeMCPServerTransport()));
    await expect(
      createOfficialMCPTransport(
        profile,
        {
          runtimeProfile: "production",
          productionSandbox: {
            transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
            capabilities: {
              processIsolation: true,
              filesystemIsolation: true,
              networkIsolation: true,
              resourceLimits: true,
            },
            verifyExecutable: () => {
              controller.abort();
              return Promise.resolve(true);
            },
            launch,
          },
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "KAF_MCP_ABORTED" });
    expect(launch).not.toHaveBeenCalled();
  });
});
