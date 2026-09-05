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
  humanDecisions: true,
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

const inputShape = z.object({ item: z.string().min(1).max(80) }).strict();
const modelInvocationInput = z.object({ goal: z.string().min(1), input: inputShape }).strict();
const input = defineSchema({
  id: "nextjs-vercel.input",
  semanticRevision: "1",
  schema: inputShape,
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

const nextApprovalTool = defineTool({
  id: "nextjs-vercel.reserve@1",
  implementationVersion: "1.0.0",
  description: "Reserve the bounded in-process preview fixture after exact approval.",
  input: lookupInput,
  output: lookupOutput,
  security: {
    riskClass: "R4",
    dataClasses: ["public"],
    reversibility: "irreversible",
    requiredScopes: ["fixture:reserve"],
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
  operation: {
    kind: "write",
    reversibility: "irreversible",
    materialConsequence: "Reserves one item in the process-local demonstration fixture.",
    approvalPreview: ({ item }) => ({
      title: "Reserve fixture item",
      summary: `Reserve the process-local fixture item “${item}”.`,
      fields: [{ label: "Item", value: item }],
    }),
    execute: ({ item }) => Promise.resolve({ item, status: "available" as const }),
  },
});

function deterministicModel(): CompiledModelDefinition {
  const itemsByRun = new Map<string, string>();
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
        const pendingItem = itemsByRun.get(request.run.runId);
        const item = pendingItem ?? modelInvocationInput.parse(request.input).input.item;
        if (pendingItem === undefined) itemsByRun.set(request.run.runId, item);
        else itemsByRun.delete(request.run.runId);
        yield pendingItem === undefined
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: nextApprovalTool.registration.toolRegistrationDigest,
                input: { item },
                targetDigest: digestCanonicalJson({ fixture: "inventory", item }),
              },
            }
          : {
              type: "final",
              value: { summary: `${item} was approved and reserved`, source: "local-fixture" },
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
  instructions: defineInstructions({
    text: "Request exact approval, reserve the bounded fixture item, and report its status.",
  }),
  model: deterministicModel(),
  tools: { reserve: nextApprovalTool },
  policy: definePolicy({
    id: "nextjs-vercel.policy",
    implementationVersion: "1.0.0",
    default: "deny",
    rules: [{ riskClass: "R4", decision: "require_approval" }],
  }),
  output,
  verifiers: ["schema@1"],
});
