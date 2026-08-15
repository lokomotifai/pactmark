import {
  createCommandContext,
  createCommandId,
  createLocalAuthorityIssuer,
  createLocalRuntime,
  createRuntime,
  createWorkOrderRequest,
  defineAgent,
  defineInstructions,
  defineModelResourceProfile,
  defineModelSecurityProfile,
  definePolicy,
  defineSchema,
  defineTool,
  evaluateRuntimeReadiness,
  type CompiledModelDefinition,
  type CreateRuntimeInput,
  type RuntimeCapabilities,
} from "../src/index.js";
import {
  createAuthorityIssuer,
  digestCanonicalJson,
  type JsonValue,
  type RunCommandTransaction,
} from "@pactmark/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const capabilities: RuntimeCapabilities = {
  schemaVersion: "1",
  executionProfile: "ephemeral",
  durableStorage: false,
  protectedContext: false,
  protectedWorkOrders: false,
  protectedInputSubmissions: false,
  streaming: true,
  cancellation: true,
  sandbox: "unsafe_local",
  networkPolicy: "declared",
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: false,
  typedInput: false,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: [],
};

const inputSchema = defineSchema({
  id: "fixture.agent.input",
  semanticRevision: "1",
  schema: z.object({ topic: z.string().min(1) }).strict(),
});
const outputSchema = defineSchema({
  id: "fixture.agent.output",
  semanticRevision: "1",
  schema: z.object({ title: z.string(), body: z.string() }).strict(),
});
const toolInput = defineSchema({
  id: "fixture.tool.input",
  semanticRevision: "1",
  schema: z.object({ query: z.string() }).strict(),
});
const toolOutput = defineSchema({
  id: "fixture.tool.output",
  semanticRevision: "1",
  schema: z.object({ result: z.string() }).strict(),
});

function modelDefinition(
  emit: (invocation: number) => Readonly<{ type: string; value: JsonValue }>,
  credentialMode: "ambient_preview" | "host_bound" = "ambient_preview",
): CompiledModelDefinition {
  let invocation = 0;
  const security = defineModelSecurityProfile({
    id: "fixture-local-model@1",
    provider: "fixture",
    model: "deterministic",
    endpointOrigin: "https://model.invalid",
    credentialSlot: "fixture.none",
    allowedTenants: ["local"],
    allowedPurposes: ["service_delivery"],
    allowedDataClasses: ["public"],
    processingRegion: "process-local",
    retention: "none",
    logging: "none",
    training: "none",
    contractReference: "local-fixture",
  });
  const resources = defineModelResourceProfile({
    id: "fixture-local-resources@1",
    implementationVersion: "1.0.0",
    maxInputBytesPerCall: 100_000,
    maxInputTokensPerCall: 10_000,
    maxOutputTokensPerCall: 1_000,
    maxStreamedOutputBytesPerCall: 100_000,
    maxStreamEventsPerCall: 100,
    maxToolResultToContextBytes: 100_000,
    maxContextSnapshotBytes: 100_000,
    maxRunModelInputBytes: 1_000_000,
    maxRunModelInputTokens: 100_000,
    maxRunModelOutputBytes: 1_000_000,
    maxRunModelOutputTokens: 10_000,
    maxRunToolResultToContextBytes: 1_000_000,
    estimator: "fixture.exact@1",
    providerOutputCap: "enforced",
  });
  return {
    modelSecurityProfileDigest: security.modelSecurityProfileDigest,
    modelResourceProfileDigest: resources.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: digestCanonicalJson({ adapter: "fixture@1" }),
    modelConfig: { kind: "deterministic" },
    credentialMode,
    driver: {
      capabilities,
      async *invoke() {
        await Promise.resolve();
        invocation += 1;
        yield emit(invocation);
      },
    },
  };
}

function requestFor(agent: { id: string; version: string }, capabilitiesInput: string[] = []) {
  return createWorkOrderRequest({
    agent,
    goal: "Produce a bounded local result",
    input: { topic: "Pactmark" },
    context: { roleFamily: "research", workflowId: "brief", riskClass: "low" },
    workMode: "augment",
    autonomyMode: "delegate_review",
    decisionOwner: { mode: "requesting_principal" },
    purpose: { code: "service_delivery", registryVersion: "general@1" },
    dataClass: "public",
    retention: { mode: "session" },
    requestedCapabilities: capabilitiesInput,
    resourceScopeCeiling: [
      { kind: "tenant", value: "local", normalizationVersion: "pactmark.policy-normalization@1" },
    ],
    budget: {
      maxTurns: 4,
      maxModelCalls: 4,
      maxToolCalls: 4,
      maxActiveExecutionMs: 30_000,
    },
  });
}

