import process from "node:process";

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
} from "@pactmark/agent";
import { digestCanonicalJson } from "@pactmark/core";
import { z } from "zod";

const capabilities = {
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
  id: "packed-benchmark.model@1",
  provider: "local",
  model: "deterministic",
  endpointOrigin: "https://local.invalid",
  credentialSlot: "local.none",
  allowedTenants: ["packed-benchmark"],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["public"],
  processingRegion: "process-local",
  retention: "none",
  logging: "none",
  training: "none",
  contractReference: "packed-local-benchmark",
});
const resources = defineModelResourceProfile({
  id: "packed-benchmark.resources@1",
  implementationVersion: "1.0.0",
  maxInputBytesPerCall: 8_000,
  maxInputTokensPerCall: 1_000,
  maxOutputTokensPerCall: 128,
  maxStreamedOutputBytesPerCall: 8_000,
  maxStreamEventsPerCall: 20,
  maxToolResultToContextBytes: 1_000,
  maxContextSnapshotBytes: 16_000,
  maxRunModelInputBytes: 32_000,
  maxRunModelInputTokens: 4_000,
  maxRunModelOutputBytes: 16_000,
  maxRunModelOutputTokens: 512,
  maxRunToolResultToContextBytes: 4_000,
  estimator: "packed-benchmark.exact@1",
  providerOutputCap: "enforced",
});
const input = defineSchema({
  id: "packed-benchmark.input",
  semanticRevision: "1",
  schema: z.object({ prompt: z.string() }).strict(),
});
const output = defineSchema({
  id: "packed-benchmark.output",
  semanticRevision: "1",
  schema: z.object({ result: z.literal("packed mock completed") }).strict(),
});
const agent = defineAgent({
  id: "packed-benchmark-agent",
  version: "0.1.0",
  description: "Packed deterministic benchmark agent.",
  input,
  instructions: defineInstructions({ text: "Return the deterministic result." }),
  model: {
    modelSecurityProfileDigest: security.modelSecurityProfileDigest,
    modelResourceProfileDigest: resources.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: digestCanonicalJson({ adapter: "packed-benchmark@1" }),
    modelConfig: { kind: "deterministic" },
    credentialMode: "ambient_preview",
    driver: {
      capabilities,
      async *invoke() {
        await Promise.resolve();
        yield { type: "final", value: { result: "packed mock completed" } };
      },
    },
  },
  policy: definePolicy({
    id: "packed-benchmark.policy",
    implementationVersion: "1.0.0",
    default: "deny",
    rules: [],
  }),
  output,
  verifiers: ["schema@1"],
});
const local = createLocalAuthorityIssuer();
const authority = local.issue({
  principal: { type: "user", id: "benchmark-user" },
  tenant: { id: "packed-benchmark" },
});
const runtime = createLocalRuntime({ agents: [agent], authorityIssuer: local.issuer });
const request = createWorkOrderRequest({
  agent: { id: agent.id, version: agent.version },
  goal: "Complete the packed mock run.",
  input: { prompt: "benchmark" },
  context: { roleFamily: "benchmark", workflowId: "packed-local", riskClass: "low" },
  workMode: "assist",
  autonomyMode: "assist",
  decisionOwner: { mode: "requesting_principal" },
  purpose: { code: "service_delivery", registryVersion: "general@1" },
  dataClass: "public",
  retention: { mode: "session" },
  requestedCapabilities: [],
  budget: { maxTurns: 2, maxModelCalls: 2, maxToolCalls: 1, maxActiveExecutionMs: 5_000 },
});
const command = createCommandContext({
  commandId: createCommandId(),
  operation: "run.start",
  payload: request,
});
const { runId } = await runtime.start(authority, agent, request, command);
const projection = await runtime.wait(authority, runId);
process.stdout.write(
  `${JSON.stringify({ status: projection.status, profile: runtime.getCapabilities().executionProfile })}\n`,
);
