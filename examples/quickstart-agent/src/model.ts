import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

type ProviderChunk =
  | { type: "stream-start"; warnings: [] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | {
      type: "finish";
      finishReason: { unified: "stop" | "tool-calls"; raw: undefined };
      usage: {
        inputTokens: {
          total: number;
          noCache: number;
          cacheRead: undefined;
          cacheWrite: undefined;
        };
        outputTokens: { total: number; text: number; reasoning: undefined };
      };
    };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

const toolCallTurn: readonly ProviderChunk[] = [
  { type: "stream-start", warnings: [] },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "catalog_lookup_1",
    input: '{"sku":"P-100"}',
  },
  { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
];

const finalTurn: readonly ProviderChunk[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "text-1" },
  {
    type: "text-delta",
    id: "text-1",
    delta: '{"summary":"P-100 Portable notebook is available."}',
  },
  { type: "text-end", id: "text-1" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
];

/**
 * A deterministic provider-shaped model so this example needs no key: the
 * first call proposes the catalog tool exactly the way a live provider would,
 * the second call answers with the final JSON output.
 *
 * To run against a real provider, replace this with any AI SDK v7 model
 * instance, for example:
 *
 *   import { anthropic } from "@ai-sdk/anthropic";
 *   export const model = () => anthropic("claude-sonnet-4-5");
 *
 * The agent definition does not change: tools stay schema-only advertisements
 * and every proposal still crosses Pactmark's policy and dispatch boundary.
 */
export function model(): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    provider: "fixture",
    modelId: "quickstart-fixture",
    doStream: () => {
      call += 1;
      return Promise.resolve({
        stream: simulateReadableStream({
          chunks: [...(call === 1 ? toolCallTurn : finalTurn)],
        }),
      });
    },
  });
}
