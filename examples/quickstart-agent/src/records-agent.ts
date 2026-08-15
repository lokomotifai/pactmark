import {
  defineAgent,
  definePolicy,
  defineTool,
  type CompiledModelDefinition,
} from "@pactmark/agent";
import { digestCanonicalJson } from "@pactmark/core";
import { z } from "zod";

/**
 * A governed R2 write: the proposal crosses schema validation, an explicit
 * policy rule, a deterministic effect preview, a one-use capability grant,
 * and the effect ledger before the record is written — and the acknowledged
 * result is served from the ledger if the same effect is ever proposed again.
 */
export const recordStore = new Map<string, string>();

export const saveRecord = defineTool({
  id: "records.save@1",
  description: "Persist one bounded record into the in-memory store.",
  input: z.object({ key: z.string().min(1), value: z.string().min(1) }).strict(),
  output: z.object({ key: z.string(), stored: z.boolean() }).strict(),
  security: { requiredScopes: ["records:write"], riskClass: "R2" },
  operation: {
    kind: "write",
    reversibility: "irreversible",
    materialConsequence: "Writes one record into the example store.",
    execute: ({ key, value }) => {
      recordStore.set(key, value);
      return Promise.resolve({ key, stored: true });
    },
  },
});

const scriptedModel = (): CompiledModelDefinition => {
  let call = 0;
  const toolCallEmission = {
    type: "tool_call",
    value: {
      toolRegistrationDigest: saveRecord.registration.toolRegistrationDigest,
      input: { key: "greeting", value: "hello" },
      targetDigest: digestCanonicalJson({ key: "greeting", value: "hello" }),
    },
  } as const;
  const finalEmission = {
    type: "final",
    value: { summary: "Stored the greeting record." },
  } as const;
  return {
    modelSecurityProfileDigest: digestCanonicalJson({ fixture: "records-security" }),
    modelResourceProfileDigest: digestCanonicalJson({ fixture: "records-resources" }),
    modelAdapterRegistrationDigest: digestCanonicalJson({ adapter: "records-fixture@1" }),
    modelConfig: { kind: "deterministic" },
    credentialMode: "ambient_preview",
    driver: {
      capabilities: {
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
      },
      async *invoke() {
        await Promise.resolve();
        const emission = call === 0 ? toolCallEmission : finalEmission;
        call += 1;
        yield emission;
      },
    },
  };
};

export const recordsAgent = defineAgent({
  id: "quickstart-records-agent",
  version: "0.1.0",
  input: z.object({ key: z.string().min(1) }).strict(),
  instructions: "Persist the requested record, then summarize what was stored.",
  model: scriptedModel(),
  tools: { saveRecord },
  // A consequential tool never rides on defaults: the R2 rule is explicit.
  policy: definePolicy({
    id: "quickstart-records-agent.policy",
    implementationVersion: "1.0.0",
    default: "deny",
    rules: [{ riskClass: "R2", decision: "allow_with_grant" }],
  }),
  output: z.object({ summary: z.string() }).strict(),
});
