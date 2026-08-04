import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AgentDefinitionSchema,
  RunEventSchema,
  WorkOrderRequestSchema,
  canonicalJsonStringify,
  type AgentDefinition,
  type RunEvent,
  type WorkOrderRequest,
} from "@pactmark/core";

describe("@pactmark/core packed-style consumer contract", () => {
  it("exports runtime schemas and matching inferred types from the public entrypoint", () => {
    expect(AgentDefinitionSchema).toBeDefined();
    expect(WorkOrderRequestSchema).toBeDefined();
    expect(RunEventSchema).toBeDefined();
    expect(canonicalJsonStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expectTypeOf<typeof AgentDefinitionSchema.parse>().returns.toEqualTypeOf<AgentDefinition>();
    expectTypeOf<typeof WorkOrderRequestSchema.parse>().returns.toEqualTypeOf<WorkOrderRequest>();
    expectTypeOf<typeof RunEventSchema.parse>().returns.toEqualTypeOf<RunEvent>();
  });
});
