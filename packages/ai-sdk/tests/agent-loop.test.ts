import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createLocalRuntime, defineAgent, definePolicy, defineTool } from "@pactmark/agent";
import { z } from "zod";

import { fromAISDK } from "../src/index.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

/**
 * A provider-shaped model: first call proposes a tool call the way a real
 * provider would, second call answers with the final JSON output.
 */
function providerShapedModel(): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    provider: "fixture",
    modelId: "fixture-model",
    doStream: () => {
      call += 1;
      return {
        stream: simulateReadableStream({
          chunks:
            call === 1
              ? [
                  { type: "stream-start" as const, warnings: [] as [] },
                  {
                    type: "tool-call" as const,
                    toolCallId: "call-1",
                    toolName: "catalog_lookup_1",
                    input: '{"sku":"P-100"}',
                  },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "tool-calls" as const, raw: undefined },
                    usage,
                  },
                ]
              : [
                  { type: "stream-start" as const, warnings: [] as [] },
                  { type: "text-start" as const, id: "text-1" },
                  {
                    type: "text-delta" as const,
                    id: "text-1",
                    delta: '{"summary":"Portable notebook is available."}',
                  },
                  { type: "text-end" as const, id: "text-1" },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "stop" as const, raw: undefined },
                    usage,
                  },
                ],
        }),
      };
    },
  });
}

describe("AI SDK provider drives the governed tool loop end to end", () => {
  it("completes RunAccepted → ToolCallCompleted → VerificationRecorded → RunCompleted", async () => {
    const lookup = defineTool({
      id: "catalog.lookup@1",
      description: "Read one catalog item.",
      input: z.object({ sku: z.string().min(1) }).strict(),
      output: z.object({ sku: z.string(), available: z.boolean() }).strict(),
      security: { requiredScopes: ["catalog:read"] },
      operation: {
        kind: "read",
        execute: ({ sku }) => Promise.resolve({ sku, available: sku === "P-100" }),
      },
    });
    const agent = defineAgent({
      id: "ai-sdk-loop-agent",
      version: "0.1.0",
      input: z.object({ sku: z.string().min(1) }).strict(),
      instructions: "Check the catalog before answering, then reply with the output JSON.",
      model: fromAISDK(providerShapedModel()),
      tools: { lookup },
      output: z.object({ summary: z.string() }).strict(),
    });
    const runtime = createLocalRuntime({ agents: [agent] });
    const result = await runtime.run(agent, {
      goal: "Check availability of SKU P-100.",
      input: { sku: "P-100" },
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "Portable notebook is available." });
    const eventTypes = result.events.map((event) => event.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "RunAccepted",
        "ToolCallRequested",
        "ToolCallCompleted",
        "VerificationRecorded",
        "RunCompleted",
      ]),
    );
    expect(result.evidence?.claim.claimType).toBe("run_output_verification");
  });

  it("fails the run when policy denies the proposed tool's risk class", async () => {
    const lookup = defineTool({
      id: "catalog.lookup@1",
      description: "Read one catalog item.",
      input: z.object({ sku: z.string().min(1) }).strict(),
      output: z.object({ sku: z.string(), available: z.boolean() }).strict(),
      security: { requiredScopes: ["catalog:read"] },
      operation: {
        kind: "read",
        execute: ({ sku }) => Promise.resolve({ sku, available: sku === "P-100" }),
      },
    });
    const agent = defineAgent({
      id: "ai-sdk-denied-agent",
      version: "0.1.0",
      input: z.object({ sku: z.string().min(1) }).strict(),
      instructions: "Check the catalog before answering.",
      model: fromAISDK(providerShapedModel()),
      tools: { lookup },
      policy: definePolicy({
        id: "ai-sdk-denied-agent.policy",
        implementationVersion: "1.0.0",
        default: "deny",
        rules: [{ riskClass: "R1", decision: "deny" }],
      }),
      output: z.object({ summary: z.string() }).strict(),
    });
    const runtime = createLocalRuntime({ agents: [agent] });
    const result = await runtime.run(agent, {
      goal: "Check availability of SKU P-100.",
      input: { sku: "P-100" },
    });
    expect(result.status).toBe("failed");
    expect(result.output).toBeUndefined();
  });

  it("surfaces an adapter failure when the provider proposes an unadvertised tool", async () => {
    const renamed = defineTool({
      id: "records.list@1",
      description: "Advertised under a different provider name.",
      input: z.object({ sku: z.string().min(1) }).strict(),
      output: z.object({ sku: z.string(), available: z.boolean() }).strict(),
      security: { requiredScopes: ["catalog:read"] },
      operation: {
        kind: "read",
        execute: ({ sku }) => Promise.resolve({ sku, available: false }),
      },
    });
    const agent = defineAgent({
      id: "ai-sdk-unadvertised-agent",
      version: "0.1.0",
      input: z.object({ sku: z.string().min(1) }).strict(),
      instructions: "Check the catalog before answering.",
      model: fromAISDK(providerShapedModel()),
      tools: { renamed },
      output: z.object({ summary: z.string() }).strict(),
    });
    const runtime = createLocalRuntime({ agents: [agent] });
    await expect(
      runtime.run(agent, { goal: "Check availability of SKU P-100.", input: { sku: "P-100" } }),
    ).rejects.toBeDefined();
  });
});
