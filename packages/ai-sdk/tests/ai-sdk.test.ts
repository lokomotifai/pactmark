import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  defineModelResourceProfile,
  defineModelSecurityProfile,
  digestCanonicalJson,
  type ModelResourceProfile,
  type Run,
} from "@pactmark/core";

import { fromAISDK } from "../src/index.js";

const securityProfile = defineModelSecurityProfile({
  id: "fixture-security@1",
  provider: "fixture",
  model: "fixture-model",
  endpointOrigin: "https://models.example.com",
  credentialSlot: "fixture.api-key",
  allowedTenants: ["tenant"],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["public"],
  processingRegion: "provider_managed",
  retention: "none",
  logging: "none",
  training: "none",
  contractReference: "fixture-contract",
});

function resources(overrides: Partial<ModelResourceProfile> = {}): ModelResourceProfile {
  return defineModelResourceProfile({
    id: "fixture-resources@1",
    implementationVersion: "1.0.0",
    maxInputBytesPerCall: 1_000,
    maxInputTokensPerCall: 1_000,
    maxOutputTokensPerCall: 20,
    maxStreamedOutputBytesPerCall: 1_000,
    maxStreamEventsPerCall: 20,
    maxToolResultToContextBytes: 1_000,
    maxContextSnapshotBytes: 1_000,
    maxRunModelInputBytes: 1_000,
    maxRunModelInputTokens: 1_000,
    maxRunModelOutputBytes: 1_000,
    maxRunModelOutputTokens: 100,
    maxRunToolResultToContextBytes: 1_000,
    estimator: "fixture.conservative@1",
    providerOutputCap: "enforced",
    ...overrides,
  });
}

const digest = digestCanonicalJson("fixture");
const run: Run = {
  schemaVersion: "1",
  runId: "run",
  tenantId: "tenant",
  workOrderId: "work-order",
  workOrderBindingDigest: digest,
  executionDefinition: {
    kind: "agent",
    id: "fixture-agent",
    version: "0.1.0",
    agentDefinitionDigest: digest,
  },
  executionDefinitionDigest: digest,
  status: "running",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  dataClass: "public",
  correlationId: "correlation",
};

function modelFor(chunks: readonly string[]): MockLanguageModelV3 {
  const streamChunks: Array<
    | { type: "stream-start"; warnings: [] }
    | { type: "text-start"; id: string }
    | { type: "text-delta"; id: string; delta: string }
    | { type: "text-end"; id: string }
    | {
        type: "finish";
        finishReason: { unified: "stop"; raw: undefined };
        usage: {
          inputTokens: {
            total: number;
            noCache: number;
            cacheRead: undefined;
            cacheWrite: undefined;
          };
          outputTokens: { total: number; text: number; reasoning: undefined };
        };
      }
  > = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-1" },
    ...chunks.map((delta) => ({ type: "text-delta" as const, id: "text-1", delta })),
    { type: "text-end", id: "text-1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
    },
  ];
  return new MockLanguageModelV3({
    provider: "fixture",
    modelId: "fixture-model",
    doStream: { stream: simulateReadableStream({ chunks: streamChunks }) },
  });
}

async function collect(
  model: ReturnType<typeof fromAISDK>,
  input: unknown,
  signal = new AbortController().signal,
) {
  const values = [];
  for await (const value of model.driver.invoke({
    run,
    input: input as never,
    signal,
  })) {
    values.push(value);
  }
  return values;
}

