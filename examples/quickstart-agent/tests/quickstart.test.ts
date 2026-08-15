import { describe, expect, it } from "vitest";

import { createLocalRuntime } from "@pactmark/agent";

import { catalogAgent } from "../src/agent.js";
import { recordsAgent, recordStore } from "../src/records-agent.js";

describe("quickstart agents", () => {
  it("completes a provider-shaped tool loop through the governed pipeline", async () => {
    const runtime = createLocalRuntime({ agents: [catalogAgent] });
    const result = await runtime.run(catalogAgent, {
      goal: "Check availability of SKU P-100.",
      input: { sku: "P-100" },
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "P-100 Portable notebook is available." });
    expect(result.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "RunAccepted",
        "ToolCallRequested",
        "ToolCallCompleted",
        "VerificationRecorded",
        "RunCompleted",
      ]),
    );
    expect(result.evidence).toBeDefined();
  });

  it("dispatches the R2 write through the governed effect path", async () => {
    const runtime = createLocalRuntime({ agents: [recordsAgent] });
    const result = await runtime.run(recordsAgent, {
      goal: "Persist the greeting record.",
      input: { key: "greeting" },
    });
    expect(result.status).toBe("completed");
    expect(recordStore.get("greeting")).toBe("hello");
    expect(result.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["EffectPrepared", "EffectDispatched", "EffectAcknowledged"]),
    );
  });
});
