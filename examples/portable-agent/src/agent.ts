import {
  createLocalRuntime,
  defineAgent,
  defineModelResourceProfile,
  defineModelSecurityProfile,
  defineTool,
  type CompiledModelDefinition,
  type RuntimeCapabilities,
} from "@pactmark/agent";
import { z } from "zod";

import type { PortableResult } from "./contract.js";
import { lookupCatalog } from "./tools/catalog.js";

const capabilities: RuntimeCapabilities = Object.freeze({
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
});

const security = defineModelSecurityProfile({
  id: "portable-agent.model@1",
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
  contractReference: "portable-agent-fixture",
});

const resources = defineModelResourceProfile({
  id: "portable-agent.resources@1",
  implementationVersion: "1.0.0",
  maxInputBytesPerCall: 16_000,
  maxInputTokensPerCall: 2_000,
  maxOutputTokensPerCall: 256,
  maxStreamedOutputBytesPerCall: 16_000,
  maxStreamEventsPerCall: 20,
  maxToolResultToContextBytes: 4_000,
  maxContextSnapshotBytes: 32_000,
  maxRunModelInputBytes: 64_000,
  maxRunModelInputTokens: 8_000,
  maxRunModelOutputBytes: 32_000,
  maxRunModelOutputTokens: 1_024,
  maxRunToolResultToContextBytes: 16_000,
  estimator: "portable-agent.exact@1",
  providerOutputCap: "enforced",
});

const requestSchema = z.object({ sku: z.string().min(1) }).strict();
const modelInputSchema = z.object({ goal: z.string().min(1), input: requestSchema }).strict();
const toolOutputSchema = z
  .object({ sku: z.string(), name: z.string(), available: z.boolean() })
  .strict();
const resultSchema = z.object({ summary: z.string() }).strict();

function composition(expectedSku: string) {
  let observedToolOutput: z.infer<typeof toolOutputSchema> | undefined;
  const lookup = defineTool({
    id: "portable.catalog.lookup@1",
    description: "Read one item from the embedded portable catalog fixture.",
    input: requestSchema,
    output: toolOutputSchema,
    security: {
      requiredScopes: ["catalog:read"],
      riskClass: "R1",
      dataClasses: ["public"],
      reversibility: "not_applicable",
      egress: { mode: "none" },
      networkEnforcement: "declared_ok",
      maxCallsPerRun: 1,
      timeoutMs: 1_000,
    },
    operation: {
      kind: "read",
      execute: ({ sku }) => {
        const item = lookupCatalog(sku);
        if (item === undefined) throw new TypeError("KAF_EXAMPLE_SKU_NOT_FOUND");
        observedToolOutput = { ...item };
        return Promise.resolve({ ...item });
      },
    },
  });
  const pendingSkuByRun = new Map<string, string>();
  const model: CompiledModelDefinition = {
    modelSecurityProfileDigest: security.modelSecurityProfileDigest,
    modelResourceProfileDigest: resources.modelResourceProfileDigest,
    modelAdapterRegistrationDigest:
      "sha256:a9cde0de85df3a1ea33284c61bca30218e8d75576848c79a38aab7afab72d7c2",
    modelConfig: { kind: "deterministic-portable-fixture" },
    credentialMode: "ambient_preview",
    driver: {
      capabilities,
      async *invoke(request) {
        await Promise.resolve();
        const pendingSku = pendingSkuByRun.get(request.run.runId);
        const sku = pendingSku ?? modelInputSchema.parse(request.input).input.sku;
        if (pendingSku === undefined) pendingSkuByRun.set(request.run.runId, sku);
        else pendingSkuByRun.delete(request.run.runId);
        const item = lookupCatalog(sku);
        yield pendingSku === undefined
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: lookup.registration.toolRegistrationDigest,
                input: { sku },
              },
            }
          : {
              type: "final",
              value: {
                summary: `${item?.name ?? sku} is ${
                  item?.available === true ? "available" : "unavailable"
                }.`,
              },
            };
      },
    },
  };
  const agent = defineAgent({
    id: "portable-catalog-agent",
    version: "0.1.0",
    input: requestSchema,
    instructions: "Read the embedded catalog fixture and return the bounded result as JSON.",
    model,
    tools: { lookup },
    output: resultSchema,
  });
  return Object.freeze({
    agent,
    observedToolOutput: () => observedToolOutput,
    expectedSku,
  });
}

export async function runPortableAgent(request: unknown): Promise<PortableResult> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) return { ok: false, errorCode: "KAF_EXAMPLE_INPUT_INVALID" };
  if (lookupCatalog(parsed.data.sku) === undefined) {
    return { ok: false, errorCode: "KAF_EXAMPLE_SKU_NOT_FOUND" };
  }
  const composed = composition(parsed.data.sku);
  const runtime = createLocalRuntime({ agents: [composed.agent] });
  const result = await runtime.run(composed.agent, {
    goal: `Read catalog item ${composed.expectedSku}.`,
    input: parsed.data,
  });
  const output = resultSchema.safeParse(result.output);
  const artifact = result.artifacts.at(-1)?.artifact;
  const toolOutput = composed.observedToolOutput();
  if (
    result.status !== "completed" ||
    !output.success ||
    artifact === undefined ||
    toolOutput === undefined ||
    result.evidence === undefined
  ) {
    return { ok: false, errorCode: "KAF_EXAMPLE_RUN_FAILED" };
  }
  return Object.freeze({
    ok: true as const,
    events: Object.freeze(
      result.events.map(({ sequence, eventType }) => Object.freeze({ sequence, type: eventType })),
    ),
    toolOutput: Object.freeze({ ...toolOutput }),
    artifactContentDigest: artifact.contentDigest,
    evidenceProduced: true as const,
    summary: output.data.summary,
  });
}
