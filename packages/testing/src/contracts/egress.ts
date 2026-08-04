import {
  RuntimeCapabilitiesSchema,
  type Digest,
  type EgressBroker,
  type JsonValue,
} from "@pactmark/core";

import {
  ContractRecorder,
  assertSafeErrorSurface,
  type ContractReport,
  type SafeErrorSurfaceFactory,
} from "./report.js";

export interface EgressContractCase {
  readonly request: Request;
  readonly expectedStatus?: number;
}

export interface EgressBrokerContractHarness {
  readonly broker: EgressBroker;
  readonly binding: Readonly<{
    tenantId: string;
    runId: string;
    toolRegistrationDigest: Digest;
  }>;
  readonly crossTenantBinding: Readonly<{
    tenantId: string;
    runId: string;
    toolRegistrationDigest: Digest;
  }>;
  readonly allowed?: EgressContractCase;
  readonly denied: EgressContractCase;
  readonly crossTenantDenied: EgressContractCase;
  readonly abortRequest: Request;
  readonly sensitiveErrorMarker: string;
  readonly errorSurface: SafeErrorSurfaceFactory;
  transportCallCount(): number;
}

/** Exercises schema-valid capability claims and tenant-bound declared routing. */
export async function runEgressBrokerContract(
  createHarness: () => EgressBrokerContractHarness,
): Promise<ContractReport> {
  const contract = new ContractRecorder("EgressBroker");
  const harness = createHarness();
  contract.assert(
    RuntimeCapabilitiesSchema.safeParse(harness.broker.capabilities).success,
    "capabilities-schema-valid",
  );
  contract.assert(
    harness.broker.capabilities.networkPolicy !== "none",
    "broker-advertises-network-policy",
  );
  contract.assert(harness.broker.capabilities.cancellation, "cancellation-capability-truthful");
  const client = harness.broker.bind(harness.binding);
  const baseline = harness.transportCallCount();
  if (harness.allowed !== undefined) {
    const response = await client.fetch(harness.allowed.request);
    contract.assert(
      harness.allowed.expectedStatus === undefined ||
        response.status === harness.allowed.expectedStatus,
      "allowed-request-result",
    );
    contract.assert(harness.transportCallCount() === baseline + 1, "allowed-request-dispatched");
  }
  const beforeDenied = harness.transportCallCount();
  const deniedError = await contract.captureRejection(
    () => client.fetch(harness.denied.request),
    "undeclared-request-rejected",
  );
  contract.assert(
    harness.transportCallCount() === beforeDenied,
    "undeclared-request-zero-transport",
  );
  assertSafeErrorSurface(
    contract,
    deniedError,
    harness.errorSurface,
    harness.sensitiveErrorMarker,
    "undeclared-request-safe-error",
  );

  const crossTenantClient = harness.broker.bind(harness.crossTenantBinding);
  const beforeCrossTenant = harness.transportCallCount();
  await contract.rejects(
    () => crossTenantClient.fetch(harness.crossTenantDenied.request),
    "cross-tenant-binding-rejected",
  );
  contract.assert(
    harness.transportCallCount() === beforeCrossTenant,
    "cross-tenant-binding-zero-transport",
  );

  const controller = new AbortController();
  controller.abort(new Error("contract cancellation"));
  const beforeAbort = harness.transportCallCount();
  await contract.rejects(
    () => client.fetch(harness.abortRequest, { signal: controller.signal }),
    "pre-dispatch-cancellation-rejected",
  );
  contract.assert(harness.transportCallCount() === beforeAbort, "cancelled-request-zero-transport");
  return contract.report();
}

export const ENFORCED_EGRESS_PROBES = Object.freeze([
  "ambient_fetch",
  "ambient_socket",
  "proxy",
  "subprocess",
  "alternate_address",
] as const);
export type EnforcedEgressProbe = (typeof ENFORCED_EGRESS_PROBES)[number];

export interface EnforcedEgressContractHarness {
  /** Identifies the real container, VM, remote worker, or equivalent boundary under test. */
  readonly isolationBoundary: string;
  attempt(probe: EnforcedEgressProbe, signal: AbortSignal): Promise<JsonValue>;
  connectionCount(): number;
}

/**
 * Requires every bypass probe to be blocked before a connection. The harness, not this package,
 * is responsible for mapping probes to real ambient fetch/socket/proxy/subprocess attempts.
 */
export async function runEnforcedEgressContract(
  createHarness: () => EnforcedEgressContractHarness,
): Promise<ContractReport> {
  const contract = new ContractRecorder("EnforcedEgress");
  const harness = createHarness();
  contract.assert(harness.isolationBoundary.trim().length > 0, "isolation-boundary-identified");
  const baseline = harness.connectionCount();
  for (const probe of ENFORCED_EGRESS_PROBES) {
    await contract.rejects(
      () => harness.attempt(probe, new AbortController().signal),
      `${probe}-blocked`,
    );
    contract.assert(harness.connectionCount() === baseline, `${probe}-zero-connection`);
  }
  return contract.report();
}
