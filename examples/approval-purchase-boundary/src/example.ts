import {
  createCommandContext,
  createCommandId,
  createLocalAuthorityIssuer,
  createLocalRuntime,
  createWorkOrderRequest,
  defineAgent,
  defineModelResourceProfile,
  defineModelSecurityProfile,
  definePolicy,
  defineTool,
  type CompiledModelDefinition,
  type RuntimeCapabilities,
} from "@pactmark/agent";
import { digestCanonicalJson, type ModelDriver, type RunEvent } from "@pactmark/core";
import { z } from "zod";

export interface PurchaseRequest {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly currency: "USD";
  readonly targetAccount: string;
}

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
  id: "example.purchase.model@1",
  provider: "fixture",
  model: "deterministic",
  endpointOrigin: "https://fixture.invalid",
  credentialSlot: "fixture.none",
  allowedTenants: ["purchase-demo"],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["public"],
  processingRegion: "process-local",
  retention: "none",
  logging: "none",
  training: "none",
  contractReference: "local-purchase-fixture",
});

const modelResources = defineModelResourceProfile({
  id: "example.purchase.resources@1",
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
  estimator: "example.purchase.exact@1",
  providerOutputCap: "enforced",
});

const PurchaseRequestSchema = z
  .object({
    sku: z.string().trim().min(1).max(80),
    quantity: z.number().int().positive(),
    unitPriceMinor: z.number().int().positive(),
    currency: z.literal("USD"),
    targetAccount: z.string().trim().min(1).max(128),
  })
  .strict();

export const purchasePolicy = definePolicy({
  id: "example.purchase.policy",
  implementationVersion: "1.0.0",
  default: "deny",
  rules: [{ riskClass: "R4", decision: "require_approval" }],
});

function purchaseAgent(dispatch: (request: PurchaseRequest) => void) {
  const purchase = defineTool({
    id: "example.purchase.submit@1",
    description: "Submit one simulated purchase after exact one-use approval.",
    input: PurchaseRequestSchema,
    output: z.object({ accepted: z.literal(true), sku: z.string() }).strict(),
    security: { requiredScopes: ["purchase:submit"], riskClass: "R4" },
    resources: (request, context) => [
      {
        kind: "tenant",
        value: context.tenantId,
        normalizationVersion: "pactmark.policy-normalization@1",
      },
      {
        kind: "identifier",
        value: request.targetAccount.toLowerCase(),
        normalizationVersion: "example.purchase-account@1",
      },
    ],
    operation: {
      kind: "write",
      reversibility: "irreversible",
      materialConsequence: "Charges the exact simulated purchase total to the target account.",
      execute: (request) => {
        dispatch(request);
        return Promise.resolve({ accepted: true as const, sku: request.sku });
      },
    },
  });
  const turnsByRun = new Map<string, number>();
  const model: CompiledModelDefinition = {
    modelSecurityProfileDigest: modelSecurity.modelSecurityProfileDigest,
    modelResourceProfileDigest: modelResources.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: digestCanonicalJson({ adapter: "purchase-fixture@1" }),
    modelConfig: { kind: "deterministic" },
    credentialMode: "ambient_preview",
    driver: {
      capabilities,
      async *invoke(request: Parameters<ModelDriver["invoke"]>[0]) {
        await Promise.resolve();
        const turn = (turnsByRun.get(request.run.runId) ?? 0) + 1;
        turnsByRun.set(request.run.runId, turn);
        const modelInput = request.input;
        const purchaseInput =
          typeof modelInput === "object" &&
          modelInput !== null &&
          !Array.isArray(modelInput) &&
          "input" in modelInput
            ? PurchaseRequestSchema.parse(modelInput.input)
            : PurchaseRequestSchema.parse(modelInput);
        yield turn === 1
          ? {
              type: "tool_call",
              value: {
                toolRegistrationDigest: purchase.registration.toolRegistrationDigest,
                input: purchaseInput,
              },
            }
          : {
              type: "final",
              value: { status: "simulated_purchase_recorded", sku: "approved" },
            };
      },
    },
  };
  return defineAgent({
    id: "example-purchase-agent",
    version: "0.1.0",
    input: PurchaseRequestSchema,
    instructions: "Request exact approval before submitting the simulated purchase.",
    model,
    tools: { purchase },
    policy: purchasePolicy,
    output: z
      .object({ status: z.literal("simulated_purchase_recorded"), sku: z.string() })
      .strict(),
  });
}

