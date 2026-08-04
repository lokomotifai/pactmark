import { describe, expect, it } from "vitest";

import {
  MODEL_NAMES,
  PACKAGE_MANAGER_NAMES,
  STORE_NAMES,
  TEMPLATE_NAMES,
  materializeTemplate,
} from "../src/index.js";

describe("embedded templates", () => {
  it("materializes every versioned combination deterministically", () => {
    for (const template of TEMPLATE_NAMES) {
      for (const model of MODEL_NAMES) {
        for (const store of STORE_NAMES) {
          for (const packageManager of PACKAGE_MANAGER_NAMES) {
            const input = { projectName: "fixture-agent", template, model, store, packageManager };
            const first = materializeTemplate(input);
            const second = materializeTemplate(input);
            expect(first).toEqual(second);
            expect(first.files.map((file) => file.path)).toEqual(
              [...first.files.map((file) => file.path)].sort(),
            );
            expect(first.dependencies["@pactmark/agent"]).toBe("0.1.0");
            for (const [name, version] of Object.entries({
              ...first.dependencies,
              ...first.devDependencies,
            })) {
              if (name.startsWith("@pactmark/")) expect(version).toBe("0.1.0");
              expect(version).not.toBe("latest");
              expect(version).not.toContain("workspace:");
            }
          }
        }
      }
    }
  });

  it("generates the required scripts and exact executor wiring", () => {
    for (const template of TEMPLATE_NAMES) {
      const result = materializeTemplate({
        projectName: "fixture-agent",
        template,
        model: "mock-only",
        store: "memory",
        packageManager: "pnpm",
      });
      for (const script of ["dev", "build", "start", "test", "typecheck", "lint", "doctor"]) {
        expect(typeof result.scripts[script]).toBe("string");
      }
      const host = result.files.find((file) => file.path === "src/host.ts")?.content ?? "";
      expect(host).toContain('from "@pactmark/executor-in-process"');
      expect(host).toContain("createDeclaredToolExecutor");
      expect(host).toContain("createDenyAllEgressBroker");
      expect(host).toContain("runtime.getCapabilities()");
    }
  });

  it("keeps platform scripts honest", () => {
    const library = materializeTemplate({
      projectName: "fixture-agent",
      template: "library",
      model: "mock-only",
      store: "memory",
      packageManager: "npm",
    });
    expect(Object.keys(library.scripts).some((name) => name.startsWith("deploy:"))).toBe(false);

    const node = materializeTemplate({
      projectName: "fixture-agent",
      template: "node-server",
      model: "mock-only",
      store: "memory",
      packageManager: "npm",
    });
    expect(node.scripts).toHaveProperty("container:build");
    expect(node.scripts).toHaveProperty("container:run");
    expect(Object.keys(node.scripts).some((name) => name.startsWith("deploy:"))).toBe(false);
    const nodeServer = node.files.find((file) => file.path === "src/server.ts")?.content ?? "";
    expect(nodeServer).toContain("createPactmarkNodeServer");
    expect(nodeServer).toContain("createAgentFetchHandler");
    expect(nodeServer).toContain('basePath: "/api/agent"');

    for (const template of ["vercel-next", "cloudflare-worker"] as const) {
      const platform = materializeTemplate({
        projectName: "fixture-agent",
        template,
        model: "mock-only",
        store: "memory",
        packageManager: "npm",
      });
      expect(platform.scripts["deploy:preview"]).toContain("doctor --profile preview");
      expect(platform.scripts["deploy:production"]).toContain("doctor --production");
      expect(platform.files.map((file) => file.content).join("\n")).not.toContain(
        "KAF_HOST_CONFIGURATION_REQUIRED",
      );
    }

    const next = materializeTemplate({
      projectName: "fixture-agent",
      template: "vercel-next",
      model: "mock-only",
      store: "memory",
      packageManager: "npm",
    });
    const nextRoute =
      next.files.find((file) => file.path === "app/api/agent/[...kaf]/route.ts")?.content ?? "";
    expect(nextRoute).toContain("createVercelRouteHandler");
    expect(nextRoute).toContain('fetchCache = "force-no-store"');
    expect(nextRoute).toContain('basePath: "/api/agent"');

    const cloudflare = materializeTemplate({
      projectName: "fixture-agent",
      template: "cloudflare-worker",
      model: "mock-only",
      store: "memory",
      packageManager: "npm",
    });
    const worker = cloudflare.files.find((file) => file.path === "src/worker.ts")?.content ?? "";
    expect(worker).toContain("createCloudflareWorker");
    expect(worker).toContain('basePath: "/api/agent"');
  });
});
