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

const modelSecurity = defineModelSecurityProfile({
  id: "nextjs-vercel.model@1",
  provider: "local",
  model: "deterministic",
  endpointOrigin: "https://local.invalid",
  credentialSlot: "local.none",
  allowedTenants: ["nextjs-vercel-preview", "nextjs-vercel-production"],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["public"],
  processingRegion: "process-local",
  retention: "none",
  logging: "none",
  training: "none",
  contractReference: "deterministic-next-fixture",
});

const modelResources = defineModelResourceProfile({
  id: "nextjs-vercel.resources@1",
  implementationVersion: "1.0.0",
  maxInputBytesPerCall: 32_000,
  maxInputTokensPerCall: 4_000,
  maxOutputTokensPerCall: 512,
  maxStreamedOutputBytesPerCall: 32_000,
  maxStreamEventsPerCall: 100,
  maxToolResultToContextBytes: 8_000,
  maxContextSnapshotBytes: 64_000,
  maxRunModelInputBytes: 128_000,
  maxRunModelInputTokens: 16_000,
  maxRunModelOutputBytes: 64_000,
  maxRunModelOutputTokens: 2_048,
  maxRunToolResultToContextBytes: 32_000,
  estimator: "nextjs-vercel.exact@1",
  providerOutputCap: "enforced",
});

const input = defineSchema({
  id: "nextjs-vercel.input",
  semanticRevision: "1",
  schema: z.object({ item: z.string().min(1).max(80) }).strict(),
});
const lookupInput = defineSchema({
  id: "nextjs-vercel.lookup.input",
  semanticRevision: "1",
  schema: z.object({ item: z.string().min(1).max(80) }).strict(),
});
const lookupOutput = defineSchema({
  id: "nextjs-vercel.lookup.output",
  semanticRevision: "1",
  schema: z.object({ item: z.string(), status: z.literal("available") }).strict(),
});
const output = defineSchema({
  id: "nextjs-vercel.output",
  semanticRevision: "1",
  schema: z.object({ summary: z.string(), source: z.literal("local-fixture") }).strict(),
});

const nextLookupTool = defineTool({
  id: "nextjs-vercel.lookup@1",
  implementationVersion: "1.0.0",
  description: "Read the bounded in-process preview fixture.",
  input: lookupInput,
  output: lookupOutput,
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

function deterministicModel(): CompiledModelDefinition {
  const turnsByRun = new Map<string, number>();
  return {
    modelSecurityProfileDigest: modelSecurity.modelSecurityProfileDigest,
    modelResourceProfileDigest: modelResources.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: digestCanonicalJson({ adapter: "nextjs-vercel@1" }),
    modelConfig: { kind: "deterministic" },
    credentialMode: "ambient_preview",
    driver: {
      capabilities,
      async *invoke(request: Parameters<ModelDriver["invoke"]>[0]) {
        await Promise.resolve();
        const turn = (turnsByRun.get(request.run.runId) ?? 0) + 1;
        if (turn >= 2) turnsByRun.delete(request.run.runId);
        else turnsByRun.set(request.run.runId, turn);
        yield turn === 1
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: nextLookupTool.registration.toolRegistrationDigest,
                input: { item: "notebook" },
                targetDigest: digestCanonicalJson({ fixture: "inventory", item: "notebook" }),
              },
            }
          : {
              type: "final",
              value: { summary: "notebook is available", source: "local-fixture" },
            };
      },
    },
  };
}

export const nextAgent = defineAgent({
  id: "nextjs-vercel-agent",
  version: "0.1.0",
  description: "Deterministic Vercel preview agent.",
  input,
  instructions: defineInstructions({ text: "Read the bounded fixture and report its status." }),
  model: deterministicModel(),
  tools: { lookup: nextLookupTool },
  policy: definePolicy({
    id: "nextjs-vercel.policy",
    implementationVersion: "1.0.0",
    default: "deny",
    rules: [{ riskClass: "R1", decision: "allow_with_grant" }],
  }),
  output,
  verifiers: ["schema@1"],
});
