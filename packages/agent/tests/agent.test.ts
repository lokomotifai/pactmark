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
  KafError,
  type JsonValue,
  type RunCommandTransaction,
  type ToolExecutionContext,
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

  it("fails closed when one digest aliases distinct executable definitions", () => {
    const policy = definePolicy({
      id: "alias.policy",
      implementationVersion: "1.0.0",
      default: "deny",
      rules: [{ riskClass: "R1", decision: "allow_with_grant" }],
    });
    const firstModel = modelDefinition(() => ({
      type: "final",
      value: { title: "first", body: "first" },
    }));
    const secondModel = modelDefinition(() => ({
      type: "final",
      value: { title: "second", body: "second" },
    }));
    const firstAgent = defineAgent({
      id: "aliased-agent",
      version: "0.1.0",
      input: inputSchema,
      instructions: "Run.",
      model: firstModel,
      policy,
      output: outputSchema,
    });
    const secondAgent = defineAgent({
      id: "aliased-agent",
      version: "0.1.0",
      input: inputSchema,
      instructions: "Run.",
      model: secondModel,
      policy,
      output: outputSchema,
    });
    expect(firstAgent.agentDefinitionDigest).toBe(secondAgent.agentDefinitionDigest);
    expect(() => createLocalRuntime({ agents: [firstAgent, secondAgent] })).toThrow(
      "KAF_REGISTRATION_SAME_VERSION_DRIFT",
    );

    const defineAliasedTool = (result: string) =>
      defineTool({
        id: "aliased.tool@1",
        implementationVersion: "1.0.0",
        description: "Digest-alias fixture.",
        input: toolInput,
        output: toolOutput,
        security: { requiredScopes: ["alias:read"] },
        operation: {
          kind: "read",
          execute: () => Promise.resolve({ result }),
        },
      });
    const firstTool = defineAliasedTool("first");
    const secondTool = defineAliasedTool("second");
    expect(firstTool.registration.toolRegistrationDigest).toBe(
      secondTool.registration.toolRegistrationDigest,
    );
    const model = modelDefinition(() => ({ type: "final", value: { title: "t", body: "b" } }));
    const toolAgent = (id: string, tool: ReturnType<typeof defineAliasedTool>) =>
      defineAgent({
        id,
        version: "0.1.0",
        input: inputSchema,
        instructions: "Run.",
        model,
        tools: { tool },
        policy,
        output: outputSchema,
      });
    expect(() =>
      createLocalRuntime({
        agents: [
          toolAgent("first-tool-agent", firstTool),
          toolAgent("second-tool-agent", secondTool),
        ],
      }),
    ).toThrow("KAF_REGISTRATION_SAME_VERSION_DRIFT");
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

  it("retains a background infrastructure failure until wait observes it", async () => {
    const agent = defineAgent({
      id: "wait-failure-agent",
      version: "0.1.0",
      description: "Local wait failure fixture",
      input: inputSchema,
      instructions: defineInstructions({ text: "Fail at the configured host boundary." }),
      model: modelDefinition(() => {
        throw new KafError("KAF_RUNTIME_NOT_READY", {
          details: { reason: "fixture_runtime_unavailable" },
        });
      }),
      output: outputSchema,
    });
    const local = createLocalAuthorityIssuer();
    const authority = local.issue({
      principal: { type: "user", id: "local-user" },
      tenant: { id: "local" },
    });
    const runtime = createLocalRuntime({ agents: [agent], authorityIssuer: local.issuer });
    const request = requestFor({ id: agent.id, version: agent.version });
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
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    await expect(runtime.wait(authority, started.runId)).rejects.toMatchObject({
      code: "KAF_RUNTIME_NOT_READY",
    });
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
    ["require_approval", "waiting_for_approval"],
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
    const productionAgent = defineAgent({
      id: "production-fixture-agent",
      version: "1.0.0",
      input: inputSchema,
      instructions: defineInstructions({ text: "Produce a bounded production result." }),
      model: modelDefinition(
        () => ({ type: "final", value: { title: "Result", body: "bounded" } }),
        "host_bound",
      ),
      output: outputSchema,
    });
    const transaction = {} as RunCommandTransaction;
    const transactCommand = vi.fn(() => Promise.reject(new Error("production kernel reached")));
    const unitOfWork: CreateRuntimeInput["runCommandUnitOfWork"] = {
      transactionDomain: "fixture",
      atomicCommandAndWakeup: false,
      transactCommand,
      transactTransition: (_key, callback) => callback(transaction),
    };
    const config: CreateRuntimeInput = {
      authorityIssuer: issuer,
      agentRegistry: {
        register: () => Promise.resolve(),
        resolve: (id, version, digest) =>
          Promise.resolve(
            id === productionAgent.id &&
              version === productionAgent.version &&
              digest === productionAgent.agentDefinitionDigest
              ? productionAgent
              : undefined,
          ),
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
      toolCredentials: false,
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
    ).toMatchObject({
      ready: false,
      capabilities: { modelCredentials: true, toolCredentials: false },
    });
    expect(
      createRuntime({
        ...config,
        productionModelServices,
        requiredRuntimeCapabilities: ["model_credentials"],
      }).evaluateReadiness({ profile: "production" }),
    ).toMatchObject({ ready: true, capabilities: { modelCredentials: true } });

    const validAuthority = issuer.issue({
      actor: { type: "user", id: "production-user" },
      tenant: { id: "local" },
      authenticatedAt: "2026-08-03T12:00:00.000Z",
      authenticationStrength: "multi_factor",
      decisionRoles: ["owner"],
      requestCorrelationId: "production-request",
      issuedAt: "2026-08-03T11:00:00.000Z",
      expiresAt: "2026-08-03T13:00:00.000Z",
    });
    const validRequest = requestFor({ id: productionAgent.id, version: productionAgent.version });
    const invalidRequest = { ...validRequest, input: { topic: "" } };
    await expect(
      runtime.start(
        validAuthority,
        productionAgent,
        invalidRequest,
        createCommandContext({
          commandId: "kafcmd_1785758400000_11111111111111111111111111111111",
          operation: "run.start",
          payload: invalidRequest,
        }),
      ),
    ).rejects.toMatchObject({ code: "KAF_SCHEMA_INVALID" });
    expect(transactCommand).not.toHaveBeenCalled();

    await expect(
      runtime.start(
        validAuthority,
        productionAgent,
        validRequest,
        createCommandContext({
          commandId: "kafcmd_1785758400000_12121212121212121212121212121212",
          operation: "run.start",
          payload: validRequest,
        }),
      ),
    ).rejects.toThrow("production kernel reached");
    expect(transactCommand).toHaveBeenCalledOnce();

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

describe("facade defaults", () => {
  const explicitSecurity = {
    riskClass: "R1" as const,
    dataClasses: ["public" as const],
    reversibility: "not_applicable" as const,
    requiredScopes: ["catalog:read"],
    egress: { mode: "none" as const },
    networkEnforcement: "declared_ok" as const,
    maxCallsPerRun: 3,
    timeoutMs: 10_000,
  };
  const rawToolInput = z.object({ query: z.string() }).strict();
  const rawToolOutput = z.object({ result: z.string() }).strict();

  function sugarTool() {
    return defineTool({
      id: "catalog.lookup@1",
      description: "Read one catalog item.",
      input: rawToolInput,
      output: rawToolOutput,
      security: { requiredScopes: ["catalog:read"] },
      operation: {
        kind: "read",
        execute: ({ query }) => Promise.resolve({ result: query }),
      },
    });
  }

  function explicitTool() {
    return defineTool({
      id: "catalog.lookup@1",
      implementationVersion: "1.0.0",
      description: "Read one catalog item.",
      input: defineSchema({
        id: "catalog.lookup@1.input",
        semanticRevision: "1",
        schema: rawToolInput,
      }),
      output: defineSchema({
        id: "catalog.lookup@1.output",
        semanticRevision: "1",
        schema: rawToolOutput,
      }),
      security: explicitSecurity,
      resources: (_value, context) => [
        {
          kind: "tenant",
          value: context.tenantId,
          normalizationVersion: "pactmark.policy-normalization@1",
        },
      ],
      operation: {
        kind: "read",
        execute: ({ query }) => Promise.resolve({ result: query }),
      },
    });
  }

  it("compiles defaulted tools and agents to byte-identical registration digests", () => {
    const sugared = sugarTool();
    const explicit = explicitTool();
    expect(sugared.registration.toolRegistrationDigest).toBe(
      explicit.registration.toolRegistrationDigest,
    );
    expect(sugared.registration).toEqual(explicit.registration);

    const rawAgentInput = z.object({ topic: z.string().min(1) }).strict();
    const rawAgentOutput = z.object({ title: z.string(), body: z.string() }).strict();
    const model = modelDefinition(() => ({ type: "final", value: { title: "t", body: "b" } }));
    const sugaredAgent = defineAgent({
      id: "defaults-agent",
      version: "0.1.0",
      input: rawAgentInput,
      instructions: "Answer with a bounded brief.",
      model,
      tools: { lookup: sugared },
      output: rawAgentOutput,
    });
    const explicitAgent = defineAgent({
      id: "defaults-agent",
      version: "0.1.0",
      description: "defaults-agent",
      input: defineSchema({
        id: "defaults-agent.input",
        semanticRevision: "1",
        schema: rawAgentInput,
      }),
      instructions: defineInstructions({ text: "Answer with a bounded brief." }),
      model,
      tools: { lookup: explicit },
      policy: definePolicy({
        id: "defaults-agent.default-policy",
        implementationVersion: "1.0.0",
        default: "deny",
        rules: [
          { riskClass: "R0", decision: "allow_with_grant" },
          { riskClass: "R1", decision: "allow_with_grant" },
        ],
      }),
      output: defineSchema({
        id: "defaults-agent.output",
        semanticRevision: "1",
        schema: rawAgentOutput,
      }),
      verifiers: ["schema@1"],
    });
    expect(sugaredAgent.agentDefinitionDigest).toBe(explicitAgent.agentDefinitionDigest);
  });

  it("refuses an R2+ tool under the default policy at composition time", () => {
    const writeShaped = defineTool({
      id: "records.update@1",
      description: "Shaped like a consequential tool.",
      input: rawToolInput,
      output: rawToolOutput,
      security: { requiredScopes: ["records:write"], riskClass: "R2" },
      operation: {
        kind: "read",
        execute: ({ query }) => Promise.resolve({ result: query }),
      },
    });
    expect(() =>
      defineAgent({
        id: "ungoverned-agent",
        version: "0.1.0",
        input: rawToolInput,
        instructions: "Try to compose without a policy.",
        model: modelDefinition(() => ({ type: "final", value: { result: "x" } })),
        tools: { writeShaped },
        output: rawToolOutput,
      }),
    ).toThrow(/default agent policy grants only R0\/R1/u);
  });

  it("runs an agent end to end through run() with derived capabilities", async () => {
    const lookup = sugarTool();
    const agent = defineAgent({
      id: "run-helper-agent",
      version: "0.1.0",
      input: z.object({ topic: z.string().min(1) }).strict(),
      instructions: "Use the catalog, then summarize.",
      model: modelDefinition((invocation) =>
        invocation === 1
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: lookup.registration.toolRegistrationDigest,
                input: { query: "Pactmark" },
                targetDigest: digestCanonicalJson({ query: "Pactmark" }),
              },
            }
          : { type: "final", value: { title: "Result", body: "Pactmark" } },
      ),
      tools: { lookup },
      output: z.object({ title: z.string(), body: z.string() }).strict(),
    });
    const runtime = createLocalRuntime({ agents: [agent] });
    const result = await runtime.run(agent, { input: { topic: "Pactmark" } });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ title: "Result", body: "Pactmark" });
    expect(result.events.map((event) => event.eventType)).toContain("ToolCallCompleted");
    expect(result.evidence).toBeDefined();
    expect(result.artifacts).toHaveLength(1);
  });

  it("fails closed in run() when the budget is exhausted", async () => {
    const lookup = sugarTool();
    const agent = defineAgent({
      id: "run-budget-agent",
      version: "0.1.0",
      input: z.object({ topic: z.string().min(1) }).strict(),
      instructions: "Use the catalog, then summarize.",
      model: modelDefinition((invocation) =>
        invocation === 1
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: lookup.registration.toolRegistrationDigest,
                input: { query: "Pactmark" },
                targetDigest: digestCanonicalJson({ query: "Pactmark" }),
              },
            }
          : { type: "final", value: { title: "Result", body: "Pactmark" } },
      ),
      tools: { lookup },
      output: z.object({ title: z.string(), body: z.string() }).strict(),
    });
    const runtime = createLocalRuntime({ agents: [agent] });
    const result = await runtime.run(agent, {
      input: { topic: "Pactmark" },
      budget: { maxTurns: 4, maxModelCalls: 1, maxToolCalls: 4, maxActiveExecutionMs: 30_000 },
    });
    expect(result.status).toBe("failed");
    expect(result.output).toBeUndefined();
  });

  it("requires explicit authority in run() when an external issuer is supplied", async () => {
    const external = createLocalAuthorityIssuer();
    const agent = defineAgent({
      id: "external-issuer-agent",
      version: "0.1.0",
      input: z.object({ topic: z.string().min(1) }).strict(),
      instructions: "Answer directly.",
      model: modelDefinition(() => ({ type: "final", value: { title: "t", body: "b" } })),
      output: z.object({ title: z.string(), body: z.string() }).strict(),
    });
    const runtime = createLocalRuntime({ agents: [agent], authorityIssuer: external.issuer });
    await expect(runtime.run(agent, { input: { topic: "Pactmark" } })).rejects.toThrow(
      /requires options\.authority/u,
    );
    const authority = external.issue({
      principal: { type: "user", id: "external-user" },
      tenant: { id: "local" },
    });
    const result = await runtime.run(agent, { input: { topic: "Pactmark" }, authority });
    expect(result.status).toBe("completed");
  });
});

