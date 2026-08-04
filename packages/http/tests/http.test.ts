import { describe, expect, it } from "vitest";

import {
  createAuthorityIssuer,
  digestCanonicalJson,
  KafError,
  type AgentDefinition,
  type Artifact,
  type CommandContext,
  type EvidenceRecord,
  type JsonValue,
  type RunEvent,
  type RuntimeCapabilities,
  type RuntimeReadinessReport,
  type WorkOrderRequest,
} from "@pactmark/core";

import {
  createAgentFetchHandler,
  type AgentFetchHandlerConfig,
  type AgentRuntimeContext,
  type AuthenticatedRequest,
  type HttpRuntimeSurface,
} from "../src/index.js";

const digest = digestCanonicalJson("fixture");
const commandId = "kafcmd_1760000000000_0123456789abcdef0123456789abcdef";

const capabilities: RuntimeCapabilities = {
  schemaVersion: "1",
  executionProfile: "ephemeral",
  durableStorage: false,
  protectedContext: true,
  protectedWorkOrders: false,
  protectedInputSubmissions: true,
  streaming: true,
  cancellation: true,
  sandbox: "unsafe_local",
  networkPolicy: "declared",
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: true,
  typedInput: true,
  effectReconciliation: true,
  compensation: true,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: ["memory.process-local"],
};

const readiness = (ready: boolean): RuntimeReadinessReport => ({
  schemaVersion: "1",
  ready,
  profile: "production",
  capabilities,
  checks: [
    {
      schemaVersion: "1",
      id: "durability",
      status: ready ? "pass" : "fail",
      code: ready ? "KAF_RUNTIME_READY" : "KAF_RUNTIME_NOT_READY",
      safeMessage: ready ? "Runtime is ready." : "Durable storage is unavailable.",
      remediationSlug: "configure-durable-storage",
      requiredCapability: "durableStorage",
    },
  ],
  evaluatedAt: "2026-08-03T00:00:00.000Z",
  rulesVersion: "pactmark.readiness@1",
});

const agent: AgentDefinition = {
  schemaVersion: "1",
  id: "fixture-agent",
  version: "0.1.0",
  description: "Fixture agent",
  instructions: {
    schemaVersion: "1",
    entries: [{ schemaVersion: "1", sourceName: "test", text: "Test.", contentDigest: digest }],
    bundleDigest: digest,
  },
  skillManifestDigests: [],
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
  toolRegistrationDigests: [],
  policyRegistrationDigest: digest,
  verifierRegistrationDigests: [digest],
  modelSecurityProfileDigest: digest,
  modelResourceProfileDigest: digest,
  modelAdapterRegistrationDigest: digest,
  modelConfig: {},
  requiredRuntimeCapabilities: [],
  agentDefinitionDigest: digest,
};

const workOrder: WorkOrderRequest = {
  schemaVersion: "1",
  agent: { id: agent.id, version: agent.version },
  goal: "Run the fixture",
  input: { value: 1 },
  context: { roleFamily: "test", workflowId: "fixture", riskClass: "low" },
  workMode: "assist",
  autonomyMode: "assist",
  decisionOwner: { mode: "requesting_principal" },
  purpose: { code: "service_delivery", registryVersion: "general@1" },
  dataClass: "public",
  retention: { mode: "session" },
  requestedCapabilities: [],
  resourceScopeCeiling: [],
  budget: {
    maxTurns: 2,
    maxModelCalls: 2,
    maxToolCalls: 2,
    maxActiveExecutionMs: 1_000,
  },
};

