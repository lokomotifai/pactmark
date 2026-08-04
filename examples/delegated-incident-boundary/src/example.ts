import { RunDelegationDescriptorSchema, RunLeaseSchema, digestCanonicalJson } from "@pactmark/core";
import { createWorkerDelegatingAuthorityIssuer } from "@pactmark/driver-postgres-worker";
import {
  CONTRACT_EXECUTION_DEFINITION,
  CONTRACT_EXECUTION_DEFINITION_DIGEST,
  contractDigest,
} from "@pactmark/testing";

const issuedAt = "2026-01-01T00:00:00.000Z";
const expiresAt = "2026-01-01T00:05:00.000Z";

export function runDelegatedIncidentBoundary() {
  const issuer = createWorkerDelegatingAuthorityIssuer("example-worker-authority");
  const lease = RunLeaseSchema.parse({
    schemaVersion: "1",
    leaseId: "incident-lease",
    tenantId: "incident-tenant",
    runId: "incident-run",
    holderId: "worker-1",
    fencingToken: 7,
    acquiredAt: issuedAt,
    expiresAt,
    state: "active",
  });
  issuer.observeLease(lease);
  const descriptor = RunDelegationDescriptorSchema.parse({
    schemaVersion: "1",
    actor: { type: "system_worker", id: "worker-1" },
    initiatingPrincipal: { type: "user", id: "incident-owner" },
    tenant: { id: "incident-tenant" },
    runId: "incident-run",
    workOrderId: "incident-work-order",
    workOrderBindingDigest: contractDigest("incident-work-order"),
    executionDefinition: CONTRACT_EXECUTION_DEFINITION,
    executionDefinitionDigest: CONTRACT_EXECUTION_DEFINITION_DIGEST,
    purpose: { code: "service_delivery", registryVersion: "general@1" },
    maximumScopes: [
      { kind: "opaque", value: "incident-run", normalizationVersion: "example.scope@1" },
    ],
    schedulerReceiptId: "incident-receipt",
    schedulerReceiptDigest: digestCanonicalJson({ receipt: "incident-receipt" }),
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    issuedAt,
    expiresAt,
    decisionRights: [],
  });
  const authority = issuer.issueDelegated(descriptor);
  const beforeFence = issuer.verifyDelegated(authority, new Date("2026-01-01T00:01:00.000Z"));
  issuer.observeLease(RunLeaseSchema.parse({ ...lease, fencingToken: 8 }));
  const afterFence = issuer.verifyDelegated(authority, new Date("2026-01-01T00:01:01.000Z"));
  return Object.freeze({
    beforeFence,
    afterFence,
    decisionRights: descriptor.decisionRights,
    durableResumeSupported: false,
    limitationCode: "KAF_EXAMPLE_DURABLE_RESUME_UNAVAILABLE" as const,
  });
}
