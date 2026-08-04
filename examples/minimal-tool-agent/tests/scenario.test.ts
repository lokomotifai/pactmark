import { describe, expect, it } from "vitest";

import { runMinimalToolExample } from "../src/example.js";

describe("minimal deterministic tool scenario", () => {
  it("completes one bounded read with artifact and evidence", async () => {
    const result = await runMinimalToolExample();
    expect(result.projection.status).toBe("completed");
    expect(result.events.map((event) => event.eventType)).toContain("ToolCallCompleted");
    expect(result.artifacts).toHaveLength(1);
    expect(result.evidence?.supports).toHaveLength(1);
    expect(result.productionReadiness).toMatchObject({ ready: false, profile: "production" });
  });
});
