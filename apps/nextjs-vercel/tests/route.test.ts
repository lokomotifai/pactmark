import { describe, expect, it } from "vitest";

import { createNextVercelHandler } from "../src/host";

function id(seed: string): string {
  return `kafcmd_${String(Date.now()).padStart(13, "0")}_${seed.padEnd(32, "0").slice(0, 32)}`;
}

function requestBody() {
  return {
    schemaVersion: "1",
    agent: { id: "nextjs-vercel-agent", version: "0.1.0" },
    goal: "Check the bounded fixture.",
    input: { item: "notebook" },
    context: { roleFamily: "operations", workflowId: "route-test", riskClass: "low" },
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
        value: "nextjs-vercel-preview",
        normalizationVersion: "pactmark.policy-normalization@1",
      },
    ],
    budget: { maxTurns: 4, maxModelCalls: 4, maxToolCalls: 1, maxActiveExecutionMs: 10_000 },
  };
}

describe("Next Vercel catch-all route", () => {
  it("mounts health, readiness, OpenAPI, CORS, streaming, reconnect, inspection, and cancel", async () => {
    const handler = createNextVercelHandler({ profile: "preview" });
    const health = await handler(new Request("https://fixture.test/api/agent/healthz"));
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toContain("no-store");
    const readiness = await handler(new Request("https://fixture.test/api/agent/readyz"));
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({ ready: false });
    const openapi = await handler(new Request("https://fixture.test/api/agent/openapi.json"));
    expect(openapi.status).toBe(200);
    expect(await openapi.json()).toMatchObject({ openapi: "3.1.0" });
    const options = await handler(
      new Request("http://localhost:3000/api/agent/v1/runs", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, idempotency-key",
        },
      }),
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");

    const streamed = await handler(
      new Request("https://fixture.test/api/agent/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id("1") },
        body: JSON.stringify(requestBody()),
      }),
    );
    if (streamed.status !== 200) throw new Error(await streamed.text());
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const stream = await streamed.text();
    expect(stream).toContain("event: RunAccepted");
    expect(stream).toContain("event: ToolCallCompleted");
    expect(stream).toContain("event: RunCompleted");
    expect(stream).not.toContain("challengeProof");
    const runId = /"runId":"([^"]+)"/u.exec(stream)?.[1];
    expect(runId).toBeDefined();
    if (runId === undefined) return;

    const projection = await handler(
      new Request(`https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}`),
    );
    expect(projection.status).toBe(200);
    expect(await projection.json()).toMatchObject({ runId, status: "completed" });
    const events = await handler(
      new Request(
        `https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/events?after=1`,
        { headers: { accept: "text/event-stream", "last-event-id": "1" } },
      ),
    );
    expect(await events.text()).not.toContain("id: 1\n");
    const cancelled = await handler(
      new Request(`https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id("2") },
        body: JSON.stringify({ reason: "route test cleanup" }),
      }),
    );
    expect(cancelled.status).toBe(400);
    expect(await cancelled.json()).toMatchObject({ code: "KAF_SCHEMA_INVALID" });
  });

  it("requires configured bearer authentication in the production-shaped profile", async () => {
    const handler = createNextVercelHandler({
      profile: "production",
      readEnvironment: () => ({}),
    });
    const response = await handler(new Request("https://fixture.test/api/agent/v1/runs/hidden"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "KAF_HTTP_AUTHENTICATION_REQUIRED" });
  });
});
