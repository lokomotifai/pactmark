import { DigestSchema, JsonValueSchema, type Digest, type JsonValue } from "@pactmark/core";

import {
  ContractRecorder,
  assertSafeErrorSurface,
  sameValue,
  type ContractReport,
  type SafeErrorSurfaceFactory,
} from "./report.js";

/**
 * Structural harness for MCP-like adapters. Callers map their connection/session API onto these
 * probes so this package never needs a protocol SDK or a production-adapter dependency.
 */
export interface MCPUntrustedToolAdapterContractHarness {
  readonly exposedToolDigest: Digest;
  readonly unexposedToolDigest: Digest;
  readonly input: JsonValue;
  readonly expectedOutput: JsonValue;
  readonly malformedResponseInput: JsonValue;
  readonly failureInput: JsonValue;
  readonly sensitiveErrorMarker: string;
  readonly declaredCancellation: boolean;
  readonly errorSurface: SafeErrorSurfaceFactory;
  callAuthorized(input: unknown, signal: AbortSignal): Promise<unknown>;
  callUnexposed(toolDigest: Digest, signal: AbortSignal): Promise<unknown>;
  callCrossTenant(signal: AbortSignal): Promise<unknown>;
  protocolDispatchCount(): number;
}

/**
 * Treats discovery, tool results, and tool errors as untrusted protocol data and verifies that
 * authorization, tenant binding, validation, and abort all happen before unauthorized dispatch.
 */
export async function runMCPUntrustedToolAdapterContract(
  createHarness: () => MCPUntrustedToolAdapterContractHarness,
): Promise<ContractReport> {
  const contract = new ContractRecorder("MCPUntrustedToolAdapter");
  const harness = createHarness();
  contract.assert(
    DigestSchema.safeParse(harness.exposedToolDigest).success,
    "exposed-digest-valid",
  );
  contract.assert(
    DigestSchema.safeParse(harness.unexposedToolDigest).success &&
      harness.unexposedToolDigest !== harness.exposedToolDigest,
    "unexposed-digest-valid",
  );
  contract.assert(JsonValueSchema.safeParse(harness.input).success, "input-schema-valid");
  contract.assert(JsonValueSchema.safeParse(harness.expectedOutput).success, "output-schema-valid");
  contract.assert(harness.declaredCancellation, "cancellation-capability-declared");

  const baseline = harness.protocolDispatchCount();
  const output = await harness.callAuthorized(
    structuredClone(harness.input),
    new AbortController().signal,
  );
  contract.assert(JsonValueSchema.safeParse(output).success, "authorized-output-schema-valid");
  contract.assert(sameValue(output, harness.expectedOutput), "authorized-result");
  contract.assert(harness.protocolDispatchCount() === baseline + 1, "authorized-single-dispatch");

  await contract.rejects(
    () => harness.callUnexposed(harness.unexposedToolDigest, new AbortController().signal),
    "unexposed-tool-rejected",
  );
  contract.assert(harness.protocolDispatchCount() === baseline + 1, "unexposed-tool-zero-dispatch");

  await contract.rejects(
    () => harness.callCrossTenant(new AbortController().signal),
    "cross-tenant-binding-rejected",
  );
  contract.assert(
    harness.protocolDispatchCount() === baseline + 1,
    "cross-tenant-binding-zero-dispatch",
  );

  await contract.rejects(
    () => harness.callAuthorized(undefined, new AbortController().signal),
    "malformed-input-rejected",
  );
  contract.assert(
    harness.protocolDispatchCount() === baseline + 1,
    "malformed-input-zero-dispatch",
  );

  const controller = new AbortController();
  controller.abort(new Error("contract cancellation"));
  await contract.rejects(
    () => harness.callAuthorized(harness.input, controller.signal),
    "pre-dispatch-cancellation-rejected",
  );
  contract.assert(harness.protocolDispatchCount() === baseline + 1, "abort-zero-dispatch");

  await contract.rejects(
    () => harness.callAuthorized(harness.malformedResponseInput, new AbortController().signal),
    "malformed-protocol-response-rejected",
  );
  contract.assert(
    harness.protocolDispatchCount() === baseline + 2,
    "malformed-response-single-dispatch",
  );

  const failure = await contract.captureRejection(
    () => harness.callAuthorized(harness.failureInput, new AbortController().signal),
    "upstream-failure-rejected",
  );
  contract.assert(harness.protocolDispatchCount() === baseline + 3, "failure-single-dispatch");
  assertSafeErrorSurface(
    contract,
    failure,
    harness.errorSurface,
    harness.sensitiveErrorMarker,
    "upstream-safe-error",
  );
  return contract.report();
}
