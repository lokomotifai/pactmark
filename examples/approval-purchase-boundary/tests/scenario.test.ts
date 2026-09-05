import { describe, expect, it } from "vitest";

import { runPurchaseDecision } from "../src/example.js";

const request = {
  sku: "P-100",
  quantity: 2,
  unitPriceMinor: 1250,
  currency: "USD" as const,
  targetAccount: "Demo-Merchant",
};

describe("approval purchase boundary", () => {
  it("dispatches exactly once after the facade records an exact approval", async () => {
    const result = await runPurchaseDecision(request, "approve");
    expect(result).toMatchObject({
      status: "completed",
      dispatchCount: 1,
      challengeProofPersisted: false,
      productionClaim: false,
    });
    expect(result.eventTypes).toEqual(
      expect.arrayContaining([
        "ApprovalRequested",
        "ApprovalRecorded",
        "EffectPrepared",
        "EffectAcknowledged",
        "RunCompleted",
      ]),
    );
  });

  it("records rejection and performs no simulated purchase write", async () => {
    const result = await runPurchaseDecision(request, "reject");
    expect(result).toMatchObject({
      status: "failed",
      dispatchCount: 0,
      challengeProofPersisted: false,
      productionClaim: false,
    });
    expect(result.eventTypes).toContain("ApprovalRejected");
    expect(result.eventTypes).not.toContain("EffectPrepared");
  });

  it("rejects malformed purchase authority before starting a run", async () => {
    await expect(runPurchaseDecision({ ...request, quantity: 0 }, "approve")).rejects.toBeDefined();
  });
});
