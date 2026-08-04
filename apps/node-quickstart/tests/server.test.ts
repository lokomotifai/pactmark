import { once } from "node:events";

import { createCommandId, createWorkOrderRequest } from "@pactmark/agent";
import { closeNodeServer, createPactmarkNodeServer } from "@pactmark/node";
import { afterEach, expect, it } from "vitest";

import { nodeQuickstartHandler, nodeQuickstartRuntime } from "../src/host.js";
import { nodeQuickstartAgent } from "../src/agent.js";

const servers: ReturnType<typeof createPactmarkNodeServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeNodeServer(server)));
});

it("serves health, readiness, and OpenAPI through the real Node bridge", async () => {
  const server = createPactmarkNodeServer(nodeQuickstartHandler, {
    capabilities: nodeQuickstartRuntime.getCapabilities(),
    readEnvironment: () => ({}),
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("KAF_NODE_ADDRESS_INVALID");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  await expect(fetch(`${origin}/healthz`).then((response) => response.json())).resolves.toEqual({
    status: "ok",
  });
  await expect(fetch(`${origin}/readyz`).then((response) => response.status)).resolves.toBe(503);
  await expect(fetch(`${origin}/openapi.json`).then((response) => response.status)).resolves.toBe(
    200,
  );
  const workOrder = createWorkOrderRequest({
    agent: { id: nodeQuickstartAgent.id, version: nodeQuickstartAgent.version },
    goal: "Read the bounded Node quickstart fixture.",
    input: { item: "notebook" },
    context: { roleFamily: "developer", workflowId: "node-quickstart", riskClass: "low" },
    workMode: "assist",
    autonomyMode: "assist",
    decisionOwner: { mode: "requesting_principal" },
    purpose: { code: "service_delivery", registryVersion: "general@1" },
    dataClass: "public",
    retention: { mode: "session" },
    requestedCapabilities: ["fixture:read"],
    budget: { maxTurns: 4, maxModelCalls: 4, maxToolCalls: 1, maxActiveExecutionMs: 10_000 },
  });
  for (let index = 0; index < 2; index += 1) {
    const run = await fetch(`${origin}/v1/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": createCommandId(),
      },
      body: JSON.stringify(workOrder),
    });
    const stream = await run.text();
    expect(run.status, stream).toBe(200);
    expect(run.headers.get("content-type")).toContain("text/event-stream");
    expect(stream).toContain("event: ToolCallCompleted");
    expect(stream).toContain("event: RunCompleted");
    if (index === 0) {
      const runId = /"runId":"([^"]+)"/u.exec(stream)?.[1];
      const artifactId = /"artifactId":"([^"]+)"/u.exec(stream)?.[1];
      expect(runId).toBeDefined();
      expect(artifactId).toBeDefined();
      const artifact = await fetch(
        `${origin}/v1/runs/${String(runId)}/artifacts/${String(artifactId)}`,
      );
      expect(artifact.status).toBe(200);
      expect(artifact.headers.get("cache-control")).toContain("no-store");
      await expect(artifact.json()).resolves.toEqual({
        summary: "notebook is available",
        source: "local-fixture",
      });
      const verification = await fetch(
        `${origin}/v1/runs/${String(runId)}/artifacts/${String(artifactId)}/verification`,
      );
      await expect(verification.json()).resolves.toMatchObject({
        artifactId,
        evidence: { verificationRefs: [{ status: "pass" }] },
      });
      const evidence = await fetch(`${origin}/v1/runs/${String(runId)}/evidence`, {
        headers: { accept: "text/markdown" },
      });
      expect(evidence.headers.get("content-type")).toContain("text/markdown");
      expect(await evidence.text()).toContain("## Verification references");
      await expect(
        fetch(`${origin}/v1/runs/${String(runId)}/artifacts/missing-artifact`).then(
          (response) => response.status,
        ),
      ).resolves.toBe(404);
    }
  }
});