const artifactContent = new TextEncoder().encode('{"ok":true}');
const artifactMaterial = {
  schemaVersion: "1" as const,
  artifactId: "artifact-1",
  contentDigest: digestCanonicalJson({ ok: true }),
  mediaType: "application/json",
  byteSize: artifactContent.byteLength,
  location: { kind: "inline" as const, encoding: "utf8" as const, content: '{"ok":true}' },
  tenantId: "tenant",
  producingRunId: "run-1",
  producingStepId: "step-1",
  owner: { type: "principal" as const, id: "user" },
  visibility: "private" as const,
  dataClass: "public" as const,
  purposeCode: "service_delivery",
  retention: { mode: "session" as const },
  provenance: {
    schemaVersion: "1" as const,
    executionDefinition: {
      kind: "agent" as const,
      id: agent.id,
      version: agent.version,
      agentDefinitionDigest: agent.agentDefinitionDigest,
    },
    executionDefinitionDigest: digest,
    workOrderBindingDigest: digest,
    producingEventId: "event-1",
    sourceArtifactDigests: [],
    toolRegistrationDigests: [],
    metadata: {},
  },
  createdAt: "2026-08-03T00:00:00.000Z",
};
const artifact: Artifact = {
  ...artifactMaterial,
  artifactDigest: digestCanonicalJson(artifactMaterial),
};
const evidenceMaterial = {
  schemaVersion: "1" as const,
  evidenceRecordId: "evidence-1",
  tenantId: "tenant",
  runId: "run-1",
  executionDefinition: artifact.provenance.executionDefinition,
  executionDefinitionDigest: digest,
  workOrderBindingDigest: digest,
  claim: { statement: "Fixture verified", claimType: "test", scope: "this run" },
  supports: ["The fixture artifact passed verification."],
  doesNotProve: ["The fixture is production ready."],
  context: {
    roleFamily: "test",
    workflowId: "fixture",
    riskClass: "low" as const,
    purposeCode: "service_delivery",
  },
  workSplit: {
    ai: { kind: "unavailable" as const, reason: "not_collected" as const },
    human: { kind: "unavailable" as const, reason: "not_collected" as const },
    description: "Not measured.",
  },
  artifactRefs: [{ artifactId: artifact.artifactId, artifactDigest: artifact.artifactDigest }],
  eventRefs: [{ eventId: "event-1", sequence: 1 }],
  approvalRefs: [],
  verificationRefs: [
    {
      verificationId: "verification-1",
      verificationDigest: digest,
      status: "pass" as const,
      artifactDigest: artifact.artifactDigest,
      verifierId: "fixture-verifier",
      verifierVersion: "1",
      verifierRegistrationDigest: digest,
      method: "deterministic" as const,
      rubricVersion: "1",
      rubricDigest: digest,
    },
  ],
  verificationExceptionRefs: [],
  permission: {
    purposeCode: "service_delivery",
    purposeRegistryVersion: "general@1",
    visibility: "private" as const,
    dataClass: "public" as const,
    retention: { mode: "session" as const },
  },
  freshness: {
    observedAt: "2026-08-03T00:00:00.000Z",
    validAt: "2026-08-03T00:00:00.000Z",
  },
  observation: {
    firstObservedAt: "2026-08-03T00:00:00.000Z",
    lastObservedAt: "2026-08-03T00:00:00.000Z",
    count: 1,
    repetitionStatus: "single" as const,
    independentObservationIds: [],
  },
  createdAt: "2026-08-03T00:00:00.000Z",
};
const evidence: EvidenceRecord = {
  ...evidenceMaterial,
  evidenceDigest: digestCanonicalJson(evidenceMaterial),
};

const issuer = createAuthorityIssuer("http-test");
const authority = issuer.issue({
  actor: { type: "user", id: "user" },
  tenant: { id: "tenant" },
  authenticatedAt: "2026-08-03T00:00:00.000Z",
  authenticationStrength: "multi_factor",
  decisionRoles: [],
  requestCorrelationId: "request",
  issuedAt: "2026-08-03T00:00:00.000Z",
  expiresAt: "2027-08-03T00:00:00.000Z",
});

const authentication: AuthenticatedRequest = {
  authority,
  principal: { type: "user", id: "user" },
  tenant: { id: "tenant" },
  credentialMode: "bearer",
};

class FixtureRuntime implements HttpRuntimeSurface {
  readonly calls: Array<
    Readonly<{ operation: string; command?: CommandContext; signal?: AbortSignal }>
  > = [];
  readonly receivedAgents: AgentDefinition[] = [];
  capabilities = capabilities;
  ready = false;

