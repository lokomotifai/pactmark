import { streamText, type LanguageModel } from "ai";
import aiPackage from "ai/package.json" with { type: "json" };

import {
  JsonValueSchema,
  KafError,
  ModelResourceProfileSchema,
  ModelSecurityProfileSchema,
  canonicalJsonStringify,
  defineModelAdapterRegistration,
  digestCanonicalJson,
  type JsonValue,
  type ModelDriver,
  type ModelResourceProfile,
  type ModelSecurityProfile,
  type RuntimeCapabilities,
} from "@pactmark/core";

const AI_SDK_VERSION = "7.0.48";

if (aiPackage.version !== AI_SDK_VERSION) {
  throw new KafError("KAF_MODEL_ADAPTER_MISMATCH");
}

const previewCapabilities: RuntimeCapabilities = Object.freeze({
  schemaVersion: "1",
  executionProfile: "ephemeral",
  durableStorage: false,
  protectedContext: false,
  protectedWorkOrders: false,
  protectedInputSubmissions: false,
  streaming: true,
  cancellation: true,
  sandbox: "unsafe_local",
  networkPolicy: "declared",
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: false,
  typedInput: false,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: [],
});

export interface AISDKPreviewOptions {
  readonly securityProfile: ModelSecurityProfile;
  readonly resourceProfile: ModelResourceProfile;
  readonly credentialMode: "ambient_preview";
}

export interface AISDKCompiledModel {
  readonly modelSecurityProfileDigest: string;
  readonly modelResourceProfileDigest: string;
  readonly modelAdapterRegistrationDigest: string;
  readonly modelConfig: JsonValue;
  readonly securityProfile: ModelSecurityProfile;
  readonly resourceProfile: ModelResourceProfile;
  readonly credentialMode: "ambient_preview";
  readonly driver: ModelDriver;
}

type ReadyLanguageModel = Exclude<LanguageModel, string>;

function identifyModel(model: ReadyLanguageModel): Readonly<{ provider: string; modelId: string }> {
  const candidate = model as Readonly<{ provider?: unknown; modelId?: unknown }>;
  if (typeof candidate.provider !== "string" || typeof candidate.modelId !== "string") {
    throw new KafError("KAF_MODEL_ADAPTER_MISMATCH");
  }
  return { provider: candidate.provider, modelId: candidate.modelId };
}

function enforceProfileBinding(
  identity: Readonly<{ provider: string; modelId: string }>,
  profile: ModelSecurityProfile,
): void {
  if (
    !(
      identity.provider.toLowerCase() === profile.provider.toLowerCase() ||
      identity.provider.toLowerCase().startsWith(`${profile.provider.toLowerCase()}.`)
    ) ||
    identity.modelId !== profile.model
  ) {
    throw new KafError("KAF_MODEL_ADAPTER_MISMATCH");
  }
}

function resourceError(limit: string): KafError {
  return new KafError("KAF_MODEL_RESOURCE_LIMIT_EXCEEDED", { details: { limit } });
}

function parseOutput(text: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(text);
    const result = JsonValueSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Plain text is a valid model result and remains plain text.
  }
  return text;
}

function createPreviewDriver(
  model: ReadyLanguageModel,
  profile: ModelResourceProfile,
): ModelDriver {
  return Object.freeze({
    capabilities: previewCapabilities,
    async *invoke(request: Parameters<ModelDriver["invoke"]>[0]) {
      if (request.signal.aborted) throw request.signal.reason;
      const prompt = canonicalJsonStringify(request.input);
      const inputBytes = new TextEncoder().encode(prompt).byteLength;
      if (inputBytes > profile.maxInputBytesPerCall) throw resourceError("maxInputBytesPerCall");
      // One UTF-8 byte per token is deliberately conservative.
      if (inputBytes > profile.maxInputTokensPerCall) throw resourceError("maxInputTokensPerCall");

      const result = streamText({
        model,
        prompt,
        maxOutputTokens: profile.maxOutputTokensPerCall,
        abortSignal: request.signal,
      });
      let text = "";
      let outputBytes = 0;
      let streamEvents = 0;
      for await (const delta of result.textStream) {
        streamEvents += 1;
        if (streamEvents > profile.maxStreamEventsPerCall) {
          throw resourceError("maxStreamEventsPerCall");
        }
        outputBytes += new TextEncoder().encode(delta).byteLength;
        if (outputBytes > profile.maxStreamedOutputBytesPerCall) {
          throw resourceError("maxStreamedOutputBytesPerCall");
        }
        text += delta;
      }
      if (outputBytes > profile.maxRunModelOutputBytes) {
        throw resourceError("maxRunModelOutputBytes");
      }
      yield Object.freeze({ type: "final", value: parseOutput(text) });
    },
  });
}

/**
 * Wraps a ready AI SDK model for explicit local preview. No provider object or
 * credential is serialized into the returned modelConfig.
 */
export function fromAISDK(
  model: ReadyLanguageModel,
  options: AISDKPreviewOptions,
): AISDKCompiledModel {
  const securityProfile = ModelSecurityProfileSchema.parse(options.securityProfile);
  const resourceProfile = ModelResourceProfileSchema.parse(options.resourceProfile);
  const identity = identifyModel(model);
  enforceProfileBinding(identity, securityProfile);
  const artifactDigest = digestCanonicalJson({ package: "ai", version: AI_SDK_VERSION });
  const providerArtifactDigest = digestCanonicalJson({
    provider: identity.provider,
    modelId: identity.modelId,
    mode: "ambient_preview",
  });
  const registration = defineModelAdapterRegistration({
    id: `ai-sdk.${identity.provider}@1`,
    implementationVersion: AI_SDK_VERSION,
    securityProfile,
    resourceProfile,
    credentialSlot: securityProfile.credentialSlot,
    endpointOrigin: securityProfile.endpointOrigin,
    endpointNormalizerVersion: "whatwg-origin@1",
    adapterArtifact: {
      packageName: "@pactmark/ai-sdk",
      exportName: "fromAISDK",
      packageVersion: "0.1.0",
      artifactDigest,
    },
    providerArtifact: {
      packageName: "ai",
      exportName: "LanguageModel",
      packageVersion: AI_SDK_VERSION,
      artifactDigest: providerArtifactDigest,
    },
    executorIdentity: { kind: "ai-sdk.streamText", version: AI_SDK_VERSION },
    egressEnforcementIdentity: { mode: "provider-owned-preview" },
    conservativeEstimatorIdentity: { kind: "utf8-byte-upper-bound", version: "1" },
    providerOutputCapIdentity: { setting: "maxOutputTokens", enforcement: "required" },
    streamCounterIdentity: { kind: "utf8-and-event-counter", version: "1" },
    usageTrustIdentity: { mode: "local-counts-provider-usage-untrusted", version: "1" },
    capabilityContract: previewCapabilities,
  });
  const modelConfig = JsonValueSchema.parse({
    adapter: "ai-sdk",
    adapterVersion: AI_SDK_VERSION,
    provider: identity.provider,
    modelId: identity.modelId,
    credentialMode: "ambient_preview",
  });
  return Object.freeze({
    modelSecurityProfileDigest: securityProfile.modelSecurityProfileDigest,
    modelResourceProfileDigest: resourceProfile.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: registration.modelAdapterRegistrationDigest,
    modelConfig,
    securityProfile,
    resourceProfile,
    credentialMode: "ambient_preview",
    driver: createPreviewDriver(model, resourceProfile),
  });
}
