import { describe, expect, it } from "vitest";

import { createNextVercelHandler, selectHostProfile } from "../src/host";

function id(seed: string): string {
  return `kafcmd_${String(Date.now()).padStart(13, "0")}_${seed.padEnd(32, "0").slice(0, 32)}`;
}

async function readUntil(response: Response, marker: string): Promise<string> {
  if (response.body === null) throw new Error("missing response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    text += decoder.decode(item.value, { stream: true });
    if (text.includes(marker)) {
      await reader.cancel();
      break;
    }
  }
  return text;
}

function requestBody(tenantId = "nextjs-vercel-preview", item = "notebook") {
  return {
    schemaVersion: "1",
    agent: { id: "nextjs-vercel-agent", version: "0.1.0" },
    goal: "Check the bounded fixture.",
    input: { item },
    context: { roleFamily: "operations", workflowId: "route-test", riskClass: "high" },
    workMode: "assist",
    autonomyMode: "assist",
    decisionOwner: { mode: "requesting_principal" },
    purpose: { code: "service_delivery", registryVersion: "general@1" },
    dataClass: "public",
    retention: { mode: "session" },
    requestedCapabilities: ["fixture:reserve"],
    resourceScopeCeiling: [
      {
        kind: "tenant",
        value: tenantId,
        normalizationVersion: "pactmark.policy-normalization@1",
      },
    ],
    budget: { maxTurns: 4, maxModelCalls: 4, maxToolCalls: 1, maxActiveExecutionMs: 10_000 },
  };
}

