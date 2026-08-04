import { describe, expect, it } from "vitest";
import { CLOUDFLARE_COMPATIBILITY_DATE, createCloudflareWorker } from "../src/index.js";

const capabilities = {
  schemaVersion: "1" as const,
  executionProfile: "ephemeral" as const,
  durableStorage: false,
  protectedContext: false,
  protectedWorkOrders: false,
  protectedInputSubmissions: false,
  streaming: true,
  cancellation: true,
  sandbox: "none" as const,
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

describe("Cloudflare Worker adapter", () => {
  it("uses Web APIs without ambient binding exposure", async () => {
    let env: Readonly<Record<string, string | undefined>> = {};
    const worker = createCloudflareWorker({
      runtime: {
        getCapabilities: () => capabilities,
        evaluateReadiness: () => ({
          schemaVersion: "1",
          ready: false,
          profile: "production",
          capabilities,
          checks: [],
          evaluatedAt: "2026-08-03T00:00:00.000Z",
          rulesVersion: "1",
        }),
      } as never,
      authenticate: (_request, context) => {
        env = context.env;
        return Promise.resolve(undefined);
      },
      authorize: () => Promise.resolve(false),
      resolveAgent: () => Promise.resolve(undefined),
      selectEnvironment: (bindings) => ({ MODEL_BINDING: typeof bindings["MODEL_BINDING"] }),
    });
    const response = await worker.fetch(
      new Request("https://worker.example.com/v1/runs/run-1"),
      { MODEL_BINDING: "secret-value", OTHER_SECRET: "hidden" },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(401);
    expect(env).toEqual({ MODEL_BINDING: "string" });
    expect(JSON.stringify(env)).not.toContain("secret-value");
    expect(CLOUDFLARE_COMPATIBILITY_DATE).toBe("2026-08-03");
  });
});
