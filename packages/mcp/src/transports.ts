import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  MCPHttpCredentialBindingSchema,
  mcpOriginDigest,
  verifyMCPTransportSecurityProfile,
  type MCPHttpCredentialBinding,
  type MCPHttpTransportSecurityProfile,
  type MCPReadiness,
  type MCPStdioTransportSecurityProfile,
  type MCPTransportSecurityProfile,
} from "./contracts.js";
import { MCPReadinessSchema } from "./contracts.js";
import { MCPAdapterError } from "./errors.js";
import type {
  EgressHttpClient,
  Digest,
  JsonValue,
  ResolvedToolCredential,
  SecretResolver,
} from "@pactmark/core";
import { isPrivateOrReservedHostname } from "@pactmark/policy";

export interface MCPProtocolClient {
  connect(
    transport: MCPClientTransport,
    options: Readonly<{ signal: AbortSignal; timeout: number; maxTotalTimeout: number }>,
  ): Promise<void>;
  close(): Promise<void>;
  getServerCapabilities(): unknown;
  getServerVersion(): Readonly<{ name: string; version: string }> | undefined;
  listTools(
    params: Readonly<{ cursor?: string }>,
    options: Readonly<{ signal: AbortSignal; timeout: number; maxTotalTimeout: number }>,
  ): Promise<unknown>;
  callTool(
    params: Readonly<{ name: string; arguments: Readonly<Record<string, unknown>> }>,
    options: Readonly<{ signal: AbortSignal; timeout: number; maxTotalTimeout: number }>,
  ): Promise<unknown>;
}

export type MCPProtocolClientFactory = () => MCPProtocolClient;

/** Structural transport seam; official SDK types stay inside this adapter package. */
export interface MCPClientTransport {
  start(): Promise<void>;
  send(message: JsonValue): Promise<void>;
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JsonValue) => void) | undefined;
  setProtocolVersion?: ((version: string) => void) | undefined;
}

export function createOfficialMCPProtocolClient(): MCPProtocolClient {
  const client = new Client({ name: "pactmark-mcp", version: "0.1.0" }, { capabilities: {} });
  const protocolClient: MCPProtocolClient = {
    connect: (transport, options) => client.connect(transport as Transport, options),
    close: () => client.close(),
    getServerCapabilities: () => client.getServerCapabilities(),
    getServerVersion: () => client.getServerVersion(),
    listTools: (params, options) => client.listTools(params, options),
    callTool: (params, options) => client.callTool(params, undefined, options),
  };
  return Object.freeze(protocolClient);
}

export interface MCPProductionSandboxLauncher {
  readonly transportProfileDigest: string;
  readonly capabilities: Readonly<{
    processIsolation: boolean;
    filesystemIsolation: boolean;
    networkIsolation: boolean;
    resourceLimits: boolean;
  }>;
  verifyExecutable(
    request: Readonly<{
      transportProfileDigest: string;
      executablePath: string;
      executableArtifactDigest: string;
      arguments: readonly string[];
      workingDirectory: string;
      filesystemPolicyId: string;
      networkPolicyId: string;
    }>,
    signal: AbortSignal,
  ): Promise<boolean>;
  launch(
    request: Readonly<{
      transportProfileDigest: string;
      executablePath: string;
      executableArtifactDigest: string;
      arguments: readonly string[];
      workingDirectory: string;
      environment: Readonly<Record<string, string>>;
      shell: false;
      maxBufferSize: number;
      processLimit: number;
      filesystemPolicyId: string;
      networkPolicyId: string;
      connectionTimeoutMs: number;
      requestTimeoutMs: number;
      maxRequestBytes: number;
      maxResponseBytes: number;
      signal: AbortSignal;
    }>,
  ): Promise<MCPClientTransport>;
}

export interface MCPStdioEnvironmentResolver {
  resolve(names: readonly string[], signal: AbortSignal): Promise<Readonly<Record<string, string>>>;
}

export interface MCPTrustedHostCapability {
  readonly transportProfileDigest: string;
  readonly exactOrigin: string;
}