  start(
    _authority: typeof authority,
    receivedAgent: AgentDefinition,
    _request: WorkOrderRequest,
    command: CommandContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) {
    this.receivedAgents.push(receivedAgent);
    this.calls.push({ operation: "start", command, signal: options?.signal });
    return Promise.resolve({ runId: "run-1", workOrderId: "work-1" });
  }
  resume(
    _authority: typeof authority,
    _runId: string,
    command: CommandContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) {
    this.calls.push({ operation: "resume", command, signal: options?.signal });
    return Promise.resolve({ status: "completed" });
  }
  getRun() {
    return Promise.resolve<JsonValue | undefined>({ runId: "run-1", status: "completed" });
  }
  getEvidence() {
    return Promise.resolve(evidence);
  }
  getArtifacts() {
    return Promise.resolve([{ artifact, content: artifactContent }]);
  }
  async *events(): AsyncIterable<RunEvent> {
    await Promise.resolve();
    yield { sequence: 1, eventType: "RunAccepted" } as unknown as RunEvent;
  }
  submitInput(
    _authority: typeof authority,
    _runId: string,
    _requestId: string,
    _value: JsonValue,
    command: CommandContext,
  ) {
    this.calls.push({ operation: "input", command });
    return Promise.resolve({ accepted: true });
  }
  issueDecisionChallenge(
    _authority: typeof authority,
    _runId: string,
    _decisionId: string,
    command: CommandContext,
  ) {
    this.calls.push({ operation: "challenge", command });
    return Promise.resolve({ challengeProof: "opaque", expiresAt: "2026-08-03T00:01:00.000Z" });
  }
  approve(
    _authority: typeof authority,
    _runId: string,
    _decision: JsonValue,
    command: CommandContext,
  ) {
    this.calls.push({ operation: "approve", command });
    return Promise.resolve({ accepted: true });
  }
  reject(
    _authority: typeof authority,
    _runId: string,
    _decision: JsonValue,
    command: CommandContext,
  ) {
    this.calls.push({ operation: "reject", command });
    return Promise.resolve({ accepted: true });
  }
  reconcileEffect(
    _authority: typeof authority,
    _runId: string,
    _effectId: string,
    _resolution: JsonValue,
    command: CommandContext,
  ) {
    this.calls.push({ operation: "reconcile", command });
    return Promise.resolve({ reconciled: true });
  }
  requestCompensation(
    _authority: typeof authority,
    _runId: string,
    _effectId: string,
    _request: JsonValue,
    command: CommandContext,
  ) {
    this.calls.push({ operation: "compensate", command });
    return Promise.resolve({ compensationRunId: "run-compensation" });
  }
  cancel(
    _authority: typeof authority,
    _runId: string,
    _reason: JsonValue,
    command: CommandContext,
  ) {
    this.calls.push({ operation: "cancel", command });
    return Promise.resolve({ cancelled: true });
  }
  getCapabilities() {
    return this.capabilities;
  }
  evaluateReadiness() {
    return readiness(this.ready);
  }
}

const context: AgentRuntimeContext = {
  env: {},
  signal: new AbortController().signal,
  waitUntil: () => undefined,
  capabilities,
};

function config(runtime = new FixtureRuntime()): AgentFetchHandlerConfig {
  return {
    runtime,
    authenticate: () => Promise.resolve(authentication),
    authorize: () => Promise.resolve(true),
    resolveAgent: () => Promise.resolve(agent),
    allowedOrigins: ["https://app.example.com"],
  };
}