describe("facade write tools", () => {
  const writeInput = z.object({ key: z.string().min(1), value: z.string().min(1) }).strict();
  const writeOutput = z.object({ key: z.string(), stored: z.boolean() }).strict();

  function writeTool(
    store: Map<string, string>,
    observedRuns?: Array<ToolExecutionContext["run"]>,
    egressOrigin?: string,
  ) {
    return defineTool({
      id: "records.update@1",
      description: "Persist one bounded record.",
      input: writeInput,
      output: writeOutput,
      security: {
        requiredScopes: ["records:write"],
        riskClass: "R2",
        ...(egressOrigin === undefined
          ? {}
          : {
              egress: {
                mode: "allowlist" as const,
                destinations: [egressOrigin],
                methods: ["POST"],
                credentialSlots: [],
              },
              networkEnforcement: "declared_ok" as const,
            }),
      },
      operation: {
        kind: "write",
        reversibility: "irreversible",
        materialConsequence: "Writes one record into the in-memory fixture store.",
        async execute({ key, value }, context) {
          if (egressOrigin !== undefined) {
            await context.egress.fetch(`${egressOrigin}/records`, { method: "POST" });
          }
          observedRuns?.push(context.run);
          store.set(key, value);
          return { key, stored: true };
        },
      },
    });
  }

  function writeAgent(
    store: Map<string, string>,
    id: string,
    observedRuns?: Array<ToolExecutionContext["run"]>,
    egressOrigin?: string,
  ) {
    const update = writeTool(store, observedRuns, egressOrigin);
    return defineAgent({
      id,
      version: "0.1.0",
      input: z.object({ key: z.string().min(1) }).strict(),
      instructions: "Persist the record, then summarize.",
      model: modelDefinition((invocation) =>
        invocation === 1
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: update.registration.toolRegistrationDigest,
                input: { key: "alpha", value: "one" },
                targetDigest: digestCanonicalJson({ key: "alpha", value: "one" }),
              },
            }
          : { type: "final", value: { title: "Stored", body: "alpha" } },
      ),
      tools: { update },
      policy: definePolicy({
        id: `${id}.policy`,
        implementationVersion: "1.0.0",
        default: "deny",
        rules: [{ riskClass: "R2", decision: "allow_with_grant" }],
      }),
      output: z.object({ title: z.string(), body: z.string() }).strict(),
    });
  }

  it("rejects unsound write declarations at composition time", () => {
    const operation = {
      kind: "write" as const,
      reversibility: "irreversible" as const,
      execute: ({ key }: { key: string; value: string }) => Promise.resolve({ key, stored: true }),
    };
    expect(() =>
      defineTool({
        id: "records.update@1",
        description: "Missing risk class.",
        input: writeInput,
        output: writeOutput,
        security: { requiredScopes: ["records:write"] },
        operation,
      }),
    ).toThrow(/must declare its risk class/u);
    expect(() =>
      defineTool({
        id: "records.update@1",
        description: "Above the facade ceiling.",
        input: writeInput,
        output: writeOutput,
        security: { requiredScopes: ["records:write"], riskClass: "R3" },
        operation,
      }),
    ).toThrow(/R3 compensation/u);
    expect(() =>
      defineTool({
        id: "records.update@1",
        description: "Contradictory reversibility.",
        input: writeInput,
        output: writeOutput,
        security: {
          requiredScopes: ["records:write"],
          riskClass: "R2",
          reversibility: "compensatable",
        },
        operation,
      }),
    ).toThrow(/must match operation.reversibility/u);
  });

  it("dispatches an R2 write through the governed effect path", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetch);
    const store = new Map<string, string>();
    const observedRuns: Array<ToolExecutionContext["run"]> = [];
    const agent = writeAgent(store, "write-agent", observedRuns, "https://fixture.invalid");
    const runtime = createLocalRuntime({ agents: [agent] });
    expect(runtime.getCapabilities().effectReconciliation).toBe(true);
    const result = await runtime.run(agent, {
      input: { key: "alpha" },
      tenantId: "tenant-write-test",
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ title: "Stored", body: "alpha" });
    expect(store.get("alpha")).toBe("one");
    expect(observedRuns).toEqual([
      expect.objectContaining({
        tenantId: "tenant-write-test",
        runId: result.runId,
        purposeCode: "service_delivery",
        dataClass: "public",
      }),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    const eventTypes = result.events.map((event) => event.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "EffectPrepared",
        "EffectDispatched",
        "EffectAcknowledged",
        "ToolCallCompleted",
        "RunCompleted",
      ]),
    );
    expect(result.evidence).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("issues, approves, atomically claims, and resumes one R4 local write", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetch);
    const writes: string[] = [];
    let siblingEgressDenied = false;
    const purchase = defineTool({
      id: "purchase.submit@1",
      description: "Submit one exact fixture purchase.",
      input: writeInput,
      output: writeOutput,
      security: {
        requiredScopes: ["purchase:submit"],
        riskClass: "R4",
        egress: {
          mode: "allowlist",
          destinations: ["https://purchase-a.invalid"],
          methods: ["POST"],
          credentialSlots: [],
        },
      },
      operation: {
        kind: "write",
        reversibility: "irreversible",
        materialConsequence: "Charges one fixture purchase amount.",
        approvalPreview: ({ key, value }) => ({
          title: "Approve fixture purchase",
          summary: `Submit ${key} for ${value}.`,
          fields: [
            { label: "Order", value: key },
            { label: "Amount", value },
          ],
        }),
        async execute({ key, value }, context) {
          try {
            await context.egress.fetch("https://sibling-b.invalid/borrowed", { method: "GET" });
          } catch (error) {
            if (!(error instanceof TypeError) || error.message !== "KAF_EGRESS_DENIED") throw error;
            siblingEgressDenied = true;
          }
          await context.egress.fetch("https://purchase-a.invalid/submit", { method: "POST" });
          writes.push(`${key}:${value}`);
          return { key, stored: true };
        },
      },
    });
    const siblingLookup = defineTool({
      id: "sibling.lookup@1",
      description: "Sibling with an unrelated read-only egress declaration.",
      input: z.object({ key: z.string() }).strict(),
      output: z.object({ found: z.boolean() }).strict(),
      security: {
        requiredScopes: ["sibling:read"],
        riskClass: "R1",
        egress: {
          mode: "allowlist",
          destinations: ["https://sibling-b.invalid"],
          methods: ["GET"],
          credentialSlots: [],
        },
      },
      operation: { kind: "read", execute: () => Promise.resolve({ found: false }) },
    });
    const agent = defineAgent({
      id: "approval-write-agent",
      version: "0.1.0",
      input: z.object({ key: z.string().min(1) }).strict(),
      instructions: "Request approval, submit the purchase, then summarize.",
      model: modelDefinition((invocation) =>
        invocation === 1
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: purchase.registration.toolRegistrationDigest,
                input: { key: "order-1", value: "2500-USD" },
                targetDigest: digestCanonicalJson({ ignored: "model target is not authority" }),
              },
            }
          : { type: "final", value: { title: "Approved", body: "order-1" } },
      ),
      tools: { purchase, siblingLookup },
      policy: definePolicy({
        id: "approval-write-agent.policy",
        implementationVersion: "1.0.0",
        default: "deny",
        rules: [{ riskClass: "R4", decision: "require_approval" }],
      }),
      output: z.object({ title: z.string(), body: z.string() }).strict(),
    });
    const local = createLocalAuthorityIssuer();
    const authority = local.issue({
      principal: { type: "user", id: "approver-1" },
      tenant: { id: "local" },
      authenticationStrength: "phishing_resistant",
    });
    const runtime = createLocalRuntime({ agents: [agent], authorityIssuer: local.issuer });
    expect(runtime.getCapabilities().humanDecisions).toBe(true);
    expect(
      runtime
        .evaluateReadiness({ profile: "preview" })
        .checks.find((check) => check.requiredCapability === "human_decisions"),
    ).toMatchObject({ status: "pass" });
    const request = createWorkOrderRequest({
      agent: { id: agent.id, version: agent.version },
      goal: "Submit one approved fixture purchase",
      input: { key: "order-1" },
      context: { roleFamily: "purchasing", workflowId: "fixture", riskClass: "high" },
      workMode: "assist",
      autonomyMode: "assist",
      decisionOwner: { mode: "requesting_principal" },
      purpose: { code: "service_delivery", registryVersion: "general@1" },
      dataClass: "public",
      retention: { mode: "session" },
      requestedCapabilities: ["purchase:submit"],
      resourceScopeCeiling: [
        { kind: "tenant", value: "local", normalizationVersion: "pactmark.policy-normalization@1" },
      ],
      budget: {
        maxTurns: 4,
        maxModelCalls: 4,
        maxToolCalls: 2,
        maxActiveExecutionMs: 30_000,
      },
    });
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
      status: "waiting_for_approval",
    });
    expect(writes).toEqual([]);
    const waiting = await runtime.getRun(authority, started.runId);
    const decisionId = waiting.waitingDecisionId;
    if (decisionId === null) throw new Error("decision id missing");
    const decisionScopes = [
      { kind: "run" as const, value: started.runId, normalizationVersion: "pactmark.command@1" },
      { kind: "opaque" as const, value: decisionId, normalizationVersion: "pactmark.command@1" },
    ];
    const challenge = await runtime.issueDecisionChallenge(
      authority,
      started.runId,
      decisionId,
      createCommandContext({
        commandId: createCommandId(),
        operation: "run.issue_decision_challenge",
        payload: {},
        normalizedResourceScope: decisionScopes,
      }),
    );
    const submission = {
      decision: "approve" as const,
      decisionId,
      challengeProof: challenge.challengeProof,
    };
    const approved = await runtime.approve(
      authority,
      started.runId,
      submission,
      createCommandContext({
        commandId: createCommandId(),
        operation: "run.approve",
        payload: submission,
        normalizedResourceScope: decisionScopes,
      }),
    );
    expect(approved.automaticResume).toBe(false);
    const resumed = await runtime.resume(
      authority,
      started.runId,
      createCommandContext({
        commandId: createCommandId(),
        operation: "run.resume",
        payload: { runId: started.runId },
      }),
    );
    expect(resumed).toMatchObject({ status: "completed" });
    expect(writes).toEqual(["order-1:2500-USD"]);
    expect(siblingEgressDenied).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const dispatchedRequest = fetch.mock.calls[0]?.[0];
    expect(dispatchedRequest).toBeInstanceOf(Request);
    expect((dispatchedRequest as Request).url).toBe("https://purchase-a.invalid/submit");
    expect((dispatchedRequest as Request).method).toBe("POST");
    const events = [];
    for await (const event of runtime.events(authority, started.runId)) events.push(event);
    expect(events.find((event) => event.eventType === "ApprovalRequested")?.payload).toMatchObject({
      approvalDisplay: {
        title: "Approve fixture purchase",
        summary: "Submit order-1 for 2500-USD.",
        materialConsequence: "Charges one fixture purchase amount.",
        reversibility: "irreversible",
        fields: [
          { label: "Order", value: "order-1" },
          { label: "Amount", value: "2500-USD" },
        ],
      },
    });
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "ApprovalRequested",
        "ApprovalRecorded",
        "EffectPrepared",
        "EffectAcknowledged",
        "RunCompleted",
      ]),
    );
    expect(
      JSON.stringify(events).includes(challenge.challengeProof),
      "raw challenge proof must remain process-local",
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it("keeps effect reconciliation off when no write tool is composed", () => {
    const readOnly = defineAgent({
      id: "read-only-agent",
      version: "0.1.0",
      input: z.object({ topic: z.string().min(1) }).strict(),
      instructions: "Answer directly.",
      model: modelDefinition(() => ({ type: "final", value: { title: "t", body: "b" } })),
      output: z.object({ title: z.string(), body: z.string() }).strict(),
    });
    const runtime = createLocalRuntime({ agents: [readOnly] });
    expect(runtime.getCapabilities().effectReconciliation).toBe(false);
  });

  it("denies a write proposal whose risk class has no policy rule", async () => {
    const store = new Map<string, string>();
    const update = writeTool(store);
    const agent = defineAgent({
      id: "write-denied-agent",
      version: "0.1.0",
      input: z.object({ key: z.string().min(1) }).strict(),
      instructions: "Persist the record, then summarize.",
      model: modelDefinition(() => ({
        type: "tool_call",
        value: {
          toolRegistrationDigest: update.registration.toolRegistrationDigest,
          input: { key: "alpha", value: "one" },
          targetDigest: digestCanonicalJson({ key: "alpha", value: "one" }),
        },
      })),
      tools: { update },
      policy: definePolicy({
        id: "write-denied-agent.policy",
        implementationVersion: "1.0.0",
        default: "deny",
        rules: [{ riskClass: "R1", decision: "allow_with_grant" }],
      }),
      output: z.object({ title: z.string(), body: z.string() }).strict(),
    });
    const runtime = createLocalRuntime({ agents: [agent] });
    const result = await runtime.run(agent, { input: { key: "alpha" } });
    expect(result.status).toBe("failed");
    expect(store.size).toBe(0);
  });

  it("treats a repeated model proposal as a distinct governed effect", async () => {
    const store = new Map<string, string>();
    let writes = 0;
    const update = defineTool({
      id: "records.update@1",
      description: "Persist one bounded record.",
      input: writeInput,
      output: writeOutput,
      security: { requiredScopes: ["records:write"], riskClass: "R2", maxCallsPerRun: 2 },
      operation: {
        kind: "write",
        reversibility: "irreversible",
        execute: ({ key, value }) => {
          writes += 1;
          store.set(key, value);
          return Promise.resolve({ key, stored: true });
        },
      },
    });
    // The model proposes the same arguments twice, but each proposal has a new
    // tool-call/step identity and is therefore a distinct governed effect.
    // Replay protection applies when the exact same effect resumes after a
    // crash, not when the model requests a second write intentionally.
    const agent = defineAgent({
      id: "write-replay-agent",
      version: "0.1.0",
      input: z.object({ key: z.string().min(1) }).strict(),
      instructions: "Persist the record, then summarize.",
      model: modelDefinition((invocation) =>
        invocation <= 2
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: update.registration.toolRegistrationDigest,
                input: { key: "alpha", value: "one" },
                targetDigest: digestCanonicalJson({ key: "alpha", value: "one" }),
              },
            }
          : { type: "final", value: { title: "Stored", body: "alpha" } },
      ),
      tools: { update },
      policy: definePolicy({
        id: "write-replay-agent.policy",
        implementationVersion: "1.0.0",
        default: "deny",
        rules: [{ riskClass: "R2", decision: "allow_with_grant" }],
      }),
      output: z.object({ title: z.string(), body: z.string() }).strict(),
    });
    const runtime = createLocalRuntime({ agents: [agent] });
    const result = await runtime.run(agent, { input: { key: "alpha" } });
    expect(result.status).toBe("completed");
    expect(writes).toBe(2);
    expect(store.get("alpha")).toBe("one");
  });
});
