import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { repositoryRoot } from "../lib/repository.mjs";

export const CONTAINER_IMAGE_PREFIX = "pactmark-node-quickstart:conformance";
export const CONTAINER_PORT = 3000;
const pnpmCliPath = join(repositoryRoot, "node_modules", "pnpm", "bin", "pnpm.mjs");

const runtimeStage = `FROM node:24.18.1-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /product ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
`;

const runtimeOnlyDockerfile = runtimeStage
  .replace("FROM node:24.18.1-alpine AS runtime", "FROM node:24.18.1-alpine")
  .replace("COPY --from=build --chown=node:node /product ./", "COPY --chown=node:node product ./");

export interface CommandRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ContainerConformanceError extends Error {
  constructor(
    readonly code: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContainerConformanceError";
  }
}

class ContainerCommandError extends Error {
  constructor(
    readonly output: string,
    options: Readonly<{ cause: unknown }>,
  ) {
    super("KAF_CONTAINER_COMMAND_FAILED", { cause: options.cause });
    this.name = "ContainerCommandError";
  }
}

export interface ContainerConformanceResult {
  readonly schemaVersion: "1";
  readonly imageTag: string;
  readonly imageDigest: string;
  readonly dependencyMaterialization: "host_pnpm_deploy_offline";
  readonly imageBuildNetwork: "none";
  readonly containerName: string;
  readonly origin: string;
  readonly healthStatus: 200;
  readonly readinessStatus: 503;
  readonly readinessReady: false;
  readonly runId: string;
  readonly inspectedStatus: "completed";
  readonly cancellationStatus: 400;
  readonly cancellationCode: "KAF_SCHEMA_INVALID";
  readonly streamEvents: readonly ["RunAccepted", "ToolCallCompleted", "RunCompleted"];
  readonly containerSecurity: Readonly<{
    readOnlyRootFilesystem: true;
    tmpfs: "/tmp";
    secretEnvironmentVariables: readonly [];
  }>;
  readonly teardown: "container_removed";
}

