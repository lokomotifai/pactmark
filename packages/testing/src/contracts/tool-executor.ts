import {
  JsonValueSchema,
  RuntimeCapabilitiesSchema,
  ToolRegistrationContractSchema,
  type JsonValue,
  type ToolExecutor,
  type ToolRegistrationContract,
} from "@pactmark/core";

import {
  ContractRecorder,
  assertSafeErrorSurface,
  sameValue,
  type ContractReport,
  type SafeErrorSurfaceFactory,
} from "./report.js";

export interface ToolExecutorContractHarness {
  readonly executor: ToolExecutor;
  readonly registeredTool: ToolRegistrationContract;
  readonly unknownTool: ToolRegistrationContract;
  readonly input: JsonValue;
  readonly expectedOutput: JsonValue;
  readonly malformedOutputInput: JsonValue;
  readonly failureInput: JsonValue;
  readonly sensitiveErrorMarker: string;
  readonly errorSurface: SafeErrorSurfaceFactory;
  dispatchCount(): number;
}

/**
 * Verifies runtime schemas, exact digest dispatch, fail-closed lookup, cancellation, capability
 * claims, and a caller-defined public error serialization that cannot expose a sensitive marker.
 */
export async function runToolExecutorContract(
  createHarness: () => ToolExecutorContractHarness,
): Promise<ContractReport> {
  const contract = new ContractRecorder("ToolExecutor");
  const harness = createHarness();
  contract.assert(
    RuntimeCapabilitiesSchema.safeParse(harness.executor.capabilities).success,
    "capabilities-schema-valid",
  );
  contract.assert(
    ToolRegistrationContractSchema.safeParse(harness.registeredTool).success &&
      ToolRegistrationContractSchema.safeParse(harness.unknownTool).success,
    "registration-schemas-valid",
  );
  contract.assert(
    harness.executor.networkPolicy === harness.executor.capabilities.networkPolicy,
    "network-policy-capability-aligned",
  );
  contract.assert(harness.executor.capabilities.cancellation, "cancellation-capability-truthful");

  const baseline = harness.dispatchCount();
  const input = structuredClone(harness.input);
  const output = await harness.executor.execute({
    registration: harness.registeredTool,
    input,
    signal: new AbortController().signal,
  });
  contract.assert(JsonValueSchema.safeParse(output).success, "registered-tool-output-schema-valid");
  contract.assert(sameValue(output, harness.expectedOutput), "registered-tool-result");
  contract.assert(harness.dispatchCount() === baseline + 1, "single-dispatch");
  contract.assert(sameValue(input, harness.input), "caller-input-not-mutated");

  await contract.rejects(
    () =>
      harness.executor.execute({
        registration: harness.unknownTool,
        input: harness.input,
        signal: new AbortController().signal,
      }),
    "unknown-registration-rejected",
  );
  contract.assert(harness.dispatchCount() === baseline + 1, "unknown-registration-zero-dispatch");

  const executeUntrusted = harness.executor.execute.bind(harness.executor) as unknown as (request: {
    readonly registration: unknown;
    readonly input: unknown;
    readonly signal: AbortSignal;
  }) => Promise<unknown>;
  await contract.rejects(
    () =>
      executeUntrusted({
        registration: { ...harness.registeredTool, toolRegistrationDigest: "not-a-digest" },
        input: harness.input,
        signal: new AbortController().signal,
      }),
    "malformed-registration-rejected",
  );
  contract.assert(harness.dispatchCount() === baseline + 1, "malformed-registration-zero-dispatch");
  await contract.rejects(
    () =>
      executeUntrusted({
        registration: harness.registeredTool,
        input: undefined,
        signal: new AbortController().signal,
      }),
    "malformed-input-rejected",
  );
  contract.assert(harness.dispatchCount() === baseline + 1, "malformed-input-zero-dispatch");

  const controller = new AbortController();
  controller.abort(new Error("contract cancellation"));
  await contract.rejects(
    () =>
      harness.executor.execute({
        registration: harness.registeredTool,
        input: harness.input,
        signal: controller.signal,
      }),
    "pre-dispatch-cancellation-rejected",
  );
  contract.assert(harness.dispatchCount() === baseline + 1, "cancelled-call-zero-dispatch");

  await contract.rejects(
    () =>
      harness.executor.execute({
        registration: harness.registeredTool,
        input: harness.malformedOutputInput,
        signal: new AbortController().signal,
      }),
    "malformed-output-rejected",
  );
  contract.assert(harness.dispatchCount() === baseline + 2, "malformed-output-single-dispatch");

  const failure = await contract.captureRejection(
    () =>
      harness.executor.execute({
        registration: harness.registeredTool,
        input: harness.failureInput,
        signal: new AbortController().signal,
      }),
    "registered-tool-failure-rejected",
  );
  contract.assert(harness.dispatchCount() === baseline + 3, "failing-tool-single-dispatch");
  assertSafeErrorSurface(
    contract,
    failure,
    harness.errorSurface,
    harness.sensitiveErrorMarker,
    "registered-tool-safe-error",
  );
  return contract.report();
}
