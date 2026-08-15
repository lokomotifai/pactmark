import { jsonSchema, streamText, tool, type LanguageModel, type ToolSet } from "ai";
import aiPackage from "ai/package.json" with { type: "json" };

import {
  JsonValueSchema,
  KafError,
  ModelResourceProfileSchema,
  ModelSecurityProfileSchema,
  canonicalJsonStringify,
  defineModelAdapterRegistration,
  defineModelResourceProfile,
  defineModelSecurityProfile,
  digestCanonicalJson,
  type JsonValue,
  type ModelAgentContext,
  type ModelDriver,
  type ModelResourceProfile,
  type ModelSecurityProfile,
  type RuntimeCapabilities,
} from "@pactmark/core";

export const AI_SDK_TESTED_RANGE = ">=7.0.48 <8";

/** Throws `KAF_MODEL_ADAPTER_MISMATCH` when the version is outside the tested range. */
export function assertSupportedAiSdkVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const major = match === null ? Number.NaN : Number(match[1]);
  const minor = match === null ? Number.NaN : Number(match[2]);
  const patch = match === null ? Number.NaN : Number(match[3]);
  const supported =
    major === 7 && (minor > 0 || patch >= 48) && Number.isFinite(minor) && Number.isFinite(patch);
  if (!supported) {
    throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
      details: { installed: version, tested: AI_SDK_TESTED_RANGE },
    });
  }
  return version;
}

const AI_SDK_VERSION = assertSupportedAiSdkVersion(aiPackage.version);

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
  readonly securityProfile?: ModelSecurityProfile;
  readonly resourceProfile?: ModelResourceProfile;
  readonly credentialMode?: "ambient_preview";
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
  readonly bindAgentContext: (context: ModelAgentContext) => ModelDriver;
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

/**
 * Unreviewed-local-preview claims only: this profile records that no provider
 * terms review happened. A host that has reviewed real provider terms must
 * pass an explicit profile instead.
 */
function defaultSecurityProfile(
  identity: Readonly<{ provider: string; modelId: string }>,
): ModelSecurityProfile {
  return defineModelSecurityProfile({
    id: `ai-sdk.${identity.provider}.${identity.modelId}@preview`,
    provider: identity.provider,
    model: identity.modelId,
    endpointOrigin: "https://provider-owned-preview.invalid",
    credentialSlot: "ambient.preview",
    allowedTenants: ["local"],
    allowedPurposes: ["service_delivery"],
    allowedDataClasses: ["public"],
    processingRegion: "provider_managed",
    retention: "unreviewed",
    logging: "unreviewed",
    training: "unreviewed",
    contractReference: "unreviewed-local-preview",
  });
}

function defaultResourceProfile(
  identity: Readonly<{ provider: string; modelId: string }>,
): ModelResourceProfile {
  return defineModelResourceProfile({
    id: `ai-sdk.${identity.provider}.${identity.modelId}.resources@preview`,
    implementationVersion: "1.0.0",
    maxInputBytesPerCall: 262_144,
    maxInputTokensPerCall: 262_144,
    maxOutputTokensPerCall: 4_096,
    maxStreamedOutputBytesPerCall: 262_144,
    maxStreamEventsPerCall: 8_192,
    maxToolResultToContextBytes: 65_536,
    maxContextSnapshotBytes: 262_144,
    maxRunModelInputBytes: 2_097_152,
    maxRunModelInputTokens: 2_097_152,
    maxRunModelOutputBytes: 2_097_152,
    maxRunModelOutputTokens: 65_536,
    maxRunToolResultToContextBytes: 262_144,
    estimator: "pactmark.utf8-byte-upper-bound@1",
    providerOutputCap: "enforced",
  });
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

type AdvertisedTool = Readonly<{
  providerName: string;
  toolRegistrationDigest: string;
  definition: ModelAgentContext["tools"][number];
}>;

/**
 * Provider tool-name alphabets are narrower than Pactmark tool ids, so ids are
 * projected deterministically onto `[a-zA-Z0-9_-]` with collision suffixes.
 */
function advertiseTools(context: ModelAgentContext): readonly AdvertisedTool[] {
  const used = new Set<string>();
  return context.tools.map((definition) => {
    const base = definition.id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 56) || "tool";
    let providerName = base;
    let suffix = 1;
    while (used.has(providerName)) {
      suffix += 1;
      providerName = `${base}_${String(suffix)}`;
    }
    used.add(providerName);
    return Object.freeze({
      providerName,
      toolRegistrationDigest: definition.toolRegistrationDigest,
      definition,
    });
  });
}

function boundSystemText(context: ModelAgentContext): string {
  const instructionText = context.instructions.entries.map((entry) => entry.text).join("\n\n");
  return [
    instructionText,
    [
      "You operate inside a governed Pactmark run.",
      "You may call the provided tools; the host validates and authorizes every proposal before any effect happens.",
      "When the task is complete, reply with only JSON that conforms to this output schema " +
        `(${context.output.schemaId}): ${canonicalJsonStringify(context.output.jsonSchema)}`,
    ].join("\n"),
  ].join("\n\n");
}

