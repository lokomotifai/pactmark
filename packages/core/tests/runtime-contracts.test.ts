import { describe, expect, it } from "vitest";
import { AuthorizationReservationSchema } from "../src/authorization-reservation.js";
import {
  EffectAcknowledgementSchema,
  EFFECT_TRANSITIONS,
  isEffectTransitionAllowed,
} from "../src/effects.js";
import { rebuildRunProjection, reduceRunEvent, RunEventSchema } from "../src/events.js";
import { KafError } from "../src/errors.js";
import { assertPatternPromotion, PatternManifestSchema } from "../src/patterns.js";
import { createRunProjection, RUN_TRANSITIONS, RunSchema, type RunStatus } from "../src/run.js";

const digest = `sha256:${"a".repeat(64)}`;
const definition = {
  kind: "agent" as const,
  id: "agent",
  version: "1.0.0",
  agentDefinitionDigest: digest,
};
const run = RunSchema.parse({
  schemaVersion: "1",
  runId: "run-1",
  tenantId: "tenant-1",
  workOrderId: "wo-1",
  workOrderBindingDigest: digest,
  executionDefinition: definition,
  executionDefinitionDigest: digest,
  status: "created",
  createdAt: "2026-08-03T10:00:00Z",
  updatedAt: "2026-08-03T10:00:00Z",
  dataClass: "public",
  correlationId: "corr-1",
});

function envelope(sequence: number) {
  return {
    schemaVersion: "1" as const,
    eventId: `event-${String(sequence)}`,
    runId: run.runId,
    sequence,
    occurredAt: `2026-08-03T10:00:0${String(sequence)}Z`,
    correlationId: run.correlationId,
    tenantId: run.tenantId,
    dataClass: run.dataClass,
    executionDefinition: definition,
    executionDefinitionDigest: digest,
  };
}