function mutation(path: string, body: JsonValue = {}): Request {
  return new Request(`https://api.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": commandId },
    body: JSON.stringify(body),
  });
}

describe("Pactmark HTTP handler", () => {
  it("exposes no-store health/readiness and cacheable OpenAPI with ETag", async () => {
    const runtime = new FixtureRuntime();
    const handler = createAgentFetchHandler(config(runtime));
    const health = await handler(new Request("https://api.example.com/healthz"), context);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toContain("no-store");
    const notReady = await handler(new Request("https://api.example.com/readyz"), context);
    expect(notReady.status).toBe(503);
    runtime.ready = true;
    expect((await handler(new Request("https://api.example.com/readyz"), context)).status).toBe(
      200,
    );
    const openapi = await handler(new Request("https://api.example.com/openapi.json"), context);
    expect(openapi.status).toBe(200);
    expect(openapi.headers.get("cache-control")).toContain("public");
    const etag = openapi.headers.get("etag");
    expect(etag).not.toBeNull();
    const cached = await handler(
      new Request("https://api.example.com/openapi.json", {
        headers: { "if-none-match": etag ?? "" },
      }),
      context,
    );
    expect(cached.status).toBe(304);
    const document = await openapi.clone().json();
    expect(document).toHaveProperty(["paths", "/v1/runs/{runId}/artifacts/{artifactId}"]);
    expect(document).toHaveProperty([
      "paths",
      "/v1/runs/{runId}/artifacts/{artifactId}/verification",
    ]);
    expect(document).toHaveProperty(["paths", "/v1/runs/{runId}/evidence"]);
  });

  it("streams a start and reuses the exact command id", async () => {
    const runtime = new FixtureRuntime();
    const handler = createAgentFetchHandler(config(runtime));
    const response = await handler(mutation("/v1/runs", workOrder), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("id: 1");
    expect(runtime.calls[0]?.command?.commandId).toBe(commandId);
    expect(runtime.receivedAgents[0]).toBe(agent);
  });

  it("propagates request cancellation into start and resume execution", async () => {
    const runtime = new FixtureRuntime();
    const handler = createAgentFetchHandler(config(runtime));
    const startController = new AbortController();
    const startRequest = new Request("https://api.example.com/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": commandId },
      body: JSON.stringify(workOrder),
      signal: startController.signal,
    });
    await handler(startRequest, context);
    const startSignal = runtime.calls[0]?.signal;
    expect(startSignal?.aborted).toBe(false);
    startController.abort("client_disconnect");
    expect(startSignal?.aborted).toBe(true);

    const resumeController = new AbortController();
    const resumeRequest = new Request("https://api.example.com/v1/runs/run-1/resume", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": commandId },
      body: "{}",
      signal: resumeController.signal,
    });
    await handler(resumeRequest, context);
    const resumeSignal = runtime.calls[1]?.signal;
    expect(resumeSignal?.aborted).toBe(false);
    resumeController.abort("client_disconnect");
    expect(resumeSignal?.aborted).toBe(true);
  });

  it("returns 202 only for an atomic working scheduler", async () => {
    const runtime = new FixtureRuntime();
    const handler = createAgentFetchHandler(config(runtime));
    const denied = mutation("/v1/runs", workOrder);
    denied.headers.set("prefer", "respond-async");
    expect((await handler(denied, context)).status).toBe(503);
    expect(runtime.calls).toHaveLength(0);
    runtime.capabilities = {
      ...capabilities,
      executionProfile: "durable",
      durableStorage: true,
      backgroundWakeup: true,
      atomicCommandAndWakeup: true,
    };
    const accepted = mutation("/v1/runs", workOrder);
    accepted.headers.set("prefer", "respond-async");
    const response = await handler(accepted, context);
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe("/v1/runs/run-1");
  });

  it("fails closed before accepting a resumable run without an atomic scheduler", async () => {
    const runtime = new FixtureRuntime();
    runtime.capabilities = {
      ...capabilities,
      executionProfile: "resumable",
    };
    const handler = createAgentFetchHandler(config(runtime));
    expect((await handler(mutation("/v1/runs", workOrder), context)).status).toBe(503);
    expect(runtime.calls).toHaveLength(0);
  });

  it("protects authenticated reads, cursors, and SSE reconnect", async () => {
    const runtime = new FixtureRuntime();
    const handler = createAgentFetchHandler(config(runtime));
    const run = await handler(new Request("https://api.example.com/v1/runs/run-1"), context);
    expect(run.status).toBe(200);
    expect(run.headers.get("cdn-cache-control")).toBe("no-store");
    const events = await handler(
      new Request("https://api.example.com/v1/runs/run-1/events?after=0"),
      context,
    );
    expect(await events.json()).toEqual([{ sequence: 1, eventType: "RunAccepted" }]);
    const stream = await handler(
      new Request("https://api.example.com/v1/runs/run-1/events", {
        headers: { accept: "text/event-stream", "last-event-id": "1" },
      }),
      context,
    );
    expect(await stream.text()).toContain("RunAccepted");
    const badCursor = await handler(
      new Request("https://api.example.com/v1/runs/run-1/events?after=-1"),
      context,
    );
    expect(badCursor.status).toBe(400);
  });

  it("retrieves bounded artifacts and exports verified evidence deterministically", async () => {
    const runtime = new FixtureRuntime();
    const handler = createAgentFetchHandler(config(runtime));
    const artifactResponse = await handler(
      new Request("https://api.example.com/v1/runs/run-1/artifacts/artifact-1"),
      context,
    );
    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get("cache-control")).toContain("no-store");
    expect(artifactResponse.headers.get("content-type")).toBe("application/json");
    expect(artifactResponse.headers.get("content-disposition")).toContain("attachment");
    expect(artifactResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await artifactResponse.arrayBuffer())).toEqual(artifactContent);

    const verification = await handler(
      new Request("https://api.example.com/v1/runs/run-1/artifacts/artifact-1/verification"),
      context,
    );
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toMatchObject({
      artifactId: "artifact-1",
      artifactDigest: artifact.artifactDigest,
      evidence: {
        evidenceRecordId: "evidence-1",
        verificationRefs: [{ verificationId: "verification-1", status: "pass" }],
      },
    });

    const json = await handler(
      new Request("https://api.example.com/v1/runs/run-1/evidence", {
        headers: { accept: "application/json" },
      }),
      context,
    );
    expect(json.headers.get("x-pactmark-evidence-digest")).toBe(evidence.evidenceDigest);
    const exportedJson = await json.text();
    expect(JSON.parse(exportedJson)).toEqual(evidence);
    const repeatedJson = await handler(
      new Request("https://api.example.com/v1/runs/run-1/evidence", {
        headers: { accept: "application/json" },
      }),
      context,
    );
    expect(await repeatedJson.text()).toBe(exportedJson);
    const markdown = await handler(
      new Request("https://api.example.com/v1/runs/run-1/evidence?format=markdown"),
      context,
    );
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(await markdown.text()).toContain("# Evidence: Fixture verified");
  });

  it("bounds exports and conceals missing or unauthorized run resources", async () => {
    const runtime = new FixtureRuntime();
    const bounded = createAgentFetchHandler({
      ...config(runtime),
      maximumArtifactResponseBytes: 1,
      maximumEvidenceResponseBytes: 1,
    });
    expect(
      (
        await bounded(
          new Request("https://api.example.com/v1/runs/run-1/artifacts/artifact-1"),
          context,
        )
      ).status,
    ).toBe(413);
    expect(
      (await bounded(new Request("https://api.example.com/v1/runs/run-1/evidence"), context))
        .status,
    ).toBe(413);
    const missingRuntime = new FixtureRuntime();
    missingRuntime.getArtifacts = () => Promise.resolve([]);
    missingRuntime.getEvidence = () => Promise.resolve(undefined);
    const missing = createAgentFetchHandler(config(missingRuntime));
    expect(
      (
        await missing(
          new Request("https://api.example.com/v1/runs/run-1/artifacts/artifact-1"),
          context,
        )
      ).status,
    ).toBe(404);
    expect(
      (await missing(new Request("https://api.example.com/v1/runs/run-1/evidence"), context))
        .status,
    ).toBe(404);
    const concealed = createAgentFetchHandler({
      ...config(runtime),
      authorize: (_authentication, request) =>
        Promise.resolve(!request.operation.startsWith("run.artifact")),
    });
    expect(
      (
        await concealed(
          new Request("https://api.example.com/v1/runs/run-other/artifacts/artifact-1"),
          context,
        )
      ).status,
    ).toBe(404);
    const foreignAuthority = issuer.issue({
      actor: { type: "user", id: "foreign-user" },
      tenant: { id: "foreign-tenant" },
      authenticatedAt: "2026-08-03T00:00:00.000Z",
      authenticationStrength: "multi_factor",
      decisionRoles: [],
      requestCorrelationId: "foreign-request",
      issuedAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2027-08-03T00:00:00.000Z",
    });
    runtime.getArtifacts = (receivedAuthority) =>
      receivedAuthority === authority
        ? Promise.resolve([{ artifact, content: artifactContent }])
        : Promise.reject(new KafError("KAF_STORAGE_NOT_FOUND"));
    const crossTenant = createAgentFetchHandler({
      ...config(runtime),
      authenticate: () =>
        Promise.resolve({
          ...authentication,
          authority: foreignAuthority,
          principal: { type: "user", id: "foreign-user" },
          tenant: { id: "foreign-tenant" },
        }),
    });
    expect(
      (
        await crossTenant(
          new Request("https://api.example.com/v1/runs/run-1/artifacts/artifact-1"),
          context,
        )
      ).status,
    ).toBe(404);
  });

  it("routes every mutation through authorization and idempotent commands", async () => {
    const runtime = new FixtureRuntime();
    const handler = createAgentFetchHandler(config(runtime));
    const cases: ReadonlyArray<readonly [string, JsonValue]> = [
      ["/v1/runs/run-1/resume", {}],
      ["/v1/runs/run-1/inputs/input-1", { value: "answer" }],
      ["/v1/runs/run-1/decisions/decision-1/challenge", {}],
      ["/v1/runs/run-1/decisions/decision-1", { decision: "approve", challengeProof: "x" }],
      ["/v1/runs/run-1/decisions/decision-1", { decision: "reject", challengeProof: "x" }],
      ["/v1/runs/run-1/effects/effect-1/reconcile", { resolution: "occurred" }],
      ["/v1/runs/run-1/effects/effect-1/compensate", { reason: "requested" }],
      ["/v1/runs/run-1/cancel", { reason: "user" }],
    ];
    for (const [path, body] of cases) {
      expect((await handler(mutation(path, body), context)).status).toBe(200);
    }
    expect(runtime.calls.map((call) => call.operation)).toEqual([
      "resume",
      "input",
      "challenge",
      "approve",
      "reject",
      "reconcile",
      "compensate",
      "cancel",
    ]);
    expect(runtime.calls[0]?.command.requestDigest).toBe(digestCanonicalJson({ runId: "run-1" }));
    expect(runtime.calls[2]?.command.requestDigest).toBe(digestCanonicalJson({}));
    expect(runtime.calls[7]?.command.requestDigest).toBe(
      digestCanonicalJson({ runId: "run-1", reason: "user" }),
    );
  });

  it("fails closed for authentication, authorization, JSON, size, and route errors", async () => {
    const runtime = new FixtureRuntime();
    const unauthenticated = createAgentFetchHandler({
      ...config(runtime),
      authenticate: () => Promise.resolve(undefined),
    });
    const unauthorized = await unauthenticated(
      new Request("https://api.example.com/v1/runs/run-1"),
      context,
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");
    const forbidden = createAgentFetchHandler({
      ...config(runtime),
      authorize: () => Promise.resolve(false),
    });
    expect(
      (await forbidden(new Request("https://api.example.com/v1/runs/run-1"), context)).status,
    ).toBe(403);
    const handler = createAgentFetchHandler({ ...config(runtime), maximumBodyBytes: 3 });
    expect(
      (await handler(mutation("/v1/runs/run-1/resume", { too: "large" }), context)).status,
    ).toBe(413);
    const noJson = new Request("https://api.example.com/v1/runs/run-1/resume", {
      method: "POST",
      headers: { "idempotency-key": commandId, "content-type": "text/plain" },
      body: "bad",
    });
    expect((await createAgentFetchHandler(config(runtime))(noJson, context)).status).toBe(415);
    expect(
      (
        await createAgentFetchHandler(config(runtime))(
          mutation("/v1/runs/run-1/decisions/decision-1", { decision: "maybe" }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await createAgentFetchHandler(config(runtime))(
          new Request("https://api.example.com/not-found"),
          context,
        )
      ).status,
    ).toBe(404);

    const invalidJson = new Request("https://api.example.com/v1/runs/run-1/resume", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": commandId },
      body: "{",
    });
    expect((await createAgentFetchHandler(config(runtime))(invalidJson, context)).status).toBe(400);
    const missingKey = new Request("https://api.example.com/v1/runs/run-1/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await createAgentFetchHandler(config(runtime))(missingKey, context)).status).toBe(400);
    expect(
      (
        await createAgentFetchHandler(config(runtime))(
          new Request("https://api.example.com/v1/runs/%E0%A4%A"),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await createAgentFetchHandler(config(runtime))(
          mutation("/v1/runs/run-1/unknown", {}),
          context,
        )
      ).status,
    ).toBe(404);

    class FailingRuntime extends FixtureRuntime {
      override start() {
        return Promise.reject(new KafError("KAF_RUNTIME_NOT_READY"));
      }
    }
    expect(
      (
        await createAgentFetchHandler(config(new FailingRuntime()))(
          mutation("/v1/runs", workOrder),
          context,
        )
      ).status,
    ).toBe(503);
  });

  it("enforces credentialed CORS, cookie Origin, Fetch Metadata, and CSRF", async () => {
    const cookieAuthentication: AuthenticatedRequest = {
      ...authentication,
      credentialMode: "cookie",
      allowedOrigins: ["https://app.example.com"],
      csrfToken: "csrf-token",
    };
    const handler = createAgentFetchHandler({
      ...config(),
      authenticate: () => Promise.resolve(cookieAuthentication),
    });
    const preflight = await handler(
      new Request("https://api.example.com/v1/runs", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, idempotency-key, x-csrf-token",
        },
      }),
      context,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example.com");

    const missing = mutation("/v1/runs", workOrder);
    expect((await handler(missing, context)).status).toBe(403);
    const missingFetchMetadata = mutation("/v1/runs", workOrder);
    missingFetchMetadata.headers.set("origin", "https://app.example.com");
    expect((await handler(missingFetchMetadata, context)).status).toBe(403);
    const missingCsrf = mutation("/v1/runs", workOrder);
    missingCsrf.headers.set("origin", "https://app.example.com");
    missingCsrf.headers.set("sec-fetch-site", "same-origin");
    expect((await handler(missingCsrf, context)).status).toBe(403);
    const valid = mutation("/v1/runs", workOrder);
    valid.headers.set("origin", "https://app.example.com");
    valid.headers.set("sec-fetch-site", "same-origin");
    valid.headers.set("x-csrf-token", "csrf-token");
    expect((await handler(valid, context)).status).toBe(200);

    const deniedPreflight = new Request("https://api.example.com/v1/runs", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "POST",
      },
    });
    expect((await handler(deniedPreflight, context)).status).toBe(403);
    const deniedMethod = new Request("https://api.example.com/v1/runs", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "DELETE",
      },
    });
    expect((await handler(deniedMethod, context)).status).toBe(403);
    const deniedHeader = new Request("https://api.example.com/v1/runs", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-unsafe",
      },
    });
    expect((await handler(deniedHeader, context)).status).toBe(403);
  });

  it("rejects unsafe construction and supports explicit development anonymity", async () => {
    expect(() => createAgentFetchHandler({ ...config(), authenticate: undefined })).toThrow(
      "KAF_HTTP_AUTHENTICATION_REQUIRED",
    );
    expect(() => createAgentFetchHandler({ ...config(), maximumBodyBytes: 0 })).toThrow(
      "KAF_HTTP_BODY_LIMIT_INVALID",
    );
    expect(() => createAgentFetchHandler({ ...config(), basePath: "relative" })).toThrow(
      "KAF_HTTP_BASE_PATH_INVALID",
    );
    const anonymous = createAgentFetchHandler({
      ...config(),
      authenticate: undefined,
      allowAnonymousDevelopment: true,
      anonymousAuthentication: authentication,
      basePath: "/agent",
    });
    expect(
      (await anonymous(new Request("https://api.example.com/agent/v1/runs/run-1"), context)).status,
    ).toBe(200);
    expect(
      (await anonymous(new Request("https://api.example.com/v1/runs/run-1"), context)).status,
    ).toBe(404);
  });
});