function decisionScopes(runId: string, decisionId: string) {
  return [
    { kind: "run" as const, value: runId, normalizationVersion: "pactmark.command@1" },
    { kind: "opaque" as const, value: decisionId, normalizationVersion: "pactmark.command@1" },
  ];
}

export async function runPurchaseDecision(input: PurchaseRequest, decision: "approve" | "reject") {
  const request = PurchaseRequestSchema.parse(input);
  let dispatchCount = 0;
  const agent = purchaseAgent(() => {
    dispatchCount += 1;
  });
  const local = createLocalAuthorityIssuer();
  const authority = local.issue({
    principal: { type: "user", id: "purchase-demo-user" },
    tenant: { id: "purchase-demo" },
    authenticationStrength: "phishing_resistant",
  });
  const runtime = createLocalRuntime({ agents: [agent], authorityIssuer: local.issuer });
  const workOrder = createWorkOrderRequest({
    agent: { id: agent.id, version: agent.version },
    goal: "Submit one explicitly approved simulated purchase",
    input: request,
    context: { roleFamily: "purchasing", workflowId: "approval-demo", riskClass: "high" },
    workMode: "assist",
    autonomyMode: "assist",
    decisionOwner: { mode: "requesting_principal" },
    purpose: { code: "service_delivery", registryVersion: "general@1" },
    dataClass: "public",
    retention: { mode: "session" },
    requestedCapabilities: ["purchase:submit"],
    resourceScopeCeiling: [
      {
        kind: "tenant",
        value: "purchase-demo",
        normalizationVersion: "pactmark.policy-normalization@1",
      },
      {
        kind: "identifier",
        value: request.targetAccount.toLowerCase(),
        normalizationVersion: "example.purchase-account@1",
      },
    ],
    budget: { maxTurns: 4, maxModelCalls: 4, maxToolCalls: 1, maxActiveExecutionMs: 10_000 },
  });
  const started = await runtime.start(
    authority,
    agent,
    workOrder,
    createCommandContext({
      commandId: createCommandId(),
      operation: "run.start",
      payload: workOrder,
    }),
  );
  const waiting = await runtime.wait(authority, started.runId);
  const decisionId = waiting.waitingDecisionId;
  if (waiting.status !== "waiting_for_approval" || decisionId === null) {
    throw new TypeError("KAF_EXAMPLE_APPROVAL_GATE_MISSING");
  }
  const scopes = decisionScopes(started.runId, decisionId);
  const challenge = await runtime.issueDecisionChallenge(
    authority,
    started.runId,
    decisionId,
    createCommandContext({
      commandId: createCommandId(),
      operation: "run.issue_decision_challenge",
      payload: {},
      normalizedResourceScope: scopes,
    }),
  );
  const submission = {
    decision,
    decisionId,
    challengeProof: challenge.challengeProof,
    ...(decision === "reject" ? { reasonCode: "example_user_rejected" } : {}),
  };
  if (decision === "approve") {
    await runtime.approve(
      authority,
      started.runId,
      submission,
      createCommandContext({
        commandId: createCommandId(),
        operation: "run.approve",
        payload: submission,
        normalizedResourceScope: scopes,
      }),
    );
    await runtime.resume(
      authority,
      started.runId,
      createCommandContext({
        commandId: createCommandId(),
        operation: "run.resume",
        payload: { runId: started.runId },
      }),
    );
  } else {
    await runtime.reject(
      authority,
      started.runId,
      submission,
      createCommandContext({
        commandId: createCommandId(),
        operation: "run.reject",
        payload: submission,
        normalizedResourceScope: scopes,
      }),
    );
  }
  const projection = await runtime.getRun(authority, started.runId);
  const events: RunEvent[] = [];
  for await (const event of runtime.events(authority, started.runId)) events.push(event);
  return Object.freeze({
    runId: started.runId,
    status: projection.status,
    dispatchCount,
    eventTypes: Object.freeze(events.map((event) => event.eventType)),
    challengeProofPersisted: JSON.stringify(events).includes(challenge.challengeProof),
    productionClaim: false,
  });
}