export interface ContainerConformanceOptions {
  readonly commandRunner?: CommandRunner;
  readonly fetcher?: FetchLike;
  readonly id?: string;
  readonly healthAttempts?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

function runCommand(request: CommandRequest): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      request.file,
      [...request.args],
      { cwd: request.cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new ContainerCommandError([stdout, stderr].filter(Boolean).join("\n"), {
              cause: error,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export const systemCommandRunner: CommandRunner = Object.freeze({ run: runCommand });

interface OfflineBuildContext {
  readonly root: string;
  readonly dockerfile: string;
}

function hasCanonicalRuntimeStage(sourceDockerfile: string): boolean {
  return sourceDockerfile.replaceAll("\r\n", "\n").replaceAll("\r", "\n").includes(runtimeStage);
}

function redactCommandFailureDetail(output: string): string | undefined {
  const redacted = output
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gu, "$1[redacted]@")
    .replace(/(?:token|password|secret|credential)\s*[=:]\s*\S+/giu, "[redacted]")
    .trim();
  return redacted.length === 0 ? undefined : redacted.slice(0, 4_096);
}

export const containerConformanceInternals = Object.freeze({
  hasCanonicalRuntimeStage,
  redactCommandFailureDetail,
  runtimeStage,
  safeCommandFailureDetail(error: unknown): string | undefined {
    let current = error;
    while (current instanceof Error) {
      if (current instanceof ContainerCommandError) {
        return redactCommandFailureDetail(current.output);
      }
      current = current.cause;
    }
    return undefined;
  },
});

async function prepareOfflineBuildContext(runner: CommandRunner): Promise<OfflineBuildContext> {
  const sourceDockerfile = await readFile(
    join(repositoryRoot, "apps", "node-quickstart", "Dockerfile"),
    "utf8",
  );
  if (!hasCanonicalRuntimeStage(sourceDockerfile)) {
    throw new ContainerConformanceError("KAF_CONTAINER_DOCKERFILE_RUNTIME_DRIFT");
  }
  const root = await mkdtemp(join(tmpdir(), "pactmark-container-conformance-"));
  const product = join(root, "product");
  const dockerfile = join(root, "Dockerfile");
  const workspaceStatePath = join(repositoryRoot, "node_modules", ".pnpm-workspace-state-v1.json");
  const workspaceState = await readFile(workspaceStatePath, "utf8");
  try {
    await mkdir(product, { recursive: true });
    await writeFile(dockerfile, runtimeOnlyDockerfile, "utf8");
    try {
      await runner.run({
        file: process.execPath,
        args: [
          pnpmCliPath,
          "--filter",
          "pactmark-node-quickstart",
          "deploy",
          "--prod",
          "--offline",
          "--trust-lockfile",
          "--config.inject-workspace-packages=true",
          "--config.dedupe-injected-deps=false",
          product,
        ],
        cwd: repositoryRoot,
      });
    } finally {
      await writeFile(workspaceStatePath, workspaceState, "utf8");
    }
    return Object.freeze({ root, dockerfile });
  } catch (cause) {
    await rm(root, { recursive: true, force: true });
    throw new ContainerConformanceError("KAF_CONTAINER_OFFLINE_DEPLOY_FAILED", { cause });
  }
}

function boundedId(value: string | undefined): string {
  const id = value ?? randomBytes(8).toString("hex");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(id)) {
    throw new TypeError("KAF_CONTAINER_ID_INVALID");
  }
  return id;
}

function commandId(now: () => number): string {
  return `kafcmd_${String(now()).padStart(13, "0")}_${randomBytes(16).toString("hex")}`;
}

function workOrder(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "1",
    agent: { id: "node-quickstart", version: "0.1.0" },
    goal: "Read the bounded OCI conformance fixture.",
    input: { item: "notebook" },
    context: { roleFamily: "release", workflowId: "oci-conformance", riskClass: "low" },
    workMode: "assist",
    autonomyMode: "assist",
    decisionOwner: { mode: "requesting_principal" },
    purpose: { code: "service_delivery", registryVersion: "general@1" },
    dataClass: "public",
    retention: { mode: "session" },
    requestedCapabilities: ["fixture:read"],
    resourceScopeCeiling: [],
    budget: { maxTurns: 4, maxModelCalls: 4, maxToolCalls: 1, maxActiveExecutionMs: 10_000 },
  });
}

