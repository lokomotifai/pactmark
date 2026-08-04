import { describe, expect, it } from "vitest";
import { runEvidenceDocumentPipeline } from "../src/example.js";

describe("evidence document pipeline", () => {
  it("exports deterministic bounded evidence", () => {
    const result = runEvidenceDocumentPipeline();
    expect(result.integrity.status).toBe("pass");
    expect(result.citations.status).toBe("pass");
    expect(result.digestValid).toBe(true);
    expect(result.evidence.doesNotProve).toContain(
      "The cited URL exists or supports the document's claim.",
    );
    expect(result.markdown).toContain("## Does not prove");
    expect(JSON.parse(result.json)).toMatchObject({ evidenceRecordId: "document-evidence" });
  });
});
