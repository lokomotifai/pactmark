import { describe, expect, it } from "vitest";
import { runDelegatedIncidentBoundary } from "../src/example.js";

describe("delegated incident boundary", () => {
  it("invalidates stale delegated authority after fencing changes", () => {
    const result = runDelegatedIncidentBoundary();
    expect(result.beforeFence).toMatchObject({ valid: true });
    expect(result.afterFence).toEqual({ valid: false, reason: "fencing_mismatch" });
    expect(result.decisionRights).toEqual([]);
    expect(result).toMatchObject({
      durableResumeSupported: false,
      limitationCode: "KAF_EXAMPLE_DURABLE_RESUME_UNAVAILABLE",
    });
  });
});
