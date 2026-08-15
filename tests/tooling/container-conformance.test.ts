import { describe, expect, it, vi } from "vitest";
import process from "node:process";

import {
  containerConformanceInternals,
  runContainerConformance,
  type CommandRequest,
  type CommandRunner,
  type FetchLike,
} from "../../tooling/container/conformance.mjs";

const imageDigest = `sha256:${"a".repeat(64)}`;

class DockerDouble implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  failVersion = false;

  run(request: CommandRequest): Promise<{ stdout: string; stderr: string }> {
    this.requests.push(request);
    if (
      request.file === process.execPath &&
      request.args[0]?.replaceAll("\\", "/").endsWith("/node_modules/pnpm/bin/pnpm.mjs") === true
    ) {
      return Promise.resolve({ stdout: "offline deploy complete\n", stderr: "" });
    }
    const [operation, second, third] = request.args;
    if (operation === "version") {
      if (this.failVersion) return Promise.reject(new Error("daemon unavailable"));
      return Promise.resolve({ stdout: "27.1.1\n", stderr: "" });
    }
    if (operation === "build" || operation === "run" || operation === "rm") {
      return Promise.resolve({ stdout: operation === "run" ? "container-id\n" : "", stderr: "" });
    }
    if (operation === "image" && second === "inspect") {
      return Promise.resolve({ stdout: `${imageDigest}\n`, stderr: "" });
    }
    if (operation === "inspect" && third === "{{json .HostConfig}}") {
      return Promise.resolve({
        stdout: JSON.stringify({
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m" },
        }),
        stderr: "",
      });
    }
    if (operation === "inspect" && third === "{{json .Config.Env}}") {
      return Promise.resolve({
        stdout: JSON.stringify([
          "NODE_ENV=production",
          "PORT=3000",
          "PACTMARK_BIND_HOST=0.0.0.0",
          "PATH=/usr/local/bin",
        ]),
        stderr: "",
      });
    }
    if (operation === "port") {
      return Promise.resolve({ stdout: "127.0.0.1:49153\n", stderr: "" });
    }
    return Promise.reject(new Error(`unexpected command: ${request.args.join(" ")}`));
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulFetch(urls: string[]): FetchLike {
  return vi.fn((input: string, init?: RequestInit) => {
    urls.push(input);
    if (input.endsWith("/healthz")) return Promise.resolve(json({ status: "ok" }));
    if (input.endsWith("/readyz")) return Promise.resolve(json({ ready: false }, 503));
    if (input.endsWith("/v1/runs")) {
      if (typeof init?.body !== "string") {
        return Promise.reject(new Error("missing JSON work order"));
      }
      const body = JSON.parse(init.body) as Readonly<{
        agent?: Readonly<{ id?: unknown }>;
      }>;
      if (body.agent?.id !== "node-quickstart") {
        return Promise.reject(new Error("wrong quickstart agent identity"));
      }
      return Promise.resolve(
        new Response(
          [
            'id: 1\nevent: RunAccepted\ndata: {"runId":"run-oci-1"}\n',
            "id: 2\nevent: ToolCallCompleted\ndata: {}\n",
            "id: 3\nevent: RunCompleted\ndata: {}\n",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    }
    if (input.endsWith("/v1/runs/run-oci-1/cancel")) {
      return Promise.resolve(json({ code: "KAF_SCHEMA_INVALID" }, 400));
    }
    if (input.endsWith("/v1/runs/run-oci-1")) {
      return Promise.resolve(json({ runId: "run-oci-1", status: "completed" }));
    }
    return Promise.reject(new Error(`unexpected URL: ${input}`));
  });
}

describe("OCI conformance runner", () => {
  it("accepts the canonical runtime stage across Git line-ending policies", () => {
    const dockerfile = containerConformanceInternals.runtimeStage;

    expect(containerConformanceInternals.hasCanonicalRuntimeStage(dockerfile)).toBe(true);
    expect(
      containerConformanceInternals.hasCanonicalRuntimeStage(dockerfile.replaceAll("\n", "\r\n")),
    ).toBe(true);
    expect(
      containerConformanceInternals.hasCanonicalRuntimeStage(
        dockerfile.replace("USER node", "USER root"),
      ),
    ).toBe(false);
    expect(
      containerConformanceInternals.hasCanonicalRuntimeStage(
        dockerfile.replace("PACTMARK_BIND_HOST=0.0.0.0", "PACTMARK_BIND_HOST=127.0.0.1"),
      ),
    ).toBe(false);
    expect(
      containerConformanceInternals.hasCanonicalRuntimeStage(
        dockerfile.replace(
          "node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3",
          "node:24.18.1-alpine",
        ),
      ),
    ).toBe(false);
  });

  it("redacts bounded command diagnostics without changing stable failure codes", () => {
    expect(
      containerConformanceInternals.redactCommandFailureDetail(
        "ERR https://user:password@example.test token=top-secret\n",
      ),
    ).toBe("ERR https://[redacted]@example.test [redacted]");
    expect(containerConformanceInternals.redactCommandFailureDetail(" ")).toBeUndefined();
    expect(
      containerConformanceInternals.redactCommandFailureDetail("x".repeat(5_000)),
    ).toHaveLength(4_096);
  });

  it("builds the exact Dockerfile and verifies the localhost HTTP contract", async () => {
    const docker = new DockerDouble();
    const urls: string[] = [];
    const result = await runContainerConformance({
      commandRunner: docker,
      fetcher: successfulFetch(urls),
      id: "unit",
      wait: () => Promise.resolve(),
      now: () => 1_800_000_000_000,
    });

    expect(result).toMatchObject({
      imageTag: "pactmark-node-quickstart:conformance-unit",
      imageDigest,
      origin: "http://127.0.0.1:49153",
      healthStatus: 200,
      readinessStatus: 503,
      runId: "run-oci-1",
      inspectedStatus: "completed",
      cancellationCode: "KAF_SCHEMA_INVALID",
      teardown: "container_removed",
    });
    const deploy = docker.requests[1];
    expect(deploy?.file).toBe(process.execPath);
    expect(deploy?.args[0]).toMatch(/[\\/]node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.mjs$/u);
    expect(deploy?.args).toContain("deploy");
    expect(deploy?.args).toContain("--offline");
    expect(deploy?.args).toContain("--config.inject-workspace-packages=true");
    expect(deploy?.args).not.toContain("--legacy");
    expect(deploy?.args).not.toContain("install");
    const build = docker.requests.find((request) => request.args[0] === "build");
    expect(build?.args).toContain("--network=none");
    expect(build?.args).not.toContain("apps/node-quickstart/Dockerfile");
    expect(build?.args.at(-2)).toBe("pactmark-node-quickstart:conformance-unit");
    expect(build?.args.at(-1)).toMatch(/pactmark-container-conformance-/u);
    const run = docker.requests.find((request) => request.args[0] === "run");
    expect(run?.args).toContain("--read-only");
    expect(run?.args).toContain("/tmp:rw,noexec,nosuid,size=16m");
    expect(run?.args).toContain("127.0.0.1::3000");
    expect(run?.args).not.toContain("--env");
    expect(urls).toEqual([
      "http://127.0.0.1:49153/healthz",
      "http://127.0.0.1:49153/readyz",
      "http://127.0.0.1:49153/v1/runs",
      "http://127.0.0.1:49153/v1/runs/run-oci-1",
      "http://127.0.0.1:49153/v1/runs/run-oci-1/cancel",
    ]);
    expect(docker.requests.at(-1)?.args).toEqual([
      "rm",
      "--force",
      "pactmark-node-conformance-unit",
    ]);
  });

  it("fails closed with a stable code when Docker is unavailable", async () => {
    const docker = new DockerDouble();
    docker.failVersion = true;

    await expect(
      runContainerConformance({ commandRunner: docker, id: "unavailable" }),
    ).rejects.toMatchObject({
      code: "KAF_CONTAINER_RUNTIME_UNAVAILABLE",
    });
    expect(docker.requests).toHaveLength(1);
  });

  it("always removes a started container after a contract failure", async () => {
    const docker = new DockerDouble();

    await expect(
      runContainerConformance({
        commandRunner: docker,
        fetcher: () => Promise.resolve(json({ status: "starting" }, 503)),
        healthAttempts: 1,
        id: "teardown",
        wait: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      code: "KAF_CONTAINER_HEALTH_UNAVAILABLE",
    });
    expect(docker.requests.at(-1)?.args).toEqual([
      "rm",
      "--force",
      "pactmark-node-conformance-teardown",
    ]);
  });
});
