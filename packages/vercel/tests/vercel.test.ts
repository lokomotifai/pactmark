import { describe, expect, it } from "vitest";
import { createVercelRouteHandler } from "../src/index.js";

const capabilities = {
  schemaVersion: "1" as const,
  executionProfile: "ephemeral" as const,
  durableStorage: false,
  protectedContext: false,
  protectedWorkOrders: false,
  protectedInputSubmissions: false,
  streaming: true,
  cancellation: true,
  sandbox: "unsafe_local" as const,
  networkPolicy: "declared" as const,
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: false,
  typedInput: false,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none" as const,
  transactionDomains: [],
};

describe("Vercel route adapter", () => {
  it("translates only request-owned context and keeps route params non-authoritative", async () => {
    let observedEnv: Readonly<Record<string, string | undefined>> = {};
    const runtime = {
      getCapabilities: () => capabilities,
      evaluateReadiness: () => ({
        schemaVersion: "1" as const,
        ready: false,
        profile: "production" as const,
        capabilities,
        checks: [],
        evaluatedAt: "2026-08-03T00:00:00.000Z",
        rulesVersion: "1",
      }),
    };
    const handler = createVercelRouteHandler({
      runtime: runtime as never,
      authenticate: (_request, context) => {
        observedEnv = context.env;
        return Promise.resolve(undefined);
      },
      authorize: () => Promise.resolve(false),
      resolveAgent: () => Promise.resolve(undefined),
      readEnvironment: () => ({ MODEL_BINDING: "present" }),
    });
    const response = await handler(new Request("https://example.com/v1/runs/run-1"), {
      tenant: "forged",
      authority: "forged",
    });
    expect(response.status).toBe(401);
    expect(observedEnv).toEqual({ MODEL_BINDING: "present" });
  });
});