function parseJsonObject(value: string, code: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new ContainerConformanceError(code, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ContainerConformanceError(code);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function parsePublishedOrigin(output: string): string {
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(output.trim());
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ContainerConformanceError("KAF_CONTAINER_PORT_INVALID");
  }
  return `http://127.0.0.1:${String(port)}`;
}

async function waitForHealth(
  origin: string,
  fetcher: FetchLike,
  attempts: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<Response> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(`${origin}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) return response;
    } catch {
      // The bounded retry only covers container startup; contract requests do not retry.
    }
    if (attempt + 1 < attempts) await wait(250);
  }
  throw new ContainerConformanceError("KAF_CONTAINER_HEALTH_UNAVAILABLE");
}

function assertHostSecurity(hostConfig: Readonly<Record<string, unknown>>): void {
  if (hostConfig["ReadonlyRootfs"] !== true) {
    throw new ContainerConformanceError("KAF_CONTAINER_ROOTFS_NOT_READ_ONLY");
  }
  const tmpfs = hostConfig["Tmpfs"];
  if (typeof tmpfs !== "object" || tmpfs === null || Array.isArray(tmpfs)) {
    throw new ContainerConformanceError("KAF_CONTAINER_TMPFS_MISSING");
  }
  const options = (tmpfs as Readonly<Record<string, unknown>>)["/tmp"];
  if (
    typeof options !== "string" ||
    !options.includes("rw") ||
    !options.includes("noexec") ||
    !options.includes("nosuid")
  ) {
    throw new ContainerConformanceError("KAF_CONTAINER_TMPFS_INVALID");
  }
}

function assertNoSecretEnvironment(output: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    throw new ContainerConformanceError("KAF_CONTAINER_ENV_INVALID", { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new ContainerConformanceError("KAF_CONTAINER_ENV_INVALID");
  }
  const environment: string[] = [];
  for (const value of parsed as unknown[]) {
    if (typeof value !== "string") {
      throw new ContainerConformanceError("KAF_CONTAINER_ENV_INVALID");
    }
    environment.push(value);
  }
  const forbidden =
    /(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|DATABASE_URL|CREDENTIAL|PRIVATE_KEY)/iu;
  if (environment.some((entry) => forbidden.test(entry.split("=", 1)[0] ?? ""))) {
    throw new ContainerConformanceError("KAF_CONTAINER_SECRET_ENV_PRESENT");
  }
}

async function verifyHttpContract(
  origin: string,
  fetcher: FetchLike,
  healthAttempts: number,
  wait: (milliseconds: number) => Promise<void>,
  now: () => number,
): Promise<
  Pick<
    ContainerConformanceResult,
    | "healthStatus"
    | "readinessStatus"
    | "readinessReady"
    | "runId"
    | "inspectedStatus"
    | "cancellationStatus"
    | "cancellationCode"
    | "streamEvents"
  >
> {
  const health = await waitForHealth(origin, fetcher, healthAttempts, wait);
  const healthBody = parseJsonObject(await health.text(), "KAF_CONTAINER_HEALTH_INVALID");
  if (healthBody["status"] !== "ok") {
    throw new ContainerConformanceError("KAF_CONTAINER_HEALTH_INVALID");
  }

  const readiness = await fetcher(`${origin}/readyz`, { signal: AbortSignal.timeout(5_000) });
  const readinessBody = parseJsonObject(await readiness.text(), "KAF_CONTAINER_READINESS_INVALID");
  if (readiness.status !== 503 || readinessBody["ready"] !== false) {
    throw new ContainerConformanceError("KAF_CONTAINER_READINESS_INVALID");
  }

  const streamed = await fetcher(`${origin}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": commandId(now) },
    body: JSON.stringify(workOrder()),
    signal: AbortSignal.timeout(30_000),
  });
  const stream = await streamed.text();
  if (
    streamed.status !== 200 ||
    !streamed.headers.get("content-type")?.includes("text/event-stream")
  ) {
    throw new ContainerConformanceError("KAF_CONTAINER_STREAM_INVALID");
  }
  const expectedEvents = ["RunAccepted", "ToolCallCompleted", "RunCompleted"] as const;
  if (expectedEvents.some((event) => !stream.includes(`event: ${event}`))) {
    throw new ContainerConformanceError("KAF_CONTAINER_STREAM_INVALID");
  }
  const runId = /"runId":"([A-Za-z0-9._:-]+)"/u.exec(stream)?.[1];
  if (runId === undefined) throw new ContainerConformanceError("KAF_CONTAINER_RUN_ID_MISSING");

  const inspected = await fetcher(`${origin}/v1/runs/${encodeURIComponent(runId)}`, {
    signal: AbortSignal.timeout(5_000),
  });
  const inspectedBody = parseJsonObject(await inspected.text(), "KAF_CONTAINER_INSPECTION_INVALID");
  if (
    inspected.status !== 200 ||
    inspectedBody["runId"] !== runId ||
    inspectedBody["status"] !== "completed"
  ) {
    throw new ContainerConformanceError("KAF_CONTAINER_INSPECTION_INVALID");
  }

  const cancelled = await fetcher(`${origin}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": commandId(now) },
    body: JSON.stringify({ reason: "OCI conformance completed-run cancellation check" }),
    signal: AbortSignal.timeout(5_000),
  });
  const cancellationBody = parseJsonObject(
    await cancelled.text(),
    "KAF_CONTAINER_CANCELLATION_INVALID",
  );
  if (cancelled.status !== 400 || cancellationBody["code"] !== "KAF_SCHEMA_INVALID") {
    throw new ContainerConformanceError("KAF_CONTAINER_CANCELLATION_INVALID");
  }

  return Object.freeze({
    healthStatus: 200,
    readinessStatus: 503,
    readinessReady: false,
    runId,
    inspectedStatus: "completed",
    cancellationStatus: 400,
    cancellationCode: "KAF_SCHEMA_INVALID",
    streamEvents: expectedEvents,
  });
}

export async function runContainerConformance(
  options: ContainerConformanceOptions = {},
): Promise<ContainerConformanceResult> {
  const runner = options.commandRunner ?? systemCommandRunner;
  const fetcher = options.fetcher ?? fetch;
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const healthAttempts = options.healthAttempts ?? 80;
  if (!Number.isSafeInteger(healthAttempts) || healthAttempts < 1 || healthAttempts > 240) {
    throw new TypeError("KAF_CONTAINER_HEALTH_ATTEMPTS_INVALID");
  }
  const id = boundedId(options.id);
  const imageTag = `${CONTAINER_IMAGE_PREFIX}-${id}`;
  const containerName = `pactmark-node-conformance-${id}`;
  const command = (args: readonly string[]) =>
    runner.run({ file: "docker", args, cwd: repositoryRoot });

  try {
    await command(["version", "--format", "{{.Server.Version}}"]);
  } catch (cause) {
    throw new ContainerConformanceError("KAF_CONTAINER_RUNTIME_UNAVAILABLE", { cause });
  }

  const buildContext = await prepareOfflineBuildContext(runner);
  try {
    try {
      await command([
        "build",
        "--network=none",
        "--file",
        buildContext.dockerfile,
        "--tag",
        imageTag,
        buildContext.root,
      ]);
    } catch (cause) {
      throw new ContainerConformanceError("KAF_CONTAINER_BUILD_FAILED", { cause });
    }
    const imageDigest = (
      await command(["image", "inspect", "--format", "{{.Id}}", imageTag])
    ).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) {
      throw new ContainerConformanceError("KAF_CONTAINER_IMAGE_DIGEST_INVALID");
    }

    let runAttempted = false;
    let primaryError: unknown;
    let contract: Awaited<ReturnType<typeof verifyHttpContract>> | undefined;
    let origin: string | undefined;
    try {
      runAttempted = true;
      try {
        await command([
          "run",
          "--detach",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=16m",
          "--publish",
          `127.0.0.1::${String(CONTAINER_PORT)}`,
          "--name",
          containerName,
          "--security-opt",
          "no-new-privileges",
          "--cap-drop",
          "ALL",
          imageTag,
        ]);
      } catch (cause) {
        throw new ContainerConformanceError("KAF_CONTAINER_START_FAILED", { cause });
      }
      const hostConfig = parseJsonObject(
        (await command(["inspect", "--format", "{{json .HostConfig}}", containerName])).stdout,
        "KAF_CONTAINER_HOST_CONFIG_INVALID",
      );
      assertHostSecurity(hostConfig);
      assertNoSecretEnvironment(
        (await command(["inspect", "--format", "{{json .Config.Env}}", containerName])).stdout,
      );
      origin = parsePublishedOrigin(
        (await command(["port", containerName, `${String(CONTAINER_PORT)}/tcp`])).stdout,
      );
      contract = await verifyHttpContract(origin, fetcher, healthAttempts, wait, now);
    } catch (error) {
      primaryError = error;
    } finally {
      if (runAttempted) {
        try {
          await command(["rm", "--force", containerName]);
        } catch (cause) {
          if (primaryError === undefined) {
            primaryError = new ContainerConformanceError("KAF_CONTAINER_TEARDOWN_FAILED", {
              cause,
            });
          }
        }
      }
    }

    if (primaryError !== undefined) {
      if (primaryError instanceof Error) throw primaryError;
      throw new ContainerConformanceError("KAF_CONTAINER_CONFORMANCE_FAILED", {
        cause: primaryError,
      });
    }
    if (contract === undefined || origin === undefined) {
      throw new ContainerConformanceError("KAF_CONTAINER_CONFORMANCE_INCOMPLETE");
    }
    const secretEnvironmentVariables: readonly [] = Object.freeze([]);
    return Object.freeze({
      schemaVersion: "1",
      imageTag,
      imageDigest,
      dependencyMaterialization: "host_pnpm_deploy_offline",
      imageBuildNetwork: "none",
      containerName,
      origin,
      ...contract,
      containerSecurity: Object.freeze({
        readOnlyRootFilesystem: true,
        tmpfs: "/tmp",
        secretEnvironmentVariables,
      }),
      teardown: "container_removed",
    });
  } finally {
    await rm(buildContext.root, { recursive: true, force: true });
  }
}