describe("AI SDK preview adapter", () => {
  it("streams with the registered cap and returns structured JSON", async () => {
    const sdkModel = modelFor(['{"ok":', "true}"]);
    const compiled = fromAISDK(sdkModel, {
      securityProfile,
      resourceProfile: resources(),
      credentialMode: "ambient_preview",
    });
    await expect(collect(compiled, { prompt: "hello" })).resolves.toEqual([
      { type: "final", value: { ok: true } },
    ]);
    expect(sdkModel.doStreamCalls[0]?.maxOutputTokens).toBe(20);
    expect(compiled.modelConfig).toEqual(
      expect.objectContaining({ credentialMode: "ambient_preview", provider: "fixture" }),
    );
    expect(compiled.driver.capabilities.executionProfile).toBe("ephemeral");
    expect(JSON.stringify(compiled)).not.toContain("api-key-value");
  });

  it("preserves plain text and rejects profile/model drift", async () => {
    await expect(
      collect(
        fromAISDK(modelFor(["hello"]), {
          securityProfile,
          resourceProfile: resources(),
          credentialMode: "ambient_preview",
        }),
        "prompt",
      ),
    ).resolves.toEqual([{ type: "final", value: "hello" }]);

    expect(() =>
      fromAISDK(new MockLanguageModelV3({ provider: "other", modelId: "fixture-model" }), {
        securityProfile,
        resourceProfile: resources(),
        credentialMode: "ambient_preview",
      }),
    ).toThrow("The model adapter does not match");
    expect(() =>
      fromAISDK(new MockLanguageModelV3({ provider: "not-fixture", modelId: "fixture-model" }), {
        securityProfile,
        resourceProfile: resources(),
        credentialMode: "ambient_preview",
      }),
    ).toThrow("The model adapter does not match");
    expect(() =>
      fromAISDK(new MockLanguageModelV3({ provider: "fixture", modelId: "other-model" }), {
        securityProfile,
        resourceProfile: resources(),
        credentialMode: "ambient_preview",
      }),
    ).toThrow("The model adapter does not match");
    expect(() =>
      fromAISDK({} as never, {
        securityProfile,
        resourceProfile: resources(),
        credentialMode: "ambient_preview",
      }),
    ).toThrow("The model adapter does not match");
  });

  it("fails closed on input, output, event, abort, and credential limits", async () => {
    await expect(
      collect(
        fromAISDK(modelFor(["ok"]), {
          securityProfile,
          resourceProfile: resources({ maxInputBytesPerCall: 1 }),
          credentialMode: "ambient_preview",
        }),
        "too large",
      ),
    ).rejects.toMatchObject({ code: "KAF_MODEL_RESOURCE_LIMIT_EXCEEDED" });
    await expect(
      collect(
        fromAISDK(modelFor(["ok"]), {
          securityProfile,
          resourceProfile: resources({ maxInputTokensPerCall: 1 }),
          credentialMode: "ambient_preview",
        }),
        "too many token-bound bytes",
      ),
    ).rejects.toMatchObject({ code: "KAF_MODEL_RESOURCE_LIMIT_EXCEEDED" });
    await expect(
      collect(
        fromAISDK(modelFor(["large"]), {
          securityProfile,
          resourceProfile: resources({ maxStreamedOutputBytesPerCall: 1 }),
          credentialMode: "ambient_preview",
        }),
        null,
      ),
    ).rejects.toMatchObject({ code: "KAF_MODEL_RESOURCE_LIMIT_EXCEEDED" });
    await expect(
      collect(
        fromAISDK(modelFor(["large"]), {
          securityProfile,
          resourceProfile: resources({ maxRunModelOutputBytes: 1 }),
          credentialMode: "ambient_preview",
        }),
        null,
      ),
    ).rejects.toMatchObject({ code: "KAF_MODEL_RESOURCE_LIMIT_EXCEEDED" });
    await expect(
      collect(
        fromAISDK(modelFor(["a", "b"]), {
          securityProfile,
          resourceProfile: resources({ maxStreamEventsPerCall: 1 }),
          credentialMode: "ambient_preview",
        }),
        null,
      ),
    ).rejects.toMatchObject({ code: "KAF_MODEL_RESOURCE_LIMIT_EXCEEDED" });

    const compiled = fromAISDK(modelFor(["unused"]), {
      securityProfile,
      resourceProfile: resources(),
      credentialMode: "ambient_preview",
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(collect(compiled, null, controller.signal)).rejects.toThrow("cancelled");
  });
});
