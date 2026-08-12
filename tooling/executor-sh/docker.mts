import { execFile } from "node:child_process";

import {
  EXECUTOR_SELF_HOST_IMAGE_REPOSITORY,
  executorSelfHostManifestDigest,
  type ExecutorSelfHostPlatform,
} from "../../packages/executor-sh/src/self-host-image.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export class ExecutorConformanceError extends Error {
  constructor(
    readonly code: string,
    options: Readonly<{ cause?: unknown; safeDetail?: string }> = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExecutorConformanceError";
    this.safeDetail = options.safeDetail;
  }

  readonly safeDetail: string | undefined;
}

export function runDocker(
  args: readonly string[],
  options: Readonly<{ timeoutMs?: number; maxOutputBytes?: number }> = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxOutputBytes ?? 4 * 1024 * 1024,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const safeDetail = stderr.trim().slice(0, 2_000);
          reject(
            new ExecutorConformanceError("KAF_EXECUTOR_DOCKER_COMMAND_FAILED", {
              cause: error,
              ...(safeDetail.length === 0 ? {} : { safeDetail }),
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function normalizeArchitecture(value: string): ExecutorSelfHostPlatform {
  const architecture = value.trim().toLowerCase();
  if (architecture === "amd64" || architecture === "x86_64") return "linux/amd64";
  if (architecture === "arm64" || architecture === "aarch64") return "linux/arm64";
  throw new ExecutorConformanceError("KAF_EXECUTOR_PLATFORM_UNSUPPORTED");
}

export async function executorDockerPlatform(): Promise<ExecutorSelfHostPlatform> {
  const result = await runDocker(["info", "--format", "{{.OSType}} {{.Architecture}}"]);
  const [operatingSystem, architecture] = result.stdout.trim().split(/\s+/u);
  if (operatingSystem !== "linux" || architecture === undefined) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_PLATFORM_UNSUPPORTED");
  }
  return normalizeArchitecture(architecture);
}

export function executorPlatformImage(platform: ExecutorSelfHostPlatform): string {
  return `${EXECUTOR_SELF_HOST_IMAGE_REPOSITORY}@${executorSelfHostManifestDigest(platform)}`;
}

export async function assertPinnedImage(platform: ExecutorSelfHostPlatform): Promise<void> {
  const expected = executorSelfHostManifestDigest(platform);
  const image = executorPlatformImage(platform);
  let parsed: unknown;
  try {
    parsed = JSON.parse((await runDocker(["image", "inspect", image])).stdout);
  } catch (cause) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_IMAGE_UNAVAILABLE", { cause });
  }
  const record: unknown = Array.isArray(parsed) ? (parsed as readonly unknown[]).at(0) : undefined;
  const repoDigests =
    typeof record === "object" && record !== null && "RepoDigests" in record
      ? (record as { readonly RepoDigests?: unknown }).RepoDigests
      : undefined;
  const labels =
    typeof record === "object" && record !== null && "Config" in record
      ? (record as { readonly Config?: { readonly Labels?: Readonly<Record<string, string>> } })
          .Config?.Labels
      : undefined;
  if (
    !Array.isArray(repoDigests) ||
    !repoDigests.includes(`${EXECUTOR_SELF_HOST_IMAGE_REPOSITORY}@${expected}`) ||
    labels?.["org.opencontainers.image.version"] !== "1.5.40" ||
    labels["org.opencontainers.image.revision"] !== "b029643641832ef5f9b0d4ff263d96e1a5b2739c"
  ) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_IMAGE_IDENTITY_DRIFT");
  }
}