export interface MCPHttpEgressBoundary {
  readonly transportProfileDigest: string;
  readonly exactEndpoint: string;
  readonly capabilities: Readonly<{
    dnsRebindingProtection: true;
    redirectOriginEnforcement: true;
    credentialOriginEnforcement: true;
    requestResponseLimits: true;
  }>;
  /** Resolve immediately before connect and reject every private or reserved address. */
  validateResolvedEndpoint(endpoint: URL, signal: AbortSignal): Promise<void>;
  readonly client: EgressHttpClient;
}

export interface MCPTransportHostOptions {
  readonly runtimeProfile: "preview" | "production";
  readonly stdioEnvironmentResolver?: MCPStdioEnvironmentResolver;
  readonly productionSandbox?: MCPProductionSandboxLauncher;
  /** Preview-only unless `httpEgressBoundary` is supplied. */
  readonly egress?: EgressHttpClient;
  readonly httpEgressBoundary?: MCPHttpEgressBoundary;
  readonly secretResolver?: SecretResolver;
  readonly httpCredential?: MCPHttpCredentialBinding;
  readonly credentialToolRegistrationDigests?: readonly Digest[];
  readonly trustedHostCapability?: MCPTrustedHostCapability;
  /** Test seam for a fake stdio server; production still requires a sandbox launcher. */
  readonly previewStdioTransportFactory?: (
    request: Readonly<{
      command: string;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
      shell: false;
      maxBufferSize: number;
      signal: AbortSignal;
    }>,
  ) => MCPClientTransport;
}

function enforcedHttpEgress(
  profile: MCPHttpTransportSecurityProfile,
  host: MCPTransportHostOptions,
): EgressHttpClient | undefined {
  const boundary = host.httpEgressBoundary;
  if (boundary === undefined) return undefined;
  if (
    boundary.transportProfileDigest !== profile.mcpTransportSecurityProfileDigest ||
    boundary.exactEndpoint !== profile.endpoint ||
    !allCapabilitiesEnabled(boundary.capabilities)
  ) {
    throw new MCPAdapterError(
      "KAF_MCP_IDENTITY_DRIFT",
      "The enforced HTTP egress boundary does not match the pinned MCP profile",
    );
  }
  return Object.freeze({
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const endpoint = new URL(input instanceof Request ? input.url : input);
      const signal = init?.signal ?? new AbortController().signal;
      await boundary.validateResolvedEndpoint(endpoint, signal);
      return boundary.client.fetch(endpoint, init);
    },
  });
}

function allCapabilitiesEnabled(capabilities: Readonly<Record<string, boolean>>): boolean {
  return Object.values(capabilities).every((capability) => capability);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new MCPAdapterError("KAF_MCP_ABORTED", "MCP operation was cancelled");
  }
}