function createDriver(
  model: ReadyLanguageModel,
  profile: ModelResourceProfile,
  context?: ModelAgentContext,
): ModelDriver {
  const advertised = context === undefined ? [] : advertiseTools(context);
  const system = context === undefined ? undefined : boundSystemText(context);
  const staticInputBytes =
    (system === undefined ? 0 : utf8Bytes(system)) +
    advertised.reduce(
      (total, entry) =>
        total +
        utf8Bytes(entry.providerName) +
        utf8Bytes(entry.definition.description) +
        utf8Bytes(canonicalJsonStringify(entry.definition.inputJsonSchema)),
      0,
    );
  const tools: ToolSet = Object.fromEntries(
    advertised.map((entry) => [
      entry.providerName,
      tool({
        description: entry.definition.description,
        // The canonical draft 2020-12 schema from defineSchema is structurally
        // a JSONSchema7 document; the AI SDK type is narrower than JsonValue.
        inputSchema: jsonSchema(
          entry.definition.inputJsonSchema as Parameters<typeof jsonSchema>[0],
        ),
      }),
    ]),
  );
  return Object.freeze({
    capabilities: previewCapabilities,
    async *invoke(request: Parameters<ModelDriver["invoke"]>[0]) {
      if (request.signal.aborted) throw request.signal.reason;
      const prompt = canonicalJsonStringify(request.input);
      const inputBytes = staticInputBytes + utf8Bytes(prompt);
      if (inputBytes > profile.maxInputBytesPerCall) throw resourceError("maxInputBytesPerCall");
      // One UTF-8 byte per token is deliberately conservative.
      if (inputBytes > profile.maxInputTokensPerCall) throw resourceError("maxInputTokensPerCall");

      const result = streamText({
        model,
        ...(system === undefined ? {} : { system }),
        prompt,
        ...(advertised.length === 0 ? {} : { tools, toolChoice: "auto" as const }),
        maxOutputTokens: profile.maxOutputTokensPerCall,
        abortSignal: request.signal,
      });
      let text = "";
      let outputBytes = 0;
      let streamEvents = 0;
      const countEvent = (): void => {
        streamEvents += 1;
        if (streamEvents > profile.maxStreamEventsPerCall) {
          throw resourceError("maxStreamEventsPerCall");
        }
      };
      const countOutputBytes = (bytes: number): void => {
        outputBytes += bytes;
        if (outputBytes > profile.maxStreamedOutputBytesPerCall) {
          throw resourceError("maxStreamedOutputBytesPerCall");
        }
      };
      if (advertised.length === 0) {
        for await (const delta of result.textStream) {
          countEvent();
          countOutputBytes(utf8Bytes(delta));
          text += delta;
        }
      } else {
        for await (const part of result.stream) {
          countEvent();
          if (part.type === "error") throw part.error;
          if (part.type === "abort") throw request.signal.reason ?? new Error("aborted");
          if (part.type === "text-delta") {
            countOutputBytes(utf8Bytes(part.text));
            text += part.text;
            continue;
          }
          if (part.type === "tool-call") {
            const entry = advertised.find((candidate) => candidate.providerName === part.toolName);
            if (entry === undefined) {
              throw new KafError("KAF_MODEL_ADAPTER_MISMATCH", {
                details: { reason: "unadvertised_tool_proposal" },
              });
            }
            const proposedInput = JsonValueSchema.parse(part.input);
            countOutputBytes(utf8Bytes(canonicalJsonStringify(proposedInput)));
            // The host discards this digest as authority and re-resolves the
            // normalized target itself; it is required wire shape only.
            yield Object.freeze({
              type: "tool_call",
              value: {
                toolRegistrationDigest: entry.toolRegistrationDigest,
                input: proposedInput,
                targetDigest: digestCanonicalJson(proposedInput),
              },
            });
            return;
          }
        }
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
 * credential is serialized into the returned modelConfig. When the facade
 * binds an agent context, tools are advertised to the provider as schemas
 * only — never as executable callbacks — and provider tool calls surface as
 * governed `tool_call` proposals.
 */
export function fromAISDK(
  model: ReadyLanguageModel,
  options: AISDKPreviewOptions = {},
): AISDKCompiledModel {
  const identity = identifyModel(model);
  const securityProfile = ModelSecurityProfileSchema.parse(
    options.securityProfile ?? defaultSecurityProfile(identity),
  );
  const resourceProfile = ModelResourceProfileSchema.parse(
    options.resourceProfile ?? defaultResourceProfile(identity),
  );
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
    driver: createDriver(model, resourceProfile),
    bindAgentContext: (context: ModelAgentContext) => createDriver(model, resourceProfile, context),
  });
}
