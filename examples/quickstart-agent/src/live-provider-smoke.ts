import { createLocalRuntime } from "@pactmark/agent";
import { fromAISDK } from "@pactmark/ai-sdk";
import type { LanguageModel } from "ai";

import { createCatalogAgent } from "./agent.js";

type ReadyLanguageModel = Exclude<LanguageModel, string>;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new TypeError(`KAF_LIVE_${name}_REQUIRED`);
  return value;
}

function isReadyLanguageModel(value: unknown): value is ReadyLanguageModel {
  if (value === null || typeof value !== "object") return false;
  const identity = value as Readonly<{ provider?: unknown; modelId?: unknown }>;
  return typeof identity.provider === "string" && typeof identity.modelId === "string";
}

async function run(): Promise<void> {
  if (process.env["PACTMARK_ENABLE_LIVE_PROVIDER"] !== "1") {
    throw new TypeError("KAF_LIVE_PROVIDER_OPT_IN_REQUIRED");
  }
  const moduleName = requiredEnvironment("PACTMARK_LIVE_PROVIDER_MODULE");
  const exportName = requiredEnvironment("PACTMARK_LIVE_PROVIDER_EXPORT");
  const modelId = requiredEnvironment("PACTMARK_LIVE_MODEL_ID");
  const namespace: unknown = await import(moduleName);
  if (namespace === null || typeof namespace !== "object") {
    throw new TypeError("KAF_LIVE_PROVIDER_MODULE_INVALID");
  }
  const factory = (namespace as Readonly<Record<string, unknown>>)[exportName];
  if (typeof factory !== "function") throw new TypeError("KAF_LIVE_PROVIDER_EXPORT_INVALID");
  const readyModel: unknown = Reflect.apply(factory, undefined, [modelId]);
  if (!isReadyLanguageModel(readyModel)) throw new TypeError("KAF_LIVE_PROVIDER_MODEL_INVALID");

  const agent = createCatalogAgent(fromAISDK(readyModel));
  const result = await createLocalRuntime({ agents: [agent] }).run(agent, {
    goal: "Check availability of SKU P-100 and return only the required JSON.",
    input: { sku: "P-100" },
  });
  const eventTypes = result.events.map(({ eventType }) => eventType);
  if (
    result.status !== "completed" ||
    !eventTypes.includes("ToolCallCompleted") ||
    !eventTypes.includes("VerificationRecorded")
  ) {
    throw new TypeError("KAF_LIVE_PROVIDER_SMOKE_INCOMPLETE");
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: "1",
      status: result.status,
      provider: readyModel.provider,
      modelId: readyModel.modelId,
      eventTypes,
      evidenceProduced: result.evidence !== undefined,
    })}\n`,
  );
}

try {
  await run();
} catch (error) {
  const code =
    error instanceof TypeError && /^KAF_[A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : "KAF_LIVE_PROVIDER_SMOKE_FAILED";
  process.stderr.write(`${JSON.stringify({ schemaVersion: "1", code })}\n`);
  process.exitCode = 1;
}