class ExactEnvironmentStdioTransport implements MCPClientTransport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JsonValue) => void) | undefined;
  readonly #readBuffer: ReadBuffer;
  #process: ChildProcessWithoutNullStreams | undefined;
  #closing: Promise<void> | undefined;
  #executableFile: FileHandle | undefined;

  constructor(
    private readonly request: Readonly<{
      command: string;
      executableFile: FileHandle;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
      maxRequestBytes: number;
      maxResponseBytes: number;
      signal: AbortSignal;
    }>,
  ) {
    this.#readBuffer = new ReadBuffer({ maxBufferSize: request.maxResponseBytes });
    this.#executableFile = request.executableFile;
  }

  async start(): Promise<void> {
    if (this.#process !== undefined) {
      throw new MCPAdapterError("KAF_MCP_CONNECTION_FAILED", "MCP stdio transport is started");
    }
    if (this.request.signal.aborted) {
      throw new MCPAdapterError("KAF_MCP_ABORTED", "MCP stdio launch was cancelled");
    }
    const executableFile = this.#executableFile;
    if (executableFile === undefined) {
      throw new MCPAdapterError(
        "KAF_MCP_IDENTITY_DRIFT",
        "The verified MCP executable handle is unavailable",
      );
    }
    if (process.platform !== "linux" && process.platform !== "darwin") {
      await executableFile.close();
      this.#executableFile = undefined;
      throw new MCPAdapterError(
        "KAF_MCP_PLATFORM_UNSUPPORTED",
        "Descriptor-pinned preview stdio launch is unsupported on this platform",
      );
    }
    const [verifiedFile, currentPath] = await Promise.all([
      executableFile.stat(),
      stat(this.request.command),
    ]);
    if (
      verifiedFile.dev !== currentPath.dev ||
      verifiedFile.ino !== currentPath.ino ||
      verifiedFile.size !== currentPath.size ||
      verifiedFile.mtimeMs !== currentPath.mtimeMs
    ) {
      await executableFile.close();
      this.#executableFile = undefined;
      throw new MCPAdapterError(
        "KAF_MCP_IDENTITY_DRIFT",
        "The pinned MCP executable changed before launch",
      );
    }
    // Linux can execute the already-verified descriptor. macOS posix_spawn rejects /dev/fd
    // executables, so preview mode performs an immediate inode identity check and retains the
    // verified descriptor through spawn. Production never uses this path; it requires a sandbox.
    const spawnCommand = process.platform === "linux" ? "/proc/self/fd/3" : this.request.command;
    const stdio: ("pipe" | number)[] =
      process.platform === "linux"
        ? ["pipe", "pipe", "pipe", executableFile.fd]
        : ["pipe", "pipe", "pipe"];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(spawnCommand, [...this.request.args], {
        cwd: this.request.cwd,
        env: { ...this.request.env },
        shell: false,
        windowsHide: true,
        detached: true,
        stdio,
      }) as ChildProcessWithoutNullStreams;
      this.#process = child;
      let stderrBytes = 0;
      child.once("spawn", () => {
        this.#executableFile = undefined;
        void executableFile.close();
        resolve();
      });
      child.once("error", (error: Error) => {
        this.#executableFile = undefined;
        void executableFile.close();
        this.onerror?.(error);
        reject(error);
      });
      child.once("close", () => {
        this.#process = undefined;
        this.onclose?.();
      });
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          this.#readBuffer.append(chunk);
          for (;;) {
            const message = this.#readBuffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message as JsonValue);
          }
        } catch (error) {
          const normalized =
            error instanceof Error
              ? error
              : new MCPAdapterError("KAF_MCP_MALFORMED_RESPONSE", "Invalid MCP stdio output");
          this.onerror?.(normalized);
          void this.close();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > this.request.maxResponseBytes) {
          const error = new MCPAdapterError(
            "KAF_MCP_LIMIT_EXCEEDED",
            "MCP stderr exceeded its byte limit",
          );
          this.onerror?.(error);
          void this.close();
        }
      });
      this.request.signal.addEventListener(
        "abort",
        () => {
          void this.close();
        },
        { once: true },
      );
    });
  }

  async send(message: JsonValue): Promise<void> {
    const child = this.#process;
    if (child?.stdin === undefined) {
      throw new MCPAdapterError("KAF_MCP_CONNECTION_FAILED", "MCP stdio is not connected");
    }
    const serialized = serializeMessage(message as never);
    if (new TextEncoder().encode(serialized).byteLength > this.request.maxRequestBytes) {
      throw new MCPAdapterError("KAF_MCP_LIMIT_EXCEEDED", "MCP stdio request is too large");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      child.stdin.once("error", onError);
      child.stdin.write(serialized, () => {
        child.stdin.off("error", onError);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const executableFile = this.#executableFile;
    this.#executableFile = undefined;
    await executableFile?.close();
    const child = this.#process;
    this.#process = undefined;
    this.#readBuffer.clear();
    if (child === undefined) return;
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
    child.stdin.end();
    terminateProcessTree(child, "SIGTERM");
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    if (child.exitCode === null && child.signalCode === null) {
      terminateProcessTree(child, "SIGKILL");
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    }
  }
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may have exited between the liveness check and group signal.
    }
  }
  child.kill(signal);
}

