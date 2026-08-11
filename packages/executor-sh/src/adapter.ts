import { z } from "zod";

import {
  JsonValueSchema,
  ToolRegistrationContractSchema,
  canonicalJsonStringify,
  type Digest,
  type JsonValue,
  type RuntimeCapabilities,
  type ToolExecutor,
  type ToolRegistrationContract,
} from "@pactmark/core";
import { MCPAdapterError, type MCPConnection } from "@pactmark/mcp";
import {
  ExecutorCompletedEnvelopeSchema,
  executorRegistrationFromPin,
  verifyExecutorToolPin,
  type ExecutorToolPin,
} from "./contracts.js";
import {
  verifyExecutorDeployment,
  type ExecutorDeploymentProfile,
  type ExecutorSelfHostConformanceReceipt,
} from "./deployment.js";
import { ExecutorAdapterError } from "./errors.js";

export interface ExecutorToolExecutorConfig {
  readonly connection: MCPConnection;
  readonly executeToolRegistrationDigest: Digest;
  readonly toolPins: readonly ExecutorToolPin[];
  readonly deploymentProfile: ExecutorDeploymentProfile;
  readonly conformanceReceipt: ExecutorSelfHostConformanceReceipt;
  /** Injected evaluation instant; receipt expiry is checked without ambient time access. */
  readonly evaluatedAt: string;
}

export interface ExecutorToolExecutor extends ToolExecutor {
  listRegistrations(): readonly ToolRegistrationContract[];
}

interface BoundTool {
  readonly pin: ExecutorToolPin;
  readonly registration: ToolRegistrationContract;
  readonly inputValidator: z.ZodType;
  readonly outputValidator: z.ZodType;
}

function capabilities(): RuntimeCapabilities {
  return Object.freeze({
    schemaVersion: "1",
    executionProfile: "ephemeral",
    durableStorage: false,
    protectedContext: false,
    protectedWorkOrders: false,
    protectedInputSubmissions: false,
    streaming: false,
    cancellation: true,
    sandbox: "unsafe_local",
    networkPolicy: "declared",
    backgroundWakeup: false,
    atomicCommandAndWakeup: false,
    humanDecisions: false,
    typedInput: true,
    effectReconciliation: false,
    compensation: false,
    modelCredentials: false,
    toolCredentials: true,
    telemetry: "none",
    transactionDomains: [],
  });
}

function schemaValidator(
  schema: Readonly<Record<string, JsonValue>>,
  direction: "input" | "output",
): z.ZodType {
  const serialized = canonicalJsonStringify(schema);
  const properties = schema["properties"];
  const unsafeInput =
    direction === "input" &&
    (schema["type"] !== "object" ||
      schema["additionalProperties"] !== false ||
      typeof properties !== "object" ||
      properties === null ||
      Array.isArray(properties));
  const unsafeOutput = direction === "output" && typeof schema["type"] !== "string";
  if (serialized.length > 65_536 || unsafeInput || unsafeOutput) {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_SCHEMA_UNSAFE",
      `The pinned Executor ${direction} schema is too broad or exceeds its size limit`,
    );
  }
  try {
    return z.fromJSONSchema(schema);
  } catch {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_SCHEMA_INVALID",
      `The pinned Executor ${direction} schema is not executable`,
    );
  }
}

function safeJavaScriptString(value: string): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function executorSingleCallCode(toolAddress: string, input: JsonValue): string {
  const canonicalInput = canonicalJsonStringify(JsonValueSchema.parse(input));
  return [
    `const input = JSON.parse(${safeJavaScriptString(canonicalInput)});`,
    `return await tools[${safeJavaScriptString(toolAddress)}](input);`,
  ].join("\n");
}

function connectionFailure(
  error: unknown,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): ExecutorAdapterError {
  if (signal.aborted) {
    return new ExecutorAdapterError("KAF_EXECUTOR_ABORTED", "Executor operation was cancelled");
  }
  if (timeoutSignal.aborted) {
    return new ExecutorAdapterError("KAF_EXECUTOR_TIMEOUT", "Executor operation timed out");
  }
  if (error instanceof MCPAdapterError && error.code === "KAF_MCP_ABORTED") {
    return new ExecutorAdapterError(
      "KAF_EXECUTOR_CONNECTION_FAILED",
      "The pinned Executor MCP call failed",
    );
  }
  return new ExecutorAdapterError(
    "KAF_EXECUTOR_CONNECTION_FAILED",
    "The pinned Executor MCP call failed",
  );
}

