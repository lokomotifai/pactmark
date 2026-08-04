import { describe, expect, it } from "vitest";
import { runResearchEvidence } from "../src/agent.js";
import { createExternalSearchAdapter } from "../src/tools/fixture-search.js";
describe("research evidence agent", () => {
  it("exports verified evidence while separating observation, inference, and limits", () => {
    const result = runResearchEvidence();
    expect(result.integrity.status).toBe("pass");
    expect(result.citations.status).toBe("pass");
    expect(result.digestValid).toBe(true);
    expect(result.document.sourceDates[0]).toMatchObject({
      publishedAt: "2025-12-15T00:00:00.000Z",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.document.observedSupport[0]).toContain("supports deterministic");
    expect(result.document.inferences[0]).toContain("suitable");
    expect(result.evidence.doesNotProve).toContain("The cited URL exists or is authoritative.");
    expect(result.markdown).toContain("## Does not prove");
  });
  it("keeps network research opt-in and unconfigured", () => {
    expect(() => createExternalSearchAdapter({ allowNetwork: false })).toThrow(
      "KAF_RESEARCH_NETWORK_DISABLED",
    );
    expect(() => createExternalSearchAdapter({ allowNetwork: true })).toThrow(
      "KAF_RESEARCH_EXTERNAL_ADAPTER_NOT_CONFIGURED",
    );
  });
});