describe("public definitions", () => {
  it("normalizes instructions and creates immutable digest-bound definitions", () => {
    const instructions = defineInstructions({
      text: "\uFEFFFirst\r\nSecond\r",
      sourceName: "inline",
    });
    expect(instructions.entries[0]?.text).toBe("First\nSecond\n");
    expect(Object.isFrozen(instructions)).toBe(true);
    const policy = definePolicy({
      id: "fixture.policy",
      implementationVersion: "1.0.0",
      default: "deny",
      rules: [{ riskClass: "R0", decision: "allow_with_grant" }],
    });
    const model = modelDefinition(() => ({ type: "final", value: { title: "A", body: "B" } }));
    const agent = defineAgent({
      id: "fixture-agent",
      version: "0.1.0",
      description: "Fixture agent",
      input: inputSchema,
      instructions,
      model,
      policy,
      output: outputSchema,
      verifiers: ["schema@1"],
    });
    const changed = defineAgent({
      id: "fixture-agent",
      version: "0.1.0",
      description: "Fixture agent",
      input: inputSchema,
      instructions: defineInstructions({ text: "Changed" }),
      model,
      policy,
      output: outputSchema,
      verifiers: ["schema@1"],
    });
    expect(agent.agentDefinitionDigest).not.toBe(changed.agentDefinitionDigest);
    expect(Object.isFrozen(agent)).toBe(true);
    expect(() => defineInstructions({ text: "  " })).toThrow("must not be empty");
    const authority = createLocalAuthorityIssuer();
    expect(() =>
      createLocalRuntime({
        agents: [agent, changed],
        authorityIssuer: authority.issuer,
      }),
    ).toThrow("KAF_REGISTRATION_SAME_VERSION_DRIFT");
    expect(() =>
      createLocalRuntime({
        agents: [structuredClone(agent)],
        authorityIssuer: authority.issuer,
      }),
    ).toThrow("KAF_AGENT_NOT_COMPILED_BY_FACADE");
    const hostModelSource = modelDefinition(() => ({
      type: "final",
      value: { title: "A", body: "B" },
    }));
    const hostModel: CompiledModelDefinition = {
      modelSecurityProfileDigest: hostModelSource.modelSecurityProfileDigest,
      modelResourceProfileDigest: hostModelSource.modelResourceProfileDigest,
      modelAdapterRegistrationDigest: hostModelSource.modelAdapterRegistrationDigest,
      modelConfig: hostModelSource.modelConfig,
      driver: hostModelSource.driver,
    };
    const hostBoundAgent = defineAgent({
      id: "host-bound-agent",
      version: "0.1.0",
      description: "Host-bound fixture",
      input: inputSchema,
      instructions: defineInstructions({ text: "Run with host credentials." }),
      model: hostModel,
      policy,
      output: outputSchema,
      verifiers: ["schema@1"],
      requiredRuntimeCapabilities: ["streaming"],
    });
    expect(
      createLocalRuntime({ agents: [hostBoundAgent], authorityIssuer: authority.issuer })
        .evaluateReadiness({ profile: "preview" })
        .checks.map((check) => check.requiredCapability),
    ).toEqual(expect.arrayContaining(["model_credentials", "streaming"]));
  });

  it("rejects duplicate policy risks, verifier IDs, tools, and invalid tool output", () => {
    expect(() =>
      definePolicy({
        id: "duplicate.policy",
        implementationVersion: "1",
        default: "deny",
        rules: [
          { riskClass: "R0", decision: "deny" },
          { riskClass: "R0", decision: "allow_with_grant" },
        ],
      }),
    ).toThrow("unique");
    const operation = vi.fn(() => Promise.resolve({ result: 42 }));
    const tool = defineTool({
      id: "fixture.invalid@1",
      implementationVersion: "1.0.0",
      description: "Invalid output fixture",
      input: toolInput,
      output: toolOutput,
      security: {
        riskClass: "R0",
        dataClasses: ["public"],
        reversibility: "not_applicable",
        requiredScopes: ["fixture:read"],
        egress: { mode: "none" },
        networkEnforcement: "declared_ok",
        maxCallsPerRun: 1,
        timeoutMs: 1_000,
      },
      resources: (_input, context) => [
        {
          kind: "tenant",
          value: context.tenantId,
          normalizationVersion: "pactmark.policy-normalization@1",
        },
      ],
      operation: { kind: "read", execute: operation as never },
    });
    const policy = definePolicy({
      id: "duplicate-agent.policy",
      implementationVersion: "1",
      default: "deny",
      rules: [{ riskClass: "R0", decision: "allow_with_grant" }],
    });
    const model = modelDefinition(() => ({ type: "final", value: { title: "A", body: "B" } }));
    expect(() =>
      defineAgent({
        id: "duplicate-verifier-agent",
        version: "0.1.0",
        description: "Duplicate verifier",
        input: inputSchema,
        instructions: defineInstructions({ text: "Run" }),
        model,
        tools: { first: tool, second: tool },
        policy,
        output: outputSchema,
        verifiers: ["schema@1", "schema@1"],
      }),
    ).toThrow("tools must have unique");
    const singleToolAgent = defineAgent({
      id: "single-tool-agent",
      version: "0.1.0",
      description: "Single tool",
      input: inputSchema,
      instructions: defineInstructions({ text: "Run" }),
      model,
      tools: { tool },
      policy,
      output: outputSchema,
      verifiers: ["schema@1"],
    });
    expect(singleToolAgent.toolRegistrationDigests).toHaveLength(1);
    expect(operation).not.toHaveBeenCalled();
    expect(() =>
      defineAgent({
        id: "duplicate-verifier-agent",
        version: "0.1.0",
        description: "Duplicate verifier",
        input: inputSchema,
        instructions: defineInstructions({ text: "Run" }),
        model,
        policy,
        output: outputSchema,
        verifiers: ["schema@1", "schema@1"],
      }),
    ).toThrow("verifiers must be unique");
  });
});

