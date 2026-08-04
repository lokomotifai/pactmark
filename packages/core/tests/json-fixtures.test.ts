import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RunEventSchema } from "../src/events.js";
import { parseJsonStrict } from "../src/serialization.js";
import { AcceptedAgentWorkOrderSchema } from "../src/work-order.js";

function fixture(relativePath: string): unknown {
  const url = new URL(`../fixtures/${relativePath}`, import.meta.url);
  return parseJsonStrict(readFileSync(fileURLToPath(url), "utf8"));
}

describe("committed JSON fixtures", () => {
  it("round-trips the initial persisted schema version without loss", () => {
    const workOrder = AcceptedAgentWorkOrderSchema.parse(
      fixture("v1/accepted-agent-work-order.json"),
    );
    const event = RunEventSchema.parse(fixture("v1/run-accepted-event.json"));
    expect(AcceptedAgentWorkOrderSchema.parse(JSON.parse(JSON.stringify(workOrder)))).toEqual(
      workOrder,
    );
    expect(RunEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("rejects an unknown future schema version deterministically", () => {
    expect(RunEventSchema.safeParse(fixture("malformed/future-schema-version.json")).success).toBe(
      false,
    );
  });
});