function validateHttpEndpoint(
  profile: MCPHttpTransportSecurityProfile,
  trustedHostCapability: MCPTrustedHostCapability | undefined,
): URL {
  const endpoint = new URL(profile.endpoint);
  const privateEndpoint = isPrivateOrReservedHostname(endpoint.hostname);
  const privateCapabilityValid =
    profile.trustedPrivateEndpoint &&
    trustedHostCapability?.transportProfileDigest === profile.mcpTransportSecurityProfileDigest &&
    trustedHostCapability.exactOrigin === profile.exactOrigin;
  const denied = [
    endpoint.username.length > 0,
    endpoint.password.length > 0,
    endpoint.hash.length > 0,
    endpoint.origin !== profile.exactOrigin,
    endpoint.protocol !== "https:",
    privateEndpoint && !privateCapabilityValid,
  ].some(Boolean);
  if (denied) {
    throw new MCPAdapterError(
      "KAF_MCP_HTTP_ENDPOINT_DENIED",
      "The pinned MCP endpoint is not allowed by its transport profile",
    );
  }
  return endpoint;
}

async function openVerifiedExecutableArtifact(
  profile: MCPStdioTransportSecurityProfile,
  signal: AbortSignal,
): Promise<FileHandle> {
  const hash = createHash("sha256");
  let executableFile: FileHandle | undefined;
  try {
    const opened = await Promise.all([
      open(profile.executablePath, constants.O_RDONLY | constants.O_NOFOLLOW),
      stat(profile.workingDirectory),
    ]);
    executableFile = opened[0];
    const [executable, workingDirectory] = await Promise.all([
      executableFile.stat(),
      Promise.resolve(opened[1]),
    ]);
    if (!executable.isFile() || !workingDirectory.isDirectory()) {
      throw new TypeError("Pinned stdio paths have the wrong type");
    }
    for await (const chunk of executableFile.createReadStream({ autoClose: false })) {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      if (!Buffer.isBuffer(chunk)) throw new TypeError("Unexpected executable byte stream");
      hash.update(chunk);
    }
  } catch (error) {
    await executableFile?.close();
    throw new MCPAdapterError(
      "KAF_MCP_IDENTITY_DRIFT",
      "The pinned MCP executable could not be verified",
      { cause: error },
    );
  }
  if (`sha256:${hash.digest("hex")}` !== profile.executableArtifactDigest) {
    await executableFile.close();
    throw new MCPAdapterError(
      "KAF_MCP_IDENTITY_DRIFT",
      "The MCP executable bytes differ from the pinned artifact digest",
    );
  }
  return executableFile;
}

function bodySize(body: BodyInit | null | undefined): number {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  // SDK 1.30.0 serializes JSON-RPC bodies to strings. Unknown body kinds fail closed.
  return Number.POSITIVE_INFINITY;
}

