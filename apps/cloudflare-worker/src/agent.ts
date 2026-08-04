import {
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
import { digestCanonicalJson, type ModelDriver } from "@pactmark/core";
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
  sandbox: "none",
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
  id: "cloudflare-worker.model@1",
  provider: "local",
  model: "deterministic",
  endpointOrigin: "https://local.invalid",
  credentialSlot: "local.none",
  allowedTenants: ["cloudflare-preview"],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["public"],
  processingRegion: "isolate-local",
  retention: "none",
  logging: "none",
  training: "none",
  contractReference: "deterministic-cloudflare-fixture",
});
const resources = defineModelResourceProfile({
  id: "cloudflare-worker.resources@1",
  implementationVersion: "1.0.0",
  maxInputBytesPerCall: 16_000,
  maxInputTokensPerCall: 2_000,
  maxOutputTokensPerCall: 256,
  maxStreamedOutputBytesPerCall: 16_000,
  maxStreamEventsPerCall: 50,
  maxToolResultToContextBytes: 4_000,
  maxContextSnapshotBytes: 32_000,
  maxRunModelInputBytes: 64_000,
  maxRunModelInputTokens: 8_000,
  maxRunModelOutputBytes: 32_000,
  maxRunModelOutputTokens: 1_024,
  maxRunToolResultToContextBytes: 16_000,
  estimator: "cloudflare-worker.exact@1",
  providerOutputCap: "enforced",
});
const input = defineSchema({
  id: "cloudflare-worker.input",
  semanticRevision: "1",
  schema: z.object({ item: z.string().min(1).max(80) }).strict(),
});
const toolInput = defineSchema({
  id: "cloudflare-worker.lookup.input",
  semanticRevision: "1",
  schema: z.object({ item: z.string().min(1).max(80) }).strict(),
});
const toolOutput = defineSchema({
  id: "cloudflare-worker.lookup.output",
  semanticRevision: "1",
  schema: z.object({ item: z.string(), status: z.literal("available") }).strict(),
});
const output = defineSchema({
  id: "cloudflare-worker.output",
  semanticRevision: "1",
  schema: z.object({ summary: z.string(), source: z.literal("worker-fixture") }).strict(),
});
const lookup = defineTool({
  id: "cloudflare-worker.lookup@1",
  implementationVersion: "1.0.0",
  description: "Read the immutable Worker fixture.",
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
  operation: {
    kind: "read",
    execute: ({ item }) => Promise.resolve({ item, status: "available" as const }),
  },
});
function model(): CompiledModelDefinition {
  const turns = new Map<string, number>();
  return {
    modelSecurityProfileDigest: security.modelSecurityProfileDigest,
    modelResourceProfileDigest: resources.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: digestCanonicalJson({ adapter: "cloudflare-worker@1" }),
    modelConfig: { kind: "deterministic" },
    credentialMode: "ambient_preview",
    driver: {
      capabilities,
      async *invoke(request: Parameters<ModelDriver["invoke"]>[0]) {
        await Promise.resolve();
        const turn = (turns.get(request.run.runId) ?? 0) + 1;
        if (turn >= 2) turns.delete(request.run.runId);
        else turns.set(request.run.runId, turn);
        yield turn === 1
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: lookup.registration.toolRegistrationDigest,
                input: { item: "notebook" },
                targetDigest: digestCanonicalJson({ fixture: "inventory", item: "notebook" }),
              },
            }
          : {
              type: "final",
              value: { summary: "notebook is available", source: "worker-fixture" },
            };
      },
    },
  };
}
export const cloudflareAgent = defineAgent({
  id: "cloudflare-worker-agent",
  version: "0.1.0",
  description: "Portable deterministic Worker agent.",
  input,
  instructions: defineInstructions({ text: "Read the bounded fixture and report its status." }),
  model: model(),
  tools: { lookup },
  policy: definePolicy({
    id: "cloudflare-worker.policy",
    implementationVersion: "1.0.0",
    default: "deny",
    rules: [{ riskClass: "R1", decision: "allow_with_grant" }],
  }),
  output,
  verifiers: ["schema@1"],
});
