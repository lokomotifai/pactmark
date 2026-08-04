import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { repositoryRoot } from "../lib/repository.mjs";

export const sandboxBaseImageReference =
  "node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3";
export const sandboxBaseImageRepoDigest =
  "node@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3";
const memoryBytes = 128 * 1024 * 1024;
const nanoCpus = 500_000_000;
const pidsLimit = 32;
const workspaceTmpfs = "rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700";

export interface SandboxCommandRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface SandboxCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxCommandRunner {
  run(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
}

export type SandboxCommandFailureReason = "timeout" | "output_limit" | "failed";

export class SandboxCommandExecutionError extends Error {
  constructor(
    readonly reason: SandboxCommandFailureReason,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(
      `KAF_SANDBOX_COMMAND_${reason.toUpperCase()}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SandboxCommandExecutionError";
  }
}

export class SandboxContainerConformanceError extends Error {
  constructor(
    readonly code: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SandboxContainerConformanceError";
  }
}

export interface SandboxContainerConformanceResult {
  readonly schemaVersion: "1";
  readonly claim: "unsafe_reference_fixture_not_production_isolation";
  readonly imageTag: string;
  readonly imageDigest: string;
  readonly baseImage: Readonly<{
    reference: string;
    repoDigest: string;
  }>;
  readonly security: Readonly<{
    user: "65532:65532";
    network: "none";
    readOnlyRootFilesystem: true;
    workspace: "tmpfs";
    hostMounts: 0;
    dockerSocketMounted: false;
    capabilitiesDropped: "ALL";
    noNewPrivileges: true;
    pidsLimit: 32;
    memoryBytes: number;
    nanoCpus: number;
  }>;
  readonly probes: Readonly<{
    hostSecretDenied: true;
    parentTraversalDenied: true;
    symlinkEscapeDenied: true;
    dockerSocketDenied: true;
    loopbackDenied: true;
    metadataDenied: true;
    workspaceWrite: true;
    artifactExport: true;
  }>;
  readonly attacks: Readonly<{
    fork: Readonly<{ boundedBy: "pids_limit"; spawned: number; elapsedMilliseconds: number }>;
    loop: Readonly<{ boundedBy: "host_timeout"; elapsedMilliseconds: number }>;
    output: Readonly<{ boundedBy: "output_limit"; elapsedMilliseconds: number }>;
  }>;
  readonly cleanup: Readonly<{
    containersRemoved: 4;
    hostCanaryRemoved: true;
    imageRetained: true;
  }>;
}

export interface SandboxContainerConformanceOptions {
  readonly commandRunner?: SandboxCommandRunner;
  readonly id?: string;
}

function failureReason(error: unknown): SandboxCommandFailureReason {
  if (typeof error !== "object" || error === null) return "failed";
  const execution = error as Readonly<{
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  }>;
  if (execution.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_limit";
  if (execution.killed === true || execution.signal === "SIGKILL") return "timeout";
  return "failed";
}

function systemRun(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      request.file,
      [...request.args],
      {
        cwd: request.cwd,
        encoding: "utf8",
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new SandboxCommandExecutionError(failureReason(error), { cause: error }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export const systemSandboxCommandRunner: SandboxCommandRunner = Object.freeze({ run: systemRun });

function boundedId(value: string | undefined): string {
  const id = value ?? randomBytes(8).toString("hex");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(id)) {
    throw new TypeError("KAF_SANDBOX_CONTAINER_ID_INVALID");
  }
  return id;
}

function jsonObject(value: string, code: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new SandboxContainerConformanceError(code, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SandboxContainerConformanceError(code);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function containerArgs(
  name: string,
  imageTag: string,
  mode: "isolation" | "fork" | "loop" | "output",
  extra: readonly string[] = [],
): readonly string[] {
  return [
    "run",
    "--name",
    name,
    "--network",
    "none",
    "--user",
    "65532:65532",
    "--read-only",
    "--tmpfs",
    `/workspace:${workspaceTmpfs}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(pidsLimit),
    "--memory",
    "128m",
    "--memory-swap",
    "128m",
    "--cpus",
    "0.5",
    "--ulimit",
    "nofile=64:64",
    imageTag,
    mode,
    ...extra,
  ];
}

function assertArray(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new SandboxContainerConformanceError(code);
  return value as readonly unknown[];
}

function assertSecurity(
  host: Readonly<Record<string, unknown>>,
  config: Readonly<Record<string, unknown>>,
  mounts: readonly unknown[],
): void {
  const tmpfs = host["Tmpfs"];
  const tmpfsOptions =
    typeof tmpfs === "object" && tmpfs !== null && !Array.isArray(tmpfs)
      ? (tmpfs as Readonly<Record<string, unknown>>)["/workspace"]
      : undefined;
  const capDrop = assertArray(host["CapDrop"], "KAF_SANDBOX_CAP_DROP_INVALID");
  const securityOpt = assertArray(host["SecurityOpt"], "KAF_SANDBOX_SECURITY_OPT_INVALID");
  const binds = host["Binds"];
  const hasBinds = Array.isArray(binds) ? binds.length > 0 : binds !== null && binds !== undefined;
  const onlyWorkspaceTmpfs = mounts.every((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const mount = value as Readonly<Record<string, unknown>>;
    return mount["Type"] === "tmpfs" && mount["Destination"] === "/workspace";
  });
  if (
    config["User"] !== "65532:65532" ||
    host["NetworkMode"] !== "none" ||
    host["ReadonlyRootfs"] !== true ||
    typeof tmpfsOptions !== "string" ||
    !tmpfsOptions.includes("noexec") ||
    !tmpfsOptions.includes("nosuid") ||
    !tmpfsOptions.includes("nodev") ||
    hasBinds ||
    !onlyWorkspaceTmpfs ||
    capDrop.length !== 1 ||
    capDrop[0] !== "ALL" ||
    !securityOpt.some(
      (value) => typeof value === "string" && value.startsWith("no-new-privileges"),
    ) ||
    host["PidsLimit"] !== pidsLimit ||
    host["Memory"] !== memoryBytes ||
    host["MemorySwap"] !== memoryBytes ||
    host["NanoCpus"] !== nanoCpus
  ) {
    throw new SandboxContainerConformanceError("KAF_SANDBOX_CONTAINER_CONFIG_INVALID");
  }
}

function assertIsolationProbe(value: Readonly<Record<string, unknown>>): void {
  const checks = value["checks"];
  const artifact = value["artifact"];
  const artifactRecord =
    typeof artifact === "object" && artifact !== null && !Array.isArray(artifact)
      ? (artifact as Readonly<Record<string, unknown>>)
      : undefined;
  const artifactSha256 = artifactRecord?.["sha256"];
  if (
    value["uid"] !== 65_532 ||
    value["gid"] !== 65_532 ||
    typeof checks !== "object" ||
    checks === null ||
    Array.isArray(checks) ||
    ![
      "hostSecretDenied",
      "parentTraversalDenied",
      "symlinkEscapeDenied",
      "dockerSocketDenied",
      "loopbackDenied",
      "metadataDenied",
      "workspaceWrite",
    ].every((key) => (checks as Readonly<Record<string, unknown>>)[key] === true) ||
    artifactRecord === undefined ||
    artifactRecord["path"] !== "artifact.json" ||
    typeof artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifactSha256)
  ) {
    throw new SandboxContainerConformanceError("KAF_SANDBOX_ISOLATION_PROBE_FAILED");
  }
}

async function verifyRemoved(
  runner: SandboxCommandRunner,
  name: string,
  primaryError: unknown,
): Promise<void> {
  let cleanupError: unknown;
  try {
    await runner.run({
      file: "docker",
      args: ["rm", "--force", name],
      cwd: repositoryRoot,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
  } catch (error) {
    cleanupError = error;
  }
  try {
    await runner.run({
      file: "docker",
      args: ["inspect", name],
      cwd: repositoryRoot,
      timeoutMs: 5_000,
      maxOutputBytes: 1024 * 1024,
    });
    throw new SandboxContainerConformanceError("KAF_SANDBOX_CONTAINER_CLEANUP_FAILED");
  } catch (error) {
    if (error instanceof SandboxContainerConformanceError) throw error;
  }
  if (cleanupError !== undefined && primaryError === undefined) {
    if (cleanupError instanceof Error) throw cleanupError;
    throw new SandboxContainerConformanceError("KAF_SANDBOX_CONTAINER_CLEANUP_FAILED", {
      cause: cleanupError,
    });
  }
}

async function runNamedContainer(
  runner: SandboxCommandRunner,
  request: Readonly<{
    name: string;
    imageTag: string;
    mode: "isolation" | "fork" | "loop" | "output";
    extra?: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
    inspectSecurity?: boolean;
  }>,
): Promise<
  Readonly<{ result?: SandboxCommandResult; error?: unknown; elapsedMilliseconds: number }>
> {
  const started = performance.now();
  let result: SandboxCommandResult | undefined;
  let primaryError: unknown;
  try {
    result = await runner.run({
      file: "docker",
      args: containerArgs(request.name, request.imageTag, request.mode, request.extra),
      cwd: repositoryRoot,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    });
    if (request.inspectSecurity === true) {
      const host = jsonObject(
        (
          await runner.run({
            file: "docker",
            args: ["inspect", "--format", "{{json .HostConfig}}", request.name],
            cwd: repositoryRoot,
            timeoutMs: 5_000,
            maxOutputBytes: 1024 * 1024,
          })
        ).stdout,
        "KAF_SANDBOX_HOST_CONFIG_INVALID",
      );
      const config = jsonObject(
        (
          await runner.run({
            file: "docker",
            args: ["inspect", "--format", "{{json .Config}}", request.name],
            cwd: repositoryRoot,
            timeoutMs: 5_000,
            maxOutputBytes: 1024 * 1024,
          })
        ).stdout,
        "KAF_SANDBOX_IMAGE_CONFIG_INVALID",
      );
      const mountsResult = await runner.run({
        file: "docker",
        args: ["inspect", "--format", "{{json .Mounts}}", request.name],
        cwd: repositoryRoot,
        timeoutMs: 5_000,
        maxOutputBytes: 1024 * 1024,
      });
      let mounts: unknown;
      try {
        mounts = JSON.parse(mountsResult.stdout);
      } catch (cause) {
        throw new SandboxContainerConformanceError("KAF_SANDBOX_MOUNTS_INVALID", { cause });
      }
      assertSecurity(host, config, assertArray(mounts, "KAF_SANDBOX_MOUNTS_INVALID"));
    }
  } catch (error) {
    primaryError = error;
  } finally {
    await verifyRemoved(runner, request.name, primaryError);
  }
  return Object.freeze({
    ...(result === undefined ? {} : { result }),
    ...(primaryError === undefined ? {} : { error: primaryError }),
    elapsedMilliseconds: performance.now() - started,
  });
}

function expectSuccess(
  execution: Awaited<ReturnType<typeof runNamedContainer>>,
  code: string,
): SandboxCommandResult {
  if (execution.error !== undefined || execution.result === undefined) {
    throw new SandboxContainerConformanceError(code, { cause: execution.error });
  }
  return execution.result;
}

function expectBoundedFailure(
  execution: Awaited<ReturnType<typeof runNamedContainer>>,
  reason: SandboxCommandFailureReason,
  code: string,
): void {
  if (
    !(execution.error instanceof SandboxCommandExecutionError) ||
    execution.error.reason !== reason
  ) {
    throw new SandboxContainerConformanceError(code, { cause: execution.error });
  }
}

export async function runSandboxContainerConformance(
  options: SandboxContainerConformanceOptions = {},
): Promise<SandboxContainerConformanceResult> {
  const runner = options.commandRunner ?? systemSandboxCommandRunner;
  const id = boundedId(options.id);
  const imageTag = `pactmark-sandbox-reference:${id}`;
  try {
    await runner.run({
      file: "docker",
      args: ["version", "--format", "{{.Server.Version}}"],
      cwd: repositoryRoot,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
  } catch (cause) {
    throw new SandboxContainerConformanceError("KAF_SANDBOX_CONTAINER_RUNTIME_UNAVAILABLE", {
      cause,
    });
  }
  try {
    const inspected = await runner.run({
      file: "docker",
      args: ["image", "inspect", "--format", "{{json .RepoDigests}}", sandboxBaseImageReference],
      cwd: repositoryRoot,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    const repoDigests: unknown = JSON.parse(inspected.stdout);
    if (!Array.isArray(repoDigests) || !repoDigests.includes(sandboxBaseImageRepoDigest)) {
      throw new SandboxContainerConformanceError("KAF_SANDBOX_BASE_IMAGE_DIGEST_INVALID");
    }
  } catch (cause) {
    if (cause instanceof SandboxContainerConformanceError) throw cause;
    throw new SandboxContainerConformanceError("KAF_SANDBOX_BASE_IMAGE_UNAVAILABLE", { cause });
  }
  try {
    await runner.run({
      file: "docker",
      args: [
        "build",
        "--network=none",
        "--file",
        "tooling/sandbox-container/Dockerfile",
        "--tag",
        imageTag,
        "tooling/sandbox-container",
      ],
      cwd: repositoryRoot,
      timeoutMs: 120_000,
      maxOutputBytes: 10 * 1024 * 1024,
    });
  } catch (cause) {
    throw new SandboxContainerConformanceError("KAF_SANDBOX_IMAGE_BUILD_FAILED", { cause });
  }
  const imageDigest = (
    await runner.run({
      file: "docker",
      args: ["image", "inspect", "--format", "{{.Id}}", imageTag],
      cwd: repositoryRoot,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    })
  ).stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) {
    throw new SandboxContainerConformanceError("KAF_SANDBOX_IMAGE_DIGEST_INVALID");
  }

  const hostCanaryRoot = await mkdtemp(join(tmpdir(), "pactmark-host-secret-canary-"));
  const hostSecretPath = join(hostCanaryRoot, "secret.txt");
  await mkdir(hostCanaryRoot, { recursive: true });
  await writeFile(hostSecretPath, randomBytes(32), { mode: 0o600 });
  let finalResult: Omit<SandboxContainerConformanceResult, "cleanup"> | undefined;
  try {
    const isolation = await runNamedContainer(runner, {
      name: `pactmark-sandbox-isolation-${id}`,
      imageTag,
      mode: "isolation",
      extra: [hostSecretPath],
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      inspectSecurity: true,
    });
    const isolationValue = jsonObject(
      expectSuccess(isolation, "KAF_SANDBOX_ISOLATION_PROBE_FAILED").stdout,
      "KAF_SANDBOX_ISOLATION_PROBE_FAILED",
    );
    assertIsolationProbe(isolationValue);

    const fork = await runNamedContainer(runner, {
      name: `pactmark-sandbox-fork-${id}`,
      imageTag,
      mode: "fork",
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    const forkValue = jsonObject(
      expectSuccess(fork, "KAF_SANDBOX_FORK_LIMIT_FAILED").stdout,
      "KAF_SANDBOX_FORK_LIMIT_FAILED",
    );
    const spawned = forkValue["spawned"];
    if (forkValue["limited"] !== true || typeof spawned !== "number" || spawned >= pidsLimit) {
      throw new SandboxContainerConformanceError("KAF_SANDBOX_FORK_LIMIT_FAILED");
    }

    const loop = await runNamedContainer(runner, {
      name: `pactmark-sandbox-loop-${id}`,
      imageTag,
      mode: "loop",
      timeoutMs: 1_000,
      maxOutputBytes: 64 * 1024,
    });
    expectBoundedFailure(loop, "timeout", "KAF_SANDBOX_LOOP_LIMIT_FAILED");

    const output = await runNamedContainer(runner, {
      name: `pactmark-sandbox-output-${id}`,
      imageTag,
      mode: "output",
      timeoutMs: 3_000,
      maxOutputBytes: 64 * 1024,
    });
    expectBoundedFailure(output, "output_limit", "KAF_SANDBOX_OUTPUT_LIMIT_FAILED");

    finalResult = Object.freeze({
      schemaVersion: "1",
      claim: "unsafe_reference_fixture_not_production_isolation",
      imageTag,
      imageDigest,
      baseImage: Object.freeze({
        reference: sandboxBaseImageReference,
        repoDigest: sandboxBaseImageRepoDigest,
      }),
      security: Object.freeze({
        user: "65532:65532",
        network: "none",
        readOnlyRootFilesystem: true,
        workspace: "tmpfs",
        hostMounts: 0,
        dockerSocketMounted: false,
        capabilitiesDropped: "ALL",
        noNewPrivileges: true,
        pidsLimit,
        memoryBytes,
        nanoCpus,
      }),
      probes: Object.freeze({
        hostSecretDenied: true,
        parentTraversalDenied: true,
        symlinkEscapeDenied: true,
        dockerSocketDenied: true,
        loopbackDenied: true,
        metadataDenied: true,
        workspaceWrite: true,
        artifactExport: true,
      }),
      attacks: Object.freeze({
        fork: Object.freeze({
          boundedBy: "pids_limit",
          spawned,
          elapsedMilliseconds: fork.elapsedMilliseconds,
        }),
        loop: Object.freeze({
          boundedBy: "host_timeout",
          elapsedMilliseconds: loop.elapsedMilliseconds,
        }),
        output: Object.freeze({
          boundedBy: "output_limit",
          elapsedMilliseconds: output.elapsedMilliseconds,
        }),
      }),
    });
  } finally {
    await rm(hostCanaryRoot, { recursive: true, force: true });
  }
  return Object.freeze({
    ...finalResult,
    cleanup: Object.freeze({
      containersRemoved: 4,
      hostCanaryRemoved: true,
      imageRetained: true,
    }),
  });
}