describe("runtime contracts", () => {
  it("rebuilds a completed projection solely from ordered events", () => {
    const events = [
      {
        ...envelope(1),
        eventType: "RunAccepted",
        payload: {
          workOrderId: "wo-1",
          workOrderBindingDigest: digest,
          requiredVerifierIds: ["schema@1"],
        },
      },
      { ...envelope(2), eventType: "PlanningStarted", payload: { stepId: "step-1" } },
      { ...envelope(3), eventType: "ExecutionStarted", payload: { stepId: "step-2" } },
      {
        ...envelope(4),
        eventType: "ArtifactProduced",
        payload: { stepId: "step-2", artifactId: "artifact-1", artifactDigest: digest },
      },
      {
        ...envelope(5),
        eventType: "VerificationStarted",
        payload: { stepId: "step-3", artifactDigest: digest },
      },
      {
        ...envelope(6),
        eventType: "VerificationRecorded",
        payload: {
          stepId: "step-3",
          verificationId: "verify-1",
          verifierId: "schema@1",
          status: "pass",
          verificationDigest: digest,
        },
      },
      {
        ...envelope(7),
        eventType: "RunCompleted",
        payload: { stepId: "step-3", evidenceRecordId: "evidence-1", outputDigest: digest },
      },
    ];
    events.forEach((value) => {
      expect(RunEventSchema.safeParse(value).success).toBe(true);
    });
    const projection = rebuildRunProjection(createRunProjection(run), events);
    expect(projection.status).toBe("completed");
    expect(projection.artifactIds).toEqual(["artifact-1"]);
    expect(projection.passedVerifierIds).toEqual(["schema@1"]);
  });

  it("rejects every unlisted run adjacency and all events after terminal state", () => {
    const statuses = Object.keys(RUN_TRANSITIONS) as RunStatus[];
    for (const from of statuses)
      for (const to of statuses) {
        expect((RUN_TRANSITIONS[from] as readonly RunStatus[]).includes(to)).toBe(
          RUN_TRANSITIONS[from].includes(to as never),
        );
      }
    const terminal = { ...createRunProjection(run), status: "completed" as const };
    expect(() =>
      reduceRunEvent(terminal, {
        ...envelope(1),
        eventType: "RunFailed",
        payload: { errorCode: "KAF_POLICY_DENIED" },
      }),
    ).toThrow(KafError);
    expect(() =>
      reduceRunEvent(createRunProjection(run), {
        ...envelope(2),
        eventType: "RunAccepted",
        payload: { workOrderId: "wo-1", workOrderBindingDigest: digest, requiredVerifierIds: [] },
      }),
    ).toThrow(/sequence/i);
  });

  it("rejects unregistered terminal error codes", () => {
    expect(
      RunEventSchema.safeParse({
        ...envelope(1),
        eventType: "RunFailed",
        payload: { errorCode: "KAF_UNREGISTERED_SENTINEL" },
      }).success,
    ).toBe(false);
  });

  it("encodes effect transitions and transactional acknowledgement exception", () => {
    expect(EFFECT_TRANSITIONS.dispatched).toEqual(["acknowledged", "unknown"]);
    expect(isEffectTransitionAllowed("prepared", "acknowledged", "transactional")).toBe(true);
    expect(isEffectTransitionAllowed("prepared", "acknowledged", "native")).toBe(false);
    expect(isEffectTransitionAllowed("compensated", "prepared", "native")).toBe(false);
  });

  it("round-trips strict acknowledgement and rejects secret/unknown fields", () => {
    const acknowledgement = EffectAcknowledgementSchema.parse({
      schemaVersion: "1",
      acknowledgementId: "ack-1",
      proofKind: "receiver_receipt",
      effectKey: "effect-key",
      toolRegistrationDigest: digest,
      strategyRegistrationDigest: digest,
      normalizedTargetDigest: digest,
      resultSchemaDigest: digest,
      resultDigest: digest,
      proofDigest: digest,
      acknowledgedAt: "2026-08-03T10:00:00Z",
    });
    expect(EffectAcknowledgementSchema.parse(JSON.parse(JSON.stringify(acknowledgement)))).toEqual(
      acknowledgement,
    );
    expect(
      EffectAcknowledgementSchema.safeParse({ ...acknowledgement, resolvedSecret: "never" })
        .success,
    ).toBe(false);
  });

  it("requires exact authorization reservation bindings", () => {
    const parsed = AuthorizationReservationSchema.safeParse({
      schemaVersion: "1",
      authorizationReservationId: "auth-1",
      authorizationKey: "key-1",
      tenantId: "tenant-1",
      runId: "run-1",
      stepId: "step-1",
      toolCallId: "call-1",
      workOrderBindingDigest: digest,
      executionDefinition: definition,
      executionDefinitionDigest: digest,
      toolId: "example.write@1",
      toolVersion: "1.0.0",
      toolRegistrationDigest: digest,
      policyRegistrationDigest: digest,
      argumentsDigest: digest,
      normalizedTargetDigest: digest,
      grantId: "grant-1",
      secretRefIds: [],
      purposeCode: "service_delivery",
      purposeRegistryVersion: "general@1",
      state: "reserved",
      createdAt: "2026-08-03T10:00:00Z",
      expiresAt: "2026-08-03T11:00:00Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("prevents one observation from becoming a proven pattern", () => {
    const pattern = PatternManifestSchema.parse({
      schemaVersion: "1",
      patternId: "p-1",
      version: "1.0.0",
      patternDigest: digest,
      title: "Pattern",
      description: "A bounded pattern",
      maturity: "repeated",
      scaleUnit: { roleFamily: "research", workflowId: "brief", riskClass: "low" },
      assetRefs: [{ kind: "agent", id: "agent", version: "1.0.0", digest }],
      evidenceRecordDigests: [digest],
      independentObservationCount: 1,
      supportedClaims: ["Produced one schema-valid brief"],
      doesNotProve: ["Business impact"],
      createdAt: "2026-08-03T10:00:00Z",
      updatedAt: "2026-08-03T10:00:00Z",
    });
    expect(() => {
      assertPatternPromotion(pattern, "proven");
    }).toThrow(KafError);
  });
});