function bindTools(
  config: ExecutorToolExecutorConfig,
  deployment: ReturnType<typeof verifyExecutorDeployment>,
): ReadonlyMap<Digest, BoundTool> {
  const executeTool = config.connection
    .listExposedTools()
    .find(
      (tool) => tool.registration.toolRegistrationDigest === config.executeToolRegistrationDigest,
    );
  if (
    executeTool === undefined ||
    executeTool.toolName !== "execute" ||
    executeTool.serverIdentityDigest !== config.connection.serverIdentity.mcpServerIdentityDigest ||
    config.connection.serverIdentity.serverArtifactDigest !== deployment.receipt.imageManifestDigest
  ) {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_CONNECTION_DRIFT",
      "The MCP connection does not expose the exact pinned Executor execute tool",
    );
  }
  if (config.toolPins.length === 0) {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_PIN_DRIFT",
      "At least one reviewed Executor tool pin is required",
    );
  }
  const tools = new Map<Digest, BoundTool>();
  const registrationIds = new Set<string>();
  const addresses = new Set<string>();
  for (const untrustedPin of config.toolPins) {
    const pin = verifyExecutorToolPin(untrustedPin);
    if (
      pin.serverIdentityDigest !== config.connection.serverIdentity.mcpServerIdentityDigest ||
      pin.executeToolRegistrationDigest !== config.executeToolRegistrationDigest ||
      pin.connectionBindingDigest !== deployment.profile.connectionBindingDigest
    ) {
      throw new ExecutorAdapterError(
        "KAF_EXECUTOR_CONNECTION_DRIFT",
        "An Executor tool pin belongs to another server or execute registration",
      );
    }
    const registration = executorRegistrationFromPin(pin);
    if (
      tools.has(registration.toolRegistrationDigest) ||
      registrationIds.has(registration.id) ||
      addresses.has(pin.toolAddress)
    ) {
      throw new ExecutorAdapterError(
        "KAF_EXECUTOR_PIN_DRIFT",
        "Executor tool pins contain an ambiguous registration or address",
      );
    }
    tools.set(
      registration.toolRegistrationDigest,
      Object.freeze({
        pin,
        registration,
        inputValidator: schemaValidator(pin.inputSchema, "input"),
        outputValidator: schemaValidator(pin.outputSchema, "output"),
      }),
    );
    registrationIds.add(registration.id);
    addresses.add(pin.toolAddress);
  }
  return tools;
}

export function createExecutorToolExecutor(
  config: ExecutorToolExecutorConfig,
): ExecutorToolExecutor {
  const deployment = verifyExecutorDeployment(
    config.deploymentProfile,
    config.conformanceReceipt,
    config.evaluatedAt,
  );
  const tools = bindTools(config, deployment);
  const runtimeCapabilities = capabilities();
  return Object.freeze({
    capabilities: runtimeCapabilities,
    networkPolicy: "declared" as const,
    listRegistrations: () => Object.freeze([...tools.values()].map((tool) => tool.registration)),
    async execute(request: Parameters<ToolExecutor["execute"]>[0]): Promise<JsonValue> {
      if (request.signal.aborted) {
        throw new ExecutorAdapterError("KAF_EXECUTOR_ABORTED", "Executor operation was cancelled");
      }
      let registration: ToolRegistrationContract;
      let input: JsonValue;
      try {
        registration = ToolRegistrationContractSchema.parse(request.registration);
        input = JsonValueSchema.parse(request.input);
      } catch {
        throw new ExecutorAdapterError(
          "KAF_EXECUTOR_INPUT_INVALID",
          "Executor invocation metadata or input is malformed",
        );
      }
      const tool = tools.get(registration.toolRegistrationDigest);
      if (
        tool === undefined ||
        registration.id !== tool.registration.id ||
        registration.implementationVersion !== tool.registration.implementationVersion ||
        registration.toolRegistrationDigest !== tool.registration.toolRegistrationDigest
      ) {
        throw new ExecutorAdapterError(
          "KAF_EXECUTOR_REGISTRATION_UNKNOWN",
          "Executor invocation is not bound to a reviewed tool pin",
        );
      }
      if (!tool.inputValidator.safeParse(input).success) {
        throw new ExecutorAdapterError(
          "KAF_EXECUTOR_INPUT_INVALID",
          "Executor tool input does not match the pinned schema",
        );
      }
      let rawEnvelope: JsonValue;
      const timeoutSignal = AbortSignal.timeout(tool.pin.security.timeoutMs);
      const operationSignal = AbortSignal.any([request.signal, timeoutSignal]);
      try {
        rawEnvelope = await new Promise<JsonValue>((resolve, reject) => {
          const aborted = (): void => {
            reject(connectionFailure(operationSignal.reason, request.signal, timeoutSignal));
          };
          operationSignal.addEventListener("abort", aborted, { once: true });
          void config.connection
            .callTool(
              config.executeToolRegistrationDigest,
              { code: executorSingleCallCode(tool.pin.toolAddress, input) },
              operationSignal,
            )
            .then(resolve, reject)
            .finally(() => {
              operationSignal.removeEventListener("abort", aborted);
            });
        });
      } catch (error) {
        if (error instanceof ExecutorAdapterError) throw error;
        throw connectionFailure(error, request.signal, timeoutSignal);
      }
      if (
        typeof rawEnvelope === "object" &&
        rawEnvelope !== null &&
        !Array.isArray(rawEnvelope) &&
        "status" in rawEnvelope &&
        rawEnvelope.status !== "completed"
      ) {
        throw new ExecutorAdapterError(
          "KAF_EXECUTOR_STATUS_UNSUPPORTED",
          "The read-only Executor adapter does not resume paused or errored executions",
        );
      }
      const envelope = ExecutorCompletedEnvelopeSchema.safeParse(rawEnvelope);
      if (!envelope.success || !tool.outputValidator.safeParse(envelope.data.result).success) {
        throw new ExecutorAdapterError(
          "KAF_EXECUTOR_OUTPUT_INVALID",
          "Executor output does not match the pinned read-tool contract",
        );
      }
      return envelope.data.result;
    },
    classifyError(error: unknown) {
      if (!(error instanceof ExecutorAdapterError)) return "non_retryable";
      if (error.code === "KAF_EXECUTOR_ABORTED") return "aborted";
      if (error.code === "KAF_EXECUTOR_CONNECTION_FAILED" || error.code === "KAF_EXECUTOR_TIMEOUT")
        return "retryable";
      return "non_retryable";
    },
  });
}
