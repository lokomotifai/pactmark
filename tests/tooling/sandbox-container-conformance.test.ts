import { describe, expect, it } from "vitest";

import {
  SandboxCommandExecutionError,
  runSandboxContainerConformance,
  type SandboxCommandRequest,
  type SandboxCommandRunner,
} from "../../tooling/sandbox-container/conformance.mjs";

const digest = `sha256:${"b".repeat(64)}`;
const baseRepoDigest =
  "node@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3";

class SandboxDockerDouble implements SandboxCommandRunner {
  readonly requests: SandboxCommandRequest[] = [];
  readonly containers = new Set<string>();
  failVersion = false;
  failIsolation = false;
  substituteBaseDigest = false;

  run(request: SandboxCommandRequest): Promise<{ stdout: string; stderr: string }> {
    this.requests.push(request);
    const [operation, second, third] = request.args;
    if (operation === "version") {
      if (this.failVersion) return Promise.reject(new Error("daemon unavailable"));
      return Promise.resolve({ stdout: "29.3.1\n", stderr: "" });
    }
    if (operation === "image" && second === "inspect") {
      if (request.args.at(-1)?.startsWith("node:24.18.1-alpine@sha256:") === true) {
        return Promise.resolve({
          stdout: JSON.stringify([
            this.substituteBaseDigest ? `node@sha256:${"0".repeat(64)}` : baseRepoDigest,
          ]),
          stderr: "",
        });
      }
      return Promise.resolve({
        stdout: request.args.includes("--format") ? `${digest}\n` : "[]\n",
        stderr: "",
      });
    }
    if (operation === "build") return Promise.resolve({ stdout: "built\n", stderr: "" });
    if (operation === "run") {
      const name = request.args[request.args.indexOf("--name") + 1];
      const imageIndex = request.args.findIndex((value) =>
        value.startsWith("pactmark-sandbox-reference:"),
      );
      const mode = request.args[imageIndex + 1];
      if (name === undefined) return Promise.reject(new Error("missing name"));
      this.containers.add(name);
      if (mode === "isolation") {
        if (this.failIsolation) {
          return Promise.reject(new SandboxCommandExecutionError("failed"));
        }
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: "1",
            mode: "isolation",
            uid: 65_532,
            gid: 65_532,
            checks: {
              hostSecretDenied: true,
              parentTraversalDenied: true,
              symlinkEscapeDenied: true,
              dockerSocketDenied: true,
              loopbackDenied: true,
              metadataDenied: true,
              workspaceWrite: true,
            },
            artifact: { path: "artifact.json", sha256: "c".repeat(64) },
          }),
          stderr: "",
        });
      }
      if (mode === "fork") {
        return Promise.resolve({
          stdout: JSON.stringify({ schemaVersion: "1", mode: "fork", limited: true, spawned: 20 }),
          stderr: "",
        });
      }
      if (mode === "loop") {
        return Promise.reject(new SandboxCommandExecutionError("timeout"));
      }
      if (mode === "output") {
        return Promise.reject(new SandboxCommandExecutionError("output_limit"));
      }
    }
    if (operation === "inspect" && second === "--format") {
      if (third === "{{json .HostConfig}}") {
        return Promise.resolve({
          stdout: JSON.stringify({
            NetworkMode: "none",
            ReadonlyRootfs: true,
            Tmpfs: { "/workspace": "rw,noexec,nosuid,nodev,size=16m" },
            Binds: null,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            PidsLimit: 32,
            Memory: 134_217_728,
            MemorySwap: 134_217_728,
            NanoCpus: 500_000_000,
          }),
          stderr: "",
        });
      }
      if (third === "{{json .Config}}") {
        return Promise.resolve({ stdout: JSON.stringify({ User: "65532:65532" }), stderr: "" });
      }
      if (third === "{{json .Mounts}}") {
        return Promise.resolve({
          stdout: JSON.stringify([{ Type: "tmpfs", Destination: "/workspace" }]),
          stderr: "",
        });
      }
    }
    if (operation === "rm" && second === "--force") {
      if (third !== undefined) this.containers.delete(third);
      return Promise.resolve({ stdout: `${third ?? ""}\n`, stderr: "" });
    }
    if (operation === "inspect" && second !== undefined) {
      return this.containers.has(second)
        ? Promise.resolve({ stdout: "[]\n", stderr: "" })
        : Promise.reject(new SandboxCommandExecutionError("failed"));
    }
    return Promise.reject(new Error(`unexpected command: ${request.args.join(" ")}`));
  }
}

describe("unsafe sandbox container reference", () => {
  it("pins isolation flags and bounds fork, loop, and output attacks", async () => {
    const docker = new SandboxDockerDouble();
    const result = await runSandboxContainerConformance({ commandRunner: docker, id: "unit" });

    expect(result).toMatchObject({
      claim: "unsafe_reference_fixture_not_production_isolation",
      imageDigest: digest,
      baseImage: { repoDigest: baseRepoDigest },
      probes: {
        hostSecretDenied: true,
        symlinkEscapeDenied: true,
        dockerSocketDenied: true,
        loopbackDenied: true,
        metadataDenied: true,
        artifactExport: true,
      },
      attacks: {
        fork: { boundedBy: "pids_limit", spawned: 20 },
        loop: { boundedBy: "host_timeout" },
        output: { boundedBy: "output_limit" },
      },
      cleanup: { containersRemoved: 4, hostCanaryRemoved: true },
    });
    const build = docker.requests.find((request) => request.args[0] === "build");
    expect(build?.args).toContain("--network=none");
    const runs = docker.requests.filter((request) => request.args[0] === "run");
    expect(runs).toHaveLength(4);
    for (const run of runs) {
      expect(run.args).toContain("none");
      expect(run.args).toContain("65532:65532");
      expect(run.args).toContain("--read-only");
      expect(run.args).toContain("ALL");
      expect(run.args).toContain("no-new-privileges");
      expect(run.args).toContain("32");
      expect(run.args).toContain("128m");
      expect(run.args).toContain("0.5");
      expect(run.args).not.toContain("--volume");
      expect(run.args).not.toContain("--mount");
      expect(run.args).not.toContain("-v");
    }
    expect(docker.containers.size).toBe(0);
  });

  it("fails instead of skipping when Docker is unavailable", async () => {
    const docker = new SandboxDockerDouble();
    docker.failVersion = true;

    await expect(
      runSandboxContainerConformance({ commandRunner: docker, id: "unavailable" }),
    ).rejects.toMatchObject({ code: "KAF_SANDBOX_CONTAINER_RUNTIME_UNAVAILABLE" });
    expect(docker.requests).toHaveLength(1);
  });

  it("fails closed when the retained base image digest is substituted", async () => {
    const docker = new SandboxDockerDouble();
    docker.substituteBaseDigest = true;

    await expect(
      runSandboxContainerConformance({ commandRunner: docker, id: "substituted-base" }),
    ).rejects.toMatchObject({ code: "KAF_SANDBOX_BASE_IMAGE_DIGEST_INVALID" });
    expect(docker.requests.some((request) => request.args[0] === "build")).toBe(false);
  });

  it("removes the named container and host canary after a probe failure", async () => {
    const docker = new SandboxDockerDouble();
    docker.failIsolation = true;

    await expect(
      runSandboxContainerConformance({ commandRunner: docker, id: "cleanup" }),
    ).rejects.toMatchObject({ code: "KAF_SANDBOX_ISOLATION_PROBE_FAILED" });
    expect(docker.requests.some((request) => request.args[0] === "rm")).toBe(true);
    expect(docker.containers.size).toBe(0);
  });
});