describe("Next Vercel catch-all route", () => {
  it("enables anonymous preview mode only when it is explicitly selected", () => {
    expect(selectHostProfile("preview")).toBe("preview");
    expect(selectHostProfile("production")).toBe("production");
    expect(selectHostProfile(undefined)).toBe("production");
    expect(selectHostProfile("prod")).toBe("production");
  });

  it("mounts a reachable challenge, approval, explicit resume, and inspection flow", async () => {
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

    const startAbort = new AbortController();
    const streamed = await handler(
      new Request("https://fixture.test/api/agent/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id("1") },
        body: JSON.stringify(requestBody("nextjs-vercel-preview", "camera")),
        signal: startAbort.signal,
      }),
    );
    if (streamed.status !== 200) throw new Error(await streamed.text());
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const stream = await readUntil(streamed, "event: ApprovalRequested");
    startAbort.abort();
    expect(stream).toContain("event: RunAccepted");
    expect(stream).toContain("event: ApprovalRequested");
    expect(stream).toContain('"title":"Reserve fixture item"');
    expect(stream).toContain('"value":"camera"');
    expect(stream).not.toContain('"value":"notebook"');
    expect(stream).not.toContain("event: EffectPrepared");
    expect(stream).not.toContain("challengeProof");
    const runId = /"runId":"([^"]+)"/u.exec(stream)?.[1];
    const decisionId = /"decisionId":"([^"]+)"/u.exec(stream)?.[1];
    expect(runId).toBeDefined();
    expect(decisionId).toBeDefined();
    if (runId === undefined || decisionId === undefined) return;

    const challengeResponse = await handler(
      new Request(
        `https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}/challenge`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": id("2") },
          body: "{}",
        },
      ),
    );
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()) as {
      challengeProof?: string;
      expiresAt?: string;
    };
    expect(challenge.challengeProof).toMatch(/^pactmark_local_/u);
    if (challenge.challengeProof === undefined) return;
    const approved = await handler(
      new Request(
        `https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": id("3") },
          body: JSON.stringify({
            decision: "approve",
            decisionId,
            challengeProof: challenge.challengeProof,
          }),
        },
      ),
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ runId, automaticResume: false });
    const resumed = await handler(
      new Request(`https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id("4") },
        body: "{}",
      }),
    );
    expect(resumed.status).toBe(200);
    const resumedValue: unknown = await resumed.json();
    expect(resumedValue).toMatchObject({ runId, status: "completed" });

    const projection = await handler(
      new Request(`https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}`),
    );
    expect(projection.status).toBe(200);
    expect(await projection.json()).toMatchObject({ runId, status: "completed" });
    const events = await handler(
      new Request(
        `https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/events?after=0`,
        { headers: { accept: "text/event-stream" } },
      ),
    );
    const completedEvents = await events.text();
    expect(completedEvents).toContain("event: ApprovalRecorded");
    expect(completedEvents).toContain("event: EffectPrepared");
    expect(completedEvents).toContain("event: ToolCallCompleted");
    expect(completedEvents).toContain("event: RunCompleted");
    expect(completedEvents).not.toContain(challenge.challengeProof);
    const cancelled = await handler(
      new Request(`https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id("5") },
        body: JSON.stringify({ reason: "route test cleanup" }),
      }),
    );
    expect(cancelled.status).toBe(400);
    expect(await cancelled.json()).toMatchObject({ code: "KAF_SCHEMA_INVALID" });
  });

  it("records a rejection and never prepares the proposed effect", async () => {
    const handler = createNextVercelHandler({ profile: "preview" });
    const startAbort = new AbortController();
    const started = await handler(
      new Request("https://fixture.test/api/agent/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id("6") },
        body: JSON.stringify(requestBody()),
        signal: startAbort.signal,
      }),
    );
    const startEvents = await readUntil(started, "event: ApprovalRequested");
    startAbort.abort();
    const runId = /"runId":"([^"]+)"/u.exec(startEvents)?.[1];
    const decisionId = /"decisionId":"([^"]+)"/u.exec(startEvents)?.[1];
    if (runId === undefined || decisionId === undefined) throw new Error("approval gate missing");
    const challenged = await handler(
      new Request(
        `https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}/challenge`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": id("7") },
          body: "{}",
        },
      ),
    );
    const challenge = (await challenged.json()) as { challengeProof: string };
    const rejected = await handler(
      new Request(
        `https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": id("8") },
          body: JSON.stringify({
            decision: "reject",
            decisionId,
            challengeProof: challenge.challengeProof,
            reasonCode: "fixture_user_rejected",
          }),
        },
      ),
    );
    expect(rejected.status).toBe(200);
    const projection = await handler(
      new Request(`https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}`),
    );
    expect(await projection.json()).toMatchObject({ status: "failed" });
    const events = await handler(
      new Request(`https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/events`),
    );
    const eventList = (await events.json()) as Array<{ eventType?: string }>;
    expect(eventList.map((event) => event.eventType)).toContain("ApprovalRejected");
    expect(eventList.map((event) => event.eventType)).not.toContain("EffectPrepared");
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

  it("does not let the production bearer fixture satisfy R4 phishing-resistant approval", async () => {
    const token = "fixture-bearer-token-1234";
    const authorization = `Bearer ${token}`;
    const handler = createNextVercelHandler({
      profile: "production",
      readEnvironment: () => ({ PACTMARK_BEARER_TOKEN: token }),
    });
    const started = await handler(
      new Request("https://fixture.test/api/agent/v1/runs", {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": id("9"),
        },
        body: JSON.stringify(requestBody("nextjs-vercel-production")),
      }),
    );
    const startEvents = await readUntil(started, "event: ApprovalRequested");
    const runId = /"runId":"([^"]+)"/u.exec(startEvents)?.[1];
    const decisionId = /"decisionId":"([^"]+)"/u.exec(startEvents)?.[1];
    if (runId === undefined || decisionId === undefined) throw new Error("approval gate missing");
    const challenged = await handler(
      new Request(
        `https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}/challenge`,
        {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            "idempotency-key": id("10"),
          },
          body: "{}",
        },
      ),
    );
    expect(challenged.status).toBe(200);
    const challenge = (await challenged.json()) as { challengeProof: string };
    const approved = await handler(
      new Request(
        `https://fixture.test/api/agent/v1/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}`,
        {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            "idempotency-key": id("11"),
          },
          body: JSON.stringify({
            decision: "approve",
            decisionId,
            challengeProof: challenge.challengeProof,
          }),
        },
      ),
    );
    expect(approved.status).toBe(403);
    expect(await approved.json()).toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
  });
});
