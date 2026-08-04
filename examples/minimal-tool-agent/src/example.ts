import {
  createCommandContext,
  createCommandId,
  createLocalAuthorityIssuer,
  createLocalRuntime,
  createWorkOrderRequest,
  defineAgent,
  defineInstructions,
  defineModelResourceProfile,
  defineModelSecurityProfile,
  definePolicy,
  defineSchema,
  defineTool,
  type CompiledModelDefinition,
  type RuntimeCapabilities,
} from "@pactmark/agent";
import { digestCanonicalJson } from "@pactmark/core";
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

const security = defineModelSecurityProfile({
  id: "example.catalog.model@1",
  provider: "local",
  model: "deterministic",
  endpointOrigin: "https://local.invalid",
  credentialSlot: "local.none",
  allowedTenants: ["local"],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["public"],
  processingRegion: "process-local",
  retention: "none",
  logging: "none",
  training: "none",
  contractReference: "deterministic-fixture",
});
const resources = defineModelResourceProfile({
  id: "example.catalog.resources@1",
  implementationVersion: "1.0.0",
  maxInputBytesPerCall: 32_000,
  maxInputTokensPerCall: 4_000,
  maxOutputTokensPerCall: 500,
  maxStreamedOutputBytesPerCall: 32_000,
  maxStreamEventsPerCall: 100,
  maxToolResultToContextBytes: 8_000,
  maxContextSnapshotBytes: 64_000,
  maxRunModelInputBytes: 128_000,
  maxRunModelInputTokens: 16_000,
  maxRunModelOutputBytes: 64_000,
  maxRunModelOutputTokens: 2_000,
  maxRunToolResultToContextBytes: 32_000,
  estimator: "example.exact@1",
  providerOutputCap: "enforced",
});

const input = defineSchema({
  id: "example.catalog.input",
  semanticRevision: "1",
  schema: z.object({ sku: z.string().min(1) }).strict(),
});
const toolInput = defineSchema({
  id: "example.catalog.lookup.input",
  semanticRevision: "1",
  schema: z.object({ sku: z.string().min(1) }).strict(),
});
const toolOutput = defineSchema({
  id: "example.catalog.lookup.output",
  semanticRevision: "1",
  schema: z.object({ sku: z.string(), name: z.string(), available: z.boolean() }).strict(),
});
const output = defineSchema({
  id: "example.catalog.output",
  semanticRevision: "1",
  schema: z.object({ summary: z.string(), source: z.literal("embedded-catalog") }).strict(),
});

const fixture = Object.freeze({ sku: "P-100", name: "Portable notebook", available: true });
export const lookupCatalog = defineTool({
  id: "catalog.lookup@1",
  implementationVersion: "1.0.0",
  description: "Read one item from the immutable example catalog.",
  input: toolInput,
  output: toolOutput,
  security: {
    riskClass: "R1",
    dataClasses: ["public"],
    reversibility: "not_applicable",
    requiredScopes: ["catalog:read"],
    egress: { mode: "none" },
    networkEnforcement: "declared_ok",
    maxCallsPerRun: 1,
    timeoutMs: 1_000,
  },
  operation: {
    kind: "read",
    execute: ({ sku }) => Promise.resolve({ ...fixture, available: fixture.sku === sku }),
  },
});

function model(): CompiledModelDefinition {
  let turn = 0;
  return {
    modelSecurityProfileDigest: security.modelSecurityProfileDigest,
    modelResourceProfileDigest: resources.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: digestCanonicalJson({ adapter: "example.catalog@1" }),
    modelConfig: { kind: "deterministic" },
    credentialMode: "ambient_preview",
    driver: {
      capabilities,
      async *invoke() {
        await Promise.resolve();
        turn += 1;
        yield turn === 1
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: lookupCatalog.registration.toolRegistrationDigest,
                input: { sku: "P-100" },
                targetDigest: digestCanonicalJson({ source: "embedded-catalog", sku: "P-100" }),
              },
            }
          : {
              type: "final",
              value: { summary: "Portable notebook is available.", source: "embedded-catalog" },
            };
      },
    },
  };
}

export const catalogAgent = defineAgent({
  id: "minimal-catalog-agent",
  version: "0.1.0",
  description: "Reads one bounded deterministic catalog fixture.",
  input,
  instructions: defineInstructions({
    text: "Read the catalog fixture and report its bounded result.",
  }),
  model: model(),
  tools: { lookupCatalog },
  policy: definePolicy({
    id: "minimal-catalog.policy",
    implementationVersion: "1.0.0",
    default: "deny",
    rules: [{ riskClass: "R1", decision: "allow_with_grant" }],
  }),
  output,
  verifiers: ["schema@1"],
});

export async function runMinimalToolExample() {
  const local = createLocalAuthorityIssuer();
  const authority = local.issue({
    principal: { type: "user", id: "example-user" },
    tenant: { id: "local" },
  });
  const runtime = createLocalRuntime({ agents: [catalogAgent], authorityIssuer: local.issuer });
  const request = createWorkOrderRequest({
    agent: { id: catalogAgent.id, version: catalogAgent.version },
    goal: "Check the bounded catalog fixture.",
    input: { sku: "P-100" },
    context: { roleFamily: "operations", workflowId: "catalog-check", riskClass: "low" },
    workMode: "assist",
    autonomyMode: "assist",
    decisionOwner: { mode: "requesting_principal" },
    purpose: { code: "service_delivery", registryVersion: "general@1" },
    dataClass: "public",
    retention: { mode: "session" },
    requestedCapabilities: ["catalog:read"],
    budget: { maxTurns: 4, maxModelCalls: 4, maxToolCalls: 1, maxActiveExecutionMs: 10_000 },
  });
  const command = createCommandContext({
    commandId: createCommandId(),
    operation: "run.start",
    payload: request,
  });
  const { runId } = await runtime.start(authority, catalogAgent, request, command);
  const events = [];
  for await (const event of runtime.events(authority, runId)) events.push(event);
  const projection = await runtime.wait(authority, runId);
  return Object.freeze({
    runId,
    projection,
    events,
    artifacts: await runtime.getArtifacts(authority, runId),
    evidence: await runtime.getEvidence(authority, runId),
    productionReadiness: runtime.evaluateReadiness({ profile: "production" }),
  });
}