describe("local runtime", () => {
  it("completes a no-key tool run and exposes artifact, evidence, stream, and honest readiness", async () => {
    const execute = vi.fn(({ query }: { query: string }) => Promise.resolve({ result: query }));
    const tool = defineTool({
      id: "fixture.search@1",
      implementationVersion: "1.0.0",
      description: "Deterministic local search",
      input: toolInput,
      output: toolOutput,
      security: {
        riskClass: "R1",
        dataClasses: ["public"],
        reversibility: "not_applicable",
        requiredScopes: ["fixture:read"],
        egress: { mode: "none" },
        networkEnforcement: "declared_ok",
        maxCallsPerRun: 2,
        timeoutMs: 1_000,
      },
      resources: (_input, context) => [
        {
          kind: "tenant",
          value: context.tenantId,
          normalizationVersion: "pactmark.policy-normalization@1",
        },
      ],
      operation: { kind: "read", execute },
    });
    const model = modelDefinition((invocation) =>
      invocation === 1
        ? {
            type: "tool_call",
            value: {
              toolRegistrationDigest: tool.registration.toolRegistrationDigest,
              input: { query: "bounded" },
              targetDigest: digestCanonicalJson({ target: "fixture" }),
            },
          }
        : { type: "final", value: { title: "Result", body: "bounded" } },
    );
    const agent = defineAgent({
      id: "local-agent",
      version: "0.1.0",
      description: "Local no-key agent",
      input: inputSchema,
      instructions: defineInstructions({ text: "Produce the bounded result." }),
      model,
      tools: { search: tool },
      policy: definePolicy({
        id: "local-agent.policy",
        implementationVersion: "1.0.0",
        default: "deny",
        rules: [{ riskClass: "R1", decision: "allow_with_grant" }],
      }),
      output: outputSchema,
      verifiers: ["schema@1"],
    });
    const localAuthority = createLocalAuthorityIssuer();
    const authority = localAuthority.issue({
      principal: { type: "user", id: "local-user" },
      tenant: { id: "local" },
    });
    const runtime = createLocalRuntime({ agents: [agent], authorityIssuer: localAuthority.issuer });
    const request = requestFor({ id: agent.id, version: agent.version }, ["fixture:read"]);
    const command = createCommandContext({
      commandId: createCommandId(),
      operation: "run.start",
      payload: request,
    });
    const started = await runtime.start(authority, agent, request, command);
    const eventTypes: string[] = [];
    for await (const event of runtime.events(authority, started.runId)) {
      eventTypes.push(event.eventType);
    }
    expect(eventTypes).toContain("ToolCallCompleted");
    expect(eventTypes.at(-1)).toBe("RunCompleted");
    expect((await runtime.wait(authority, started.runId)).status).toBe("completed");
    expect(execute).toHaveBeenCalledWith({ query: "bounded" }, expect.anything());
    const artifacts = await runtime.getArtifacts(authority, started.runId);
    expect(artifacts).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(artifacts[0]?.content))).toEqual({
      title: "Result",
      body: "bounded",
    });
    const evidence = await runtime.getEvidence(authority, started.runId);
    expect(evidence?.supports).toEqual([
      "The exact output artifact passed the registered local verifier set.",
    ]);
    expect(runtime.getCapabilities()).toMatchObject({
      executionProfile: "ephemeral",
      networkPolicy: "declared",
    });
    expect(runtime.evaluateReadiness({ profile: "production" })).toMatchObject({
      ready: false,
      profile: "production",
      rulesVersion: "pactmark.readiness@1",
    });
    const resumeCommand = createCommandContext({
      commandId: createCommandId(),
      operation: "run.resume",
      payload: { runId: started.runId },
    });
    await expect(runtime.resume(authority, started.runId, resumeCommand)).resolves.toMatchObject({
      status: "completed",
    });
    const cancelCommand = createCommandContext({
      commandId: createCommandId(),
      operation: "run.cancel",
      payload: { runId: started.runId },
    });
    await expect(runtime.cancel(authority, started.runId, cancelCommand)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(
      runtime.cancel(
        authority,
        started.runId,
        { reason: "fixture_cleanup" },
        createCommandContext({
          commandId: createCommandId(),
          operation: "run.cancel",
          payload: { runId: started.runId, reason: "fixture_cleanup" },
        }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(runtime.getRun(authority, started.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(runtime.start(authority, agent, request, command)).resolves.toEqual(started);
    const changedRequest = { ...request, goal: "Changed under the same command ID" };
    await expect(
      runtime.start(
        authority,
        agent,
        changedRequest,
        createCommandContext({
          commandId: command.commandId,
          operation: "run.start",
          payload: changedRequest,
        }),
      ),
    ).rejects.toMatchObject({ code: "KAF_HTTP_IDEMPOTENCY_CONFLICT" });
    const reconcileCommand = createCommandContext({
      commandId: createCommandId(),
      operation: "run.reconcile_effect",
      payload: { schemaVersion: "1", status: "abandoned", reason: "fixture" },
      resourceIds: [started.runId, "missing-effect"],
    });
    await expect(
      runtime.reconcileEffect(
        authority,
        started.runId,
        "missing-effect",
        { schemaVersion: "1", status: "abandoned", reason: "fixture" },
        reconcileCommand,
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    const compensationRequest = {
      schemaVersion: "1" as const,
      reason: "fixture compensation",
      budget: {
        maxTurns: 1,
        maxModelCalls: 1,
        maxToolCalls: 1,
        maxActiveExecutionMs: 1_000,
      },
    };
    await expect(
      runtime.requestCompensation(
        authority,
        started.runId,
        "missing-effect",
        compensationRequest,
        createCommandContext({
          commandId: createCommandId(),
          operation: "run.request_compensation",
          payload: compensationRequest,
          resourceIds: [started.runId, "missing-effect"],
        }),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
  });

  it("fails closed for unknown purpose, required network isolation, and invalid authority options", async () => {
    const tool = defineTool({
      id: "fixture.enforced@1",
      implementationVersion: "1.0.0",
      description: "Requires network isolation",
      input: toolInput,
      output: toolOutput,
      security: {
        riskClass: "R1",
        dataClasses: ["public"],
        reversibility: "not_applicable",
        requiredScopes: ["fixture:read"],
        egress: { mode: "none" },
        networkEnforcement: "required",
        maxCallsPerRun: 1,
        timeoutMs: 1_000,
      },
      resources: (_input, context) => [
        {
          kind: "tenant",
          value: context.tenantId,
          normalizationVersion: "pactmark.policy-normalization@1",
        },
      ],
      operation: { kind: "read", execute: () => Promise.resolve({ result: "never" }) },
    });
    const model = modelDefinition(() => ({
      type: "tool_call",
      value: {
        toolRegistrationDigest: tool.registration.toolRegistrationDigest,
        input: { query: "blocked" },
        targetDigest: digestCanonicalJson({ target: "blocked" }),
      },
    }));
    const agent = defineAgent({
      id: "blocked-agent",
      version: "0.1.0",
      description: "Blocked local agent",
      input: inputSchema,
      instructions: defineInstructions({ text: "Attempt the blocked operation." }),
      model,
      tools: { tool },
      policy: definePolicy({
        id: "blocked.policy",
        implementationVersion: "1",
        default: "deny",
        rules: [{ riskClass: "R1", decision: "allow_with_grant" }],
      }),
      output: outputSchema,
      verifiers: ["schema@1"],
    });
    const local = createLocalAuthorityIssuer();
    const authority = local.issue({
      principal: { type: "user", id: "user" },
      tenant: { id: "local" },
    });
    const runtime = createLocalRuntime({ agents: [agent], authorityIssuer: local.issuer });
    const invalidInput = {
      ...requestFor({ id: agent.id, version: agent.version }, ["fixture:read"]),
      input: { topic: "" },
    };
    await expect(
      runtime.start(
        authority,
        agent,
        invalidInput,
        createCommandContext({
          commandId: createCommandId(),
          operation: "run.start",
          payload: invalidInput,
        }),
      ),
    ).rejects.toBeDefined();
    expect(runtime.evaluateReadiness({ profile: "production" }).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requiredCapability: "network_enforced", status: "fail" }),
      ]),
    );
    const unknownPurpose = {
      ...requestFor({ id: agent.id, version: agent.version }, ["fixture:read"]),
      purpose: { code: "unknown", registryVersion: "general@1" },
    };
    await expect(
      runtime.start(
        authority,
        agent,
        unknownPurpose,
        createCommandContext({
          commandId: createCommandId(),
          operation: "run.start",
          payload: unknownPurpose,
        }),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    const valid = requestFor({ id: agent.id, version: agent.version }, ["fixture:read"]);
    const started = await runtime.start(
      authority,
      agent,
      valid,
      createCommandContext({
        commandId: createCommandId(),
        operation: "run.start",
        payload: valid,
      }),
    );
    await expect(runtime.wait(authority, started.runId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(() => createLocalAuthorityIssuer({ validityMs: 0 })).toThrow(RangeError);
    expect(() => createLocalRuntime({ agents: [], authorityIssuer: local.issuer })).toThrow(
      "At least one",
    );
    expect(() => createCommandId()).not.toThrow();
  });

  it("routes declared egress through the allowlist broker and records schema failure", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ result: "remote" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const tool = defineTool({
      id: "fixture.remote@1",
      implementationVersion: "1.0.0",
      description: "Allowlisted remote fixture",
      input: toolInput,
      output: toolOutput,
      security: {
        riskClass: "R1",
        dataClasses: ["public"],
        reversibility: "not_applicable",
        requiredScopes: ["fixture:read"],
        egress: {
          mode: "allowlist",
          destinations: ["https://fixture.invalid"],
          methods: ["GET"],
          credentialSlots: [],
        },
        networkEnforcement: "declared_ok",
        maxCallsPerRun: 1,
        timeoutMs: 1_000,
      },
      resources: (_input, context) => [
        {
          kind: "tenant",
          value: context.tenantId,
          normalizationVersion: "pactmark.policy-normalization@1",
        },
      ],
      operation: {
        kind: "read",
        async execute(_input, context) {
          const response = await context.egress.fetch("https://fixture.invalid/data");
          return toolOutput.parse(await response.json());
        },
      },
    });
    const model = modelDefinition((invocation) =>
      invocation === 1
        ? {
            type: "tool_call",
            value: {
              toolRegistrationDigest: tool.registration.toolRegistrationDigest,
              input: { query: "remote" },
              targetDigest: digestCanonicalJson({ target: "remote" }),
            },
          }
        : { type: "final", value: { title: "Only title" } },
    );
    const agent = defineAgent({
      id: "remote-agent",
      version: "0.1.0",
      description: "Remote fixture agent",
      input: inputSchema,
      instructions: defineInstructions({ text: "Use declared egress." }),
      model,
      tools: { tool },
      policy: definePolicy({
        id: "remote.policy",
        implementationVersion: "1",
        default: "deny",
        rules: [{ riskClass: "R1", decision: "allow_with_grant" }],
      }),
      output: outputSchema,
      verifiers: ["schema@1"],
    });
    const local = createLocalAuthorityIssuer({
      issuerId: "custom-local",
      validityMs: 10_000,
      now: () => new Date(),
    });
    const authority = local.issue({
      principal: { type: "user", id: "user" },
      tenant: { id: "local" },
      authenticationStrength: "multi_factor",
      decisionRoles: ["owner"],
      requestCorrelationId: "request",
    });
    const runtime = createLocalRuntime({ agents: [agent], authorityIssuer: local.issuer });
    const request = requestFor({ id: agent.id, version: agent.version }, ["fixture:read"]);
    const started = await runtime.start(
      authority,
      agent,
      request,
      createCommandContext({
        commandId: createCommandId(),
        operation: "run.start",
        payload: request,
      }),
    );
    await expect(runtime.wait(authority, started.runId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(fetch).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it.each([
    ["deny", "failed"],
    ["require_approval", "failed"],
  ] as const)(
    "applies the %s policy decision outside model authority",
    async (decision, status) => {
      const tool = defineTool({
        id: `fixture.${decision}@1`,
        implementationVersion: "1.0.0",
        description: "Policy decision fixture",
        input: toolInput,
        output: toolOutput,
        security: {
          riskClass: "R1",
          dataClasses: ["public"],
          reversibility: "not_applicable",
          requiredScopes: ["fixture:read"],
          egress: { mode: "none" },
          networkEnforcement: "declared_ok",
          maxCallsPerRun: 1,
          timeoutMs: 1_000,
        },
        resources: (_input, context) => [
          {
            kind: "tenant",
            value: context.tenantId,
            normalizationVersion: "pactmark.policy-normalization@1",
          },
        ],
        operation: { kind: "read", execute: () => Promise.resolve({ result: "unused" }) },
      });
      const agent = defineAgent({
        id: `${decision}-agent`,
        version: "0.1.0",
        description: "Policy decision agent",
        input: inputSchema,
        instructions: defineInstructions({ text: "Request the governed tool." }),
        model: modelDefinition(() => ({
          type: "tool_call",
          value: {
            toolRegistrationDigest: tool.registration.toolRegistrationDigest,
            input: { query: "governed" },
            targetDigest: digestCanonicalJson({ target: "governed" }),
          },
        })),
        tools: { tool },
        policy: definePolicy({
          id: `${decision}.policy`,
          implementationVersion: "1",
          default: "deny",
          rules: [{ riskClass: "R1", decision }],
        }),
        output: outputSchema,
        verifiers: ["schema@1"],
      });
      const local = createLocalAuthorityIssuer();
      const authority = local.issue({
        principal: { type: "user", id: "user" },
        tenant: { id: "local" },
      });
      const runtime = createLocalRuntime({ agents: [agent], authorityIssuer: local.issuer });
      const request = requestFor({ id: agent.id, version: agent.version }, ["fixture:read"]);
      const started = await runtime.start(
        authority,
        agent,
        request,
        createCommandContext({
          commandId: createCommandId(),
          operation: "run.start",
          payload: request,
        }),
      );
      await expect(runtime.wait(authority, started.runId)).resolves.toMatchObject({ status });
    },
  );
});

describe("pure readiness and command identity", () => {
  it("fails unknown requirements and passes a complete durable profile deterministically", () => {
    const evaluatedAt = "2026-08-03T12:00:00.000Z";
    const unknown = evaluateRuntimeReadiness({
      profile: "local",
      capabilities,
      requiredCapabilities: ["unknown_capability"],
      evaluatedAt,
    });
    expect(unknown.ready).toBe(false);
    const durable: RuntimeCapabilities = {
      ...capabilities,
      executionProfile: "durable",
      durableStorage: true,
      protectedContext: true,
      protectedWorkOrders: true,
      protectedInputSubmissions: true,
      sandbox: "isolated",
      networkPolicy: "enforced",
    };
    const ready = evaluateRuntimeReadiness({
      profile: "production",
      capabilities: durable,
      requiredCapabilities: ["sandbox_isolated", "network_enforced", "streaming"],
      evaluatedAt,
    });
    expect(ready.ready).toBe(true);
    expect(ready.evaluatedAt).toBe(evaluatedAt);
    const first = createCommandId();
    const second = createCommandId();
    expect(first).toMatch(/^kafcmd_\d{13}_[0-9a-f]{32}$/u);
    expect(second).not.toBe(first);
  });
});

describe("explicit production composition", () => {
  it("has no hidden local fallback and exposes every delegated kernel method", async () => {
    const durable: RuntimeCapabilities = {
      ...capabilities,
      executionProfile: "durable",
      durableStorage: true,
      protectedContext: true,
      protectedWorkOrders: true,
      protectedInputSubmissions: true,
      typedInput: true,
      sandbox: "isolated",
      networkPolicy: "enforced",
      modelCredentials: true,
      toolCredentials: true,
      transactionDomains: ["fixture"],
    };
    const issuer = createAuthorityIssuer("production-fixture");
    const transaction = {} as RunCommandTransaction;
    const unitOfWork: CreateRuntimeInput["runCommandUnitOfWork"] = {
      transactionDomain: "fixture",
      atomicCommandAndWakeup: false,
      transactCommand: () => Promise.reject(new Error("not reached")),
      transactTransition: (_key, callback) => callback(transaction),
    };
    const config: CreateRuntimeInput = {
      authorityIssuer: issuer,
      agentRegistry: {
        register: () => Promise.resolve(),
        resolve: () => Promise.resolve(undefined),
      },
      purposeRegistry: { version: "general@1", has: () => true },
      acceptedWorkOrderStore: {
        capabilities: durable,
        putImmutable: () => Promise.resolve(),
        get: () => Promise.resolve(undefined),
        delete: () => Promise.resolve(),
      },
      eventStore: {
        capabilities: durable,
        append: () => Promise.resolve({ sequence: 1, replayed: false }),
        async *read() {
          await Promise.resolve();
          yield* [];
        },
        getProjection: () => Promise.resolve(undefined),
      },
      artifactStore: {
        capabilities: durable,
        put: () => Promise.resolve(),
        get: () => Promise.resolve(undefined),
        delete: () => Promise.resolve(),
      },
      leaseStore: {
        acquire: () => Promise.resolve(undefined),
        renew: () => Promise.reject(new Error("not reached")),
        release: () => Promise.resolve(),
      },
      runCommandUnitOfWork: unitOfWork,
      admissionController: {
        evaluate: (request) =>
          Promise.resolve({
            admitted: true as const,
            reservation: {
              schemaVersion: "1" as const,
              id: "admission-fixture",
              tenant: request.tenant,
              principal: request.principal,
              ...(request.commandId === undefined ? {} : { commandId: request.commandId }),
              category: request.category,
              resourceKey: request.resourceKey,
              amount: request.amount,
              state: "reserved" as const,
              fencingToken: 1,
              reservedAtServerTime: "2026-08-03T12:00:00.000Z",
              leaseExpiresAt: "2026-08-03T12:01:00.000Z",
            },
          }),
      },
      activeExecutionServices: {
        transactionDomain: unitOfWork.transactionDomain,
        durable: true,
        reader: { get: () => Promise.resolve(undefined) },
        maximumChargeMilliseconds: () => 1_000,
      },
      modelDriver: {
        capabilities: durable,
        async *invoke() {
          await Promise.resolve();
          yield* [];
        },
      },
      toolRegistry: { resolve: () => undefined },
      toolCallResolver: {
        resolve: () => Promise.reject(new Error("not reached")),
      },
      policyEngine: {
        evaluate: () =>
          Promise.resolve({ decision: "deny", reasonCode: "KAF_POLICY_DEFAULT_DENY" }),
      },
      toolExecutor: {
        capabilities: durable,
        networkPolicy: "enforced",
        execute: () => Promise.reject(new Error("not reached")),
      },
      egressBroker: {
        capabilities: durable,
        bind: () => ({ fetch: () => Promise.reject(new Error("not reached")) }),
      },
      verifierRegistry: {
        has: () => false,
        verify: () => Promise.reject(new Error("not reached")),
      },
      evidenceBuilder: {
        build: () => Promise.reject(new Error("not reached")),
      },
      clock: { now: () => "2026-08-03T12:00:00.000Z", monotonicMilliseconds: () => 0 },
      idGenerator: { generate: (kind) => `${kind}-fixture` },
      leaseHolderId: "fixture",
      contextStore: {
        capabilities: durable,
        put: () => Promise.resolve(),
        getLatest: () => Promise.resolve(undefined),
        delete: () => Promise.resolve(),
      },
      contextProtector: {
        protect: () => Promise.reject(new Error("not reached")),
        unprotect: () => Promise.reject(new Error("not reached")),
      },
      contextCheckpointTransactionDomain: unitOfWork.transactionDomain,
      inputSubmissionStore: {
        capabilities: durable,
        putOnce: (record) => Promise.resolve(record),
        get: () => Promise.resolve(undefined),
        delete: () => Promise.resolve(),
      },
      requiredRuntimeCapabilities: ["model_credentials", "tool_credentials"],
    };
    const runtime = createRuntime(config);
    expect(runtime.getCapabilities()).toMatchObject({
      executionProfile: "durable",
      networkPolicy: "enforced",
    });
    expect(runtime.evaluateReadiness({ profile: "production" })).toMatchObject({
      ready: false,
      capabilities: { modelCredentials: false },
    });
    const productionModelServices = {
      reservations: { durable: true, transactionDomain: unitOfWork.transactionDomain },
    } as NonNullable<CreateRuntimeInput["productionModelServices"]>;
    expect(
      createRuntime({
        ...config,
        contextCheckpointTransactionDomain: "other-domain",
        productionModelServices,
      }).evaluateReadiness({ profile: "production" }),
    ).toMatchObject({ ready: false, capabilities: { protectedContext: false } });
    expect(
      createRuntime({ ...config, productionModelServices }).evaluateReadiness({
        profile: "production",
      }),
    ).toMatchObject({ ready: true, capabilities: { modelCredentials: true } });
    const invalidAuthority = {} as never;
    const command = createCommandContext({
      commandId: createCommandId(),
      operation: "run.cancel",
      payload: { runId: "missing" },
    });
    const fakeAgent = {} as never;
    const fakeRequest = {} as never;
    await expect(
      runtime.start(invalidAuthority, fakeAgent, fakeRequest, command),
    ).rejects.toBeDefined();
    await expect(runtime.getRun(invalidAuthority, "missing")).rejects.toBeDefined();
    await expect(runtime.resume(invalidAuthority, "missing", command)).rejects.toBeDefined();
    await expect(runtime.cancel(invalidAuthority, "missing", command)).rejects.toBeDefined();
    await expect(
      runtime.cancel(invalidAuthority, "missing", { reason: "fixture_cleanup" }, command),
    ).rejects.toBeDefined();
    expect(() => runtime.cancel(invalidAuthority, "missing", null, command)).toThrow(
      expect.objectContaining({ code: "KAF_SCHEMA_INVALID" }),
    );
    await expect(
      runtime.submitInput(invalidAuthority, "missing", "request", {}, command),
    ).rejects.toBeDefined();
    await expect(
      runtime.issueDecisionChallenge(invalidAuthority, "missing", "decision", command),
    ).rejects.toBeDefined();
    await expect(runtime.approve(invalidAuthority, "missing", {}, command)).rejects.toBeDefined();
    await expect(runtime.reject(invalidAuthority, "missing", {}, command)).rejects.toBeDefined();
    await expect(
      runtime.reconcileEffect(invalidAuthority, "missing", "effect", {}, command),
    ).rejects.toBeDefined();
    await expect(
      runtime.requestCompensation(invalidAuthority, "missing", "effect", {}, command),
    ).rejects.toBeDefined();
    const iterator = runtime.events(invalidAuthority, "missing")[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeDefined();
    const effectServices = {} as NonNullable<CreateRuntimeInput["effectServices"]>;
    expect(createRuntime({ ...config, effectServices }).getCapabilities()).toMatchObject({
      effectReconciliation: true,
      compensation: false,
    });
    const mismatchedCompensationServices = {
      transactionDomain: "separate-fixture",
    } as NonNullable<CreateRuntimeInput["compensationServices"]>;
    expect(
      createRuntime({
        ...config,
        effectServices,
        compensationServices: mismatchedCompensationServices,
      }).getCapabilities(),
    ).toMatchObject({ effectReconciliation: true, compensation: false });
    const compensationServices = {
      transactionDomain: unitOfWork.transactionDomain,
    } as NonNullable<CreateRuntimeInput["compensationServices"]>;
    expect(
      createRuntime({ ...config, effectServices, compensationServices }).getCapabilities(),
    ).toMatchObject({ effectReconciliation: true, compensation: true });
  });
});