function boundedResponse(response: Response, maximumBytes: number): Response {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new MCPAdapterError(
        "KAF_MCP_MALFORMED_RESPONSE",
        "MCP response declared an invalid byte length",
      );
    }
    if (declaredBytes > maximumBytes) {
      throw new MCPAdapterError("KAF_MCP_LIMIT_EXCEEDED", "MCP response exceeds its byte limit");
    }
  }
  if (response.body === null) return response;
  let observed = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observed += chunk.byteLength;
        if (observed > maximumBytes) {
          controller.error(
            new MCPAdapterError("KAF_MCP_LIMIT_EXCEEDED", "MCP response exceeds its byte limit"),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(bounded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function exactEnvironment(
  profile: MCPStdioTransportSecurityProfile,
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const expected = [...profile.environmentVariableNames].sort();
  const actual = Object.keys(values).sort();
  const invalid = [
    expected.length !== actual.length,
    expected.some((name, index) => name !== actual[index]),
    Object.values(values).some((value) => typeof value !== "string" || value.includes("\u0000")),
  ].some(Boolean);
  if (invalid) {
    throw new MCPAdapterError(
      "KAF_MCP_STDIO_ENVIRONMENT_INVALID",
      "The resolved stdio environment does not exactly match the host allowlist",
    );
  }
  return Object.freeze(Object.fromEntries(expected.map((name) => [name, values[name] ?? ""])));
}

async function resolveEnvironment(
  profile: MCPStdioTransportSecurityProfile,
  resolver: MCPStdioEnvironmentResolver | undefined,
  signal: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
  if (profile.environmentVariableNames.length === 0) return Object.freeze({});
  if (resolver === undefined) {
    throw new MCPAdapterError(
      "KAF_MCP_STDIO_ENVIRONMENT_INVALID",
      "A resolver is required for the pinned stdio environment names",
    );
  }
  return exactEnvironment(
    profile,
    await resolver.resolve(profile.environmentVariableNames, signal),
  );
}

function validateCredentialBinding(
  profile: MCPHttpTransportSecurityProfile,
  binding: MCPHttpCredentialBinding,
  allowedToolRegistrationDigests: readonly Digest[] | undefined,
): void {
  const parsed = MCPHttpCredentialBindingSchema.parse(binding);
  const originDigest = mcpOriginDigest(profile.exactOrigin);
  const invalid = [
    profile.credentialSlot === undefined,
    parsed.expectedOriginDigest !== originDigest,
    parsed.secretRef.normalizedDestinationDigest !== originDigest,
    parsed.resolutionBinding.normalizedDestinationDigest !== originDigest,
    parsed.secretRef.credentialSlot !== profile.credentialSlot,
    parsed.resolutionBinding.credentialSlot !== profile.credentialSlot,
    parsed.secretRef.toolRegistrationDigest !== parsed.resolutionBinding.toolRegistrationDigest,
    parsed.secretRef.tenantId !== parsed.resolutionBinding.tenantId,
    parsed.secretRef.workOrderBindingDigest !== parsed.resolutionBinding.workOrderBindingDigest,
    parsed.secretRef.executionDefinitionDigest !==
      parsed.resolutionBinding.executionDefinitionDigest,
    parsed.secretRef.grantId !== parsed.resolutionBinding.grantId,
    allowedToolRegistrationDigests === undefined,
    !allowedToolRegistrationDigests?.includes(parsed.secretRef.toolRegistrationDigest),
  ].some(Boolean);
  if (invalid) {
    throw new MCPAdapterError(
      "KAF_MCP_CREDENTIAL_BINDING_INVALID",
      "The MCP credential is not bound to the pinned origin and slot",
    );
  }
}

async function resolveHttpCredential(
  profile: MCPHttpTransportSecurityProfile,
  host: MCPTransportHostOptions,
): Promise<ResolvedToolCredential | undefined> {
  if (profile.credentialSlot === undefined) {
    if (host.httpCredential !== undefined) {
      throw new MCPAdapterError(
        "KAF_MCP_CREDENTIAL_BINDING_INVALID",
        "A credential was supplied for a profile without a credential slot",
      );
    }
    return undefined;
  }
  if (host.httpCredential === undefined || host.secretResolver === undefined) {
    throw new MCPAdapterError(
      "KAF_MCP_CREDENTIAL_BINDING_INVALID",
      "The pinned MCP credential slot requires a SecretRef and resolver",
    );
  }
  validateCredentialBinding(profile, host.httpCredential, host.credentialToolRegistrationDigests);
  return host.secretResolver.resolve(
    host.httpCredential.secretRef,
    host.httpCredential.resolutionBinding,
  );
}

function guardedFetch(
  profile: MCPHttpTransportSecurityProfile,
  egress: EgressHttpClient,
  credential: ResolvedToolCredential | undefined,
  trustedHostCapability: MCPTrustedHostCapability | undefined,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const endpoint = validateHttpEndpoint(profile, trustedHostCapability);
  return async (input, init) => {
    const target = new URL(input);
    const endpointMismatch = [
      target.origin !== endpoint.origin,
      target.pathname !== endpoint.pathname,
      target.search !== endpoint.search,
      target.username.length > 0,
      target.password.length > 0,
    ].some(Boolean);
    if (endpointMismatch) {
      throw new MCPAdapterError(
        "KAF_MCP_HTTP_ENDPOINT_DENIED",
        "MCP transport attempted a request outside its exact endpoint",
      );
    }
    if (bodySize(init?.body) > profile.maxRequestBytes) {
      throw new MCPAdapterError("KAF_MCP_LIMIT_EXCEEDED", "MCP request exceeds its byte limit");
    }
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
    headers.delete("x-api-key");
    credential?.use((value) => {
      headers.set("authorization", `Bearer ${value}`);
    });
    const timeout = AbortSignal.timeout(profile.requestTimeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await egress.fetch(target, {
      ...init,
      headers,
      redirect: "manual",
      credentials: "omit",
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new MCPAdapterError(
        "KAF_MCP_HTTP_REDIRECT_DENIED",
        "MCP transport redirects are disabled",
      );
    }
    return boundedResponse(response, profile.maxResponseBytes);
  };
}

export async function createOfficialMCPTransport(
  untrustedProfile: MCPTransportSecurityProfile,
  host: MCPTransportHostOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<MCPClientTransport> {
  if (signal.aborted) throw new MCPAdapterError("KAF_MCP_ABORTED", "MCP operation was cancelled");
  const profile = verifyMCPTransportSecurityProfile(untrustedProfile);
  if (profile.transport === "stdio") {
    const executableRequest = Object.freeze({
      transportProfileDigest: profile.mcpTransportSecurityProfileDigest,
      executablePath: profile.executablePath,
      executableArtifactDigest: profile.executableArtifactDigest,
      arguments: profile.arguments,
      workingDirectory: profile.workingDirectory,
      filesystemPolicyId: profile.filesystemPolicyId,
      networkPolicyId: profile.networkPolicyId,
    });
    if (host.runtimeProfile === "production") {
      const sandboxInvalid =
        host.productionSandbox === undefined ||
        [
          host.productionSandbox.transportProfileDigest !==
            profile.mcpTransportSecurityProfileDigest,
          Object.values(host.productionSandbox.capabilities).some((enabled) => !enabled),
        ].some(Boolean);
      if (sandboxInvalid) {
        throw new MCPAdapterError(
          "KAF_MCP_PRODUCTION_SANDBOX_REQUIRED",
          "Production stdio requires an exact-profile sandbox with all isolation capabilities",
        );
      }
      const executableVerified = await host.productionSandbox.verifyExecutable(
        executableRequest,
        signal,
      );
      if (!executableVerified) {
        throw new MCPAdapterError(
          "KAF_MCP_IDENTITY_DRIFT",
          "The production sandbox could not verify the pinned MCP executable",
        );
      }
      assertNotAborted(signal);
      const environment = await resolveEnvironment(profile, host.stdioEnvironmentResolver, signal);
      return host.productionSandbox.launch(
        Object.freeze({
          ...executableRequest,
          environment,
          shell: false,
          maxBufferSize: profile.maxResponseBytes,
          processLimit: profile.processLimit,
          connectionTimeoutMs: profile.connectionTimeoutMs,
          requestTimeoutMs: profile.requestTimeoutMs,
          maxRequestBytes: profile.maxRequestBytes,
          maxResponseBytes: profile.maxResponseBytes,
          signal,
        }),
      );
    }
    const executableFile = await openVerifiedExecutableArtifact(profile, signal);
    let environment: Readonly<Record<string, string>>;
    try {
      environment = await resolveEnvironment(profile, host.stdioEnvironmentResolver, signal);
    } catch (error) {
      await executableFile.close();
      throw error;
    }
    const request = Object.freeze({
      ...executableRequest,
      environment,
      shell: false as const,
      maxBufferSize: profile.maxResponseBytes,
    });
    if (host.previewStdioTransportFactory !== undefined) {
      await executableFile.close();
      return host.previewStdioTransportFactory({
        command: request.executablePath,
        args: request.arguments,
        cwd: request.workingDirectory,
        env: request.environment,
        shell: false,
        maxBufferSize: request.maxBufferSize,
        signal,
      });
    }
    return new ExactEnvironmentStdioTransport({
      command: request.executablePath,
      executableFile,
      args: request.arguments,
      cwd: request.workingDirectory,
      env: request.environment,
      maxRequestBytes: profile.maxRequestBytes,
      maxResponseBytes: profile.maxResponseBytes,
      signal,
    });
  }
  const enforcedEgress = enforcedHttpEgress(profile, host);
  if (host.egress !== undefined && enforcedEgress !== undefined) {
    throw new MCPAdapterError(
      "KAF_MCP_EGRESS_REQUIRED",
      "Configure one MCP HTTP egress boundary, not ambiguous clients",
    );
  }
  const egress = enforcedEgress ?? (host.runtimeProfile === "preview" ? host.egress : undefined);
  if (egress === undefined) {
    throw new MCPAdapterError(
      "KAF_MCP_EGRESS_REQUIRED",
      "Streamable HTTP requires an enforced boundary in production or injected preview egress",
    );
  }
  validateHttpEndpoint(profile, host.trustedHostCapability);
  const credential = await resolveHttpCredential(profile, host);
  const fetch = guardedFetch(profile, egress, credential, host.trustedHostCapability);
  return new StreamableHTTPClientTransport(
    validateHttpEndpoint(profile, host.trustedHostCapability),
    {
      fetch,
      requestInit: { redirect: "manual", credentials: "omit" },
      reconnectionOptions: {
        initialReconnectionDelay: 100,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 0,
      },
    },
  ) as unknown as MCPClientTransport;
}

export function evaluateMCPReadiness(
  profile: MCPTransportSecurityProfile,
  host: Pick<
    MCPTransportHostOptions,
    | "runtimeProfile"
    | "productionSandbox"
    | "egress"
    | "httpEgressBoundary"
    | "trustedHostCapability"
  >,
): MCPReadiness {
  const parsed = verifyMCPTransportSecurityProfile(profile);
  const checks =
    parsed.transport === "stdio"
      ? [
          {
            code: "KAF_MCP_STDIO_PROFILE_PINNED",
            passed: isAbsolute(parsed.executablePath),
            remediation: "pin-stdio-executable-args-cwd-env-and-limits",
          },
          {
            code: "KAF_MCP_STDIO_SANDBOX_READY",
            passed:
              host.runtimeProfile === "preview" ||
              (host.productionSandbox !== undefined &&
                host.productionSandbox.transportProfileDigest ===
                  parsed.mcpTransportSecurityProfileDigest &&
                Object.values(host.productionSandbox.capabilities).every(Boolean) &&
                typeof host.productionSandbox.verifyExecutable === "function"),
            remediation: "configure-exact-profile-production-sandbox",
          },
        ]
      : [
          {
            code: "KAF_MCP_HTTP_EGRESS_READY",
            passed:
              host.runtimeProfile === "preview"
                ? host.egress !== undefined || host.httpEgressBoundary !== undefined
                : host.httpEgressBoundary?.transportProfileDigest ===
                    parsed.mcpTransportSecurityProfileDigest &&
                  host.httpEgressBoundary.exactEndpoint === parsed.endpoint &&
                  Object.values(host.httpEgressBoundary.capabilities).every(Boolean),
            remediation: "configure-exact-profile-dns-enforcing-http-egress-boundary",
          },
          {
            code: "KAF_MCP_HTTP_TLS_READY",
            passed: new URL(parsed.endpoint).protocol === "https:",
            remediation: "use-https-for-production-mcp",
          },
          {
            code: "KAF_MCP_HTTP_PRIVATE_ENDPOINT_READY",
            passed:
              !isPrivateOrReservedHostname(new URL(parsed.endpoint).hostname) ||
              (parsed.trustedPrivateEndpoint &&
                host.trustedHostCapability?.transportProfileDigest ===
                  parsed.mcpTransportSecurityProfileDigest &&
                host.trustedHostCapability.exactOrigin === parsed.exactOrigin),
            remediation: "configure-exact-profile-trusted-host-capability",
          },
        ];
  return MCPReadinessSchema.parse({
    schemaVersion: "1",
    profile: host.runtimeProfile,
    ready: checks.every((check) => check.passed),
    checks,
  });
}

export function mcpCallArguments(value: JsonValue): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new MCPAdapterError(
      "KAF_MCP_MALFORMED_RESPONSE",
      "MCP tool arguments must be a JSON object",
    );
  }
  return value as Readonly<Record<string, unknown>>;
}
