import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import worker, { CLOUDFLARE_COMPATIBILITY_DATE, getCloudflareRuntime } from "../src/worker.js";

const context = {
  waitUntil: (promise: Promise<unknown>) => {
    void promise;
  },
};
const bindings = { PACTMARK_PROFILE: "preview" };
function commandId(): string {
  return `kafcmd_${String(Date.now()).padStart(13, "0")}_abcdefabcdefabcdefabcdefabcdefab`;
}

function workOrder() {
  return {
    schemaVersion: "1",
    agent: { id: "cloudflare-worker-agent", version: "0.1.0" },
    goal: "Check the Worker fixture.",
    input: { item: "notebook" },
    context: { roleFamily: "operations", workflowId: "worker-test", riskClass: "low" },
    workMode: "assist",
    autonomyMode: "assist",
    decisionOwner: { mode: "requesting_principal" },
    purpose: { code: "service_delivery", registryVersion: "general@1" },
    dataClass: "public",
    retention: { mode: "session" },
    requestedCapabilities: ["fixture:read"],
    resourceScopeCeiling: [
      {
        kind: "tenant",
        value: "cloudflare-preview",
        normalizationVersion: "pactmark.policy-normalization@1",
      },
    ],
    budget: { maxTurns: 4, maxModelCalls: 4, maxToolCalls: 1, maxActiveExecutionMs: 10_000 },
  };
}

describe("Cloudflare Module Worker", () => {
  it("serves the deterministic portable Web API contract", async () => {
    const health = await worker.fetch(
      new Request("https://worker.test/api/agent/healthz"),
      bindings,
      context,
    );
    expect(health.status).toBe(200);
    const readiness = await worker.fetch(
      new Request("https://worker.test/api/agent/readyz"),
      bindings,
      context,
    );
    expect(readiness.status).toBe(503);
    expect(getCloudflareRuntime().getCapabilities()).toMatchObject({
      executionProfile: "ephemeral",
      durableStorage: false,
      backgroundWakeup: false,
    });
    const response = await worker.fetch(
      new Request("https://worker.test/api/agent/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": commandId() },
        body: JSON.stringify(workOrder()),
      }),
      bindings,
      context,
    );
    if (response.status !== 200) throw new Error(await response.text());
    const stream = await response.text();
    expect(stream).toContain("event: RunAccepted");
    expect(stream).toContain("event: ToolCallCompleted");
    expect(stream).toContain("event: RunCompleted");
  });

  it("pins compatibility and contains no node compatibility escape hatch", async () => {
    expect(CLOUDFLARE_COMPATIBILITY_DATE).toBe("2026-08-03");
    const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
    const stagingConfigPath = fileURLToPath(new URL("../wrangler.staging.jsonc", import.meta.url));
    const workerPath = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
    const agentPath = fileURLToPath(new URL("../src/agent.ts", import.meta.url));
    const [config, stagingConfig, workerSource, agentSource] = await Promise.all([
      readFile(configPath, "utf8"),
      readFile(stagingConfigPath, "utf8"),
      readFile(workerPath, "utf8"),
      readFile(agentPath, "utf8"),
    ]);
    expect(config).toContain('"compatibility_date": "2026-08-03"');
    expect(config).toContain('"compatibility_flags": []');
    expect(config).not.toContain("nodejs_compat");
    expect(stagingConfig).toContain('"workers_dev": false');
    expect(stagingConfig).toContain('"preview_urls": false');
    expect(`${workerSource}\n${agentSource}`).not.toMatch(/node:|process\.|Buffer\b|require\(/u);
  });
});
