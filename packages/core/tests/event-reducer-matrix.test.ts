import { describe, expect, it } from "vitest";

import { KafError } from "../src/errors.js";
import { reduceRunEvent } from "../src/events.js";
import { createRunProjection, type Run, type RunProjection, type RunStatus } from "../src/run.js";
import { digestCanonicalJson } from "../src/serialization.js";

const digest = digestCanonicalJson("event-matrix");
const definition = {
  kind: "agent" as const,
  id: "agent",
  version: "1.0.0",
  agentDefinitionDigest: digest,
};
const compensationDefinition = {
  kind: "compensation" as const,
  id: "compensation",
  version: "1.0.0",
  compensationRunDefinitionDigest: digest,
  originalAgentDefinitionDigest: digest,
  originalEffectDigest: digest,
  compensationStrategyRegistrationDigest: digest,
  compensationToolRegistrationDigest: digest,
};
const run: Run = {
  schemaVersion: "1",
  runId: "run",
  tenantId: "tenant",
  workOrderId: "work-order",
  workOrderBindingDigest: digest,
  executionDefinition: definition,
  executionDefinitionDigest: digest,
  status: "created",
  createdAt: "2026-08-03T10:00:00Z",
  updatedAt: "2026-08-03T10:00:00Z",
  dataClass: "public",
  correlationId: "correlation",
};

function projection(status: RunStatus, extra: Partial<RunProjection> = {}): RunProjection {
  return { ...createRunProjection(run), status, ...extra };
}

function event(eventType: string, payload: object, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    eventId: `event-${eventType}`,
    runId: run.runId,
    sequence: 1,
    occurredAt: "2026-08-03T10:01:00Z",
    correlationId: run.correlationId,
    tenantId: run.tenantId,
    dataClass: run.dataClass,
    executionDefinition: definition,
    executionDefinitionDigest: digest,
    eventType,
    payload,
    ...overrides,
  };
}

describe("event reducer exhaustive state effects", () => {
  it("covers state-changing run, input, approval and suspension events", () => {
    expect(
      reduceRunEvent(
        projection("created"),
        event("RunAccepted", {
          workOrderId: "work-order",
          workOrderBindingDigest: digest,
          requiredVerifierIds: ["verifier"],
        }),
      ),
    ).toMatchObject({ status: "accepted", requiredVerifierIds: ["verifier"] });
    expect(
      reduceRunEvent(projection("accepted"), event("PlanningStarted", { stepId: "planning" })),
    ).toMatchObject({ status: "planning", currentStepId: "planning", resumeTarget: null });
    expect(
      reduceRunEvent(
        projection("planning"),
        event("InputRequested", {
          stepId: "input",
          requestId: "request",
          inputSchemaDigest: digest,
          safePrompt: "Provide value",
        }),
      ),
    ).toMatchObject({ status: "waiting_for_input", waitingRequestId: "request" });
    expect(
      reduceRunEvent(
        projection("waiting_for_input", { waitingRequestId: "request" }),
        event("InputSubmitted", {
          stepId: "input",
          requestId: "request",
          inputSubmissionRecordId: "record",
          inputSchemaDigest: digest,
          valueDigest: digest,
        }),
      ),
    ).toMatchObject({ status: "planning", waitingRequestId: null });
    expect(
      reduceRunEvent(
        projection("running"),
        event("ApprovalRequested", {
          stepId: "approval",
          decisionId: "decision",
          decisionGateDigest: digest,
          proposedEffectDigest: digest,
        }),
      ),
    ).toMatchObject({ status: "waiting_for_approval", waitingDecisionId: "decision" });
    expect(
      reduceRunEvent(
        projection("waiting_for_approval", { waitingDecisionId: "decision" }),
        event("ApprovalRecorded", {
          stepId: "approval",
          decisionId: "decision",
          approvalId: "approval",
          resumeTarget: "running",
        }),
      ),
    ).toMatchObject({ status: "running", waitingDecisionId: null });
    expect(
      reduceRunEvent(
        projection("waiting_for_approval", { waitingDecisionId: "decision" }),
        event("ApprovalRejected", {
          stepId: "approval",
          decisionId: "decision",
          nextStatus: "failed",
          reasonCode: "declined",
        }),
      ),
    ).toMatchObject({ status: "failed", waitingDecisionId: null });
    expect(
      reduceRunEvent(
        projection("running"),
        event("RunSuspended", {
          stepId: "suspend",
          resumeTarget: "verifying",
          reasonCode: "host_restart",
          effectId: "effect",
        }),
      ),
    ).toMatchObject({ status: "suspended", resumeTarget: "verifying", activeEffectId: "effect" });
  });

  it("covers model, tool, effect and artifact state-preserving branches", () => {
    const modelStarted = reduceRunEvent(
      projection("planning"),
      event("ModelCallStarted", {
        stepId: "model",
        modelCallReservationId: "reservation",
        requestDigest: digest,
      }),
    );
    expect(modelStarted.status).toBe("planning");
    expect(
      reduceRunEvent(
        projection("planning"),
        event("ModelCallCompleted", {
          stepId: "model",
          modelCallReservationId: "reservation",
          responseDigest: digest,
          finishReason: "stop",
        }),
      ).status,
    ).toBe("planning");
    expect(
      reduceRunEvent(
        projection("accepted"),
        event("ExecutionStarted", { stepId: "execute", toolCallId: "call" }),
      ),
    ).toMatchObject({ status: "running", currentStepId: "execute" });
    for (const [eventType, payload] of [
      [
        "ToolCallRequested",
        {
          stepId: "tool",
          toolCallId: "call",
          toolRegistrationDigest: digest,
          argumentsDigest: digest,
        },
      ],
      ["ToolCallCompleted", { stepId: "tool", toolCallId: "call", resultDigest: digest }],
      ["EffectDispatched", { stepId: "effect", effectId: "effect", attempt: 1 }],
      [
        "EffectUncertain",
        { stepId: "effect", effectId: "effect", uncertaintyCode: "connection_lost" },
      ],
    ] as const) {
      expect(reduceRunEvent(projection("running"), event(eventType, payload)).status).toBe(
        "running",
      );
    }
    expect(
      reduceRunEvent(
        projection("running"),
        event("EffectPrepared", {
          stepId: "effect",
          effectId: "effect",
          effectDigest: digest,
          effectKey: "effect-key",
          strategy: "native",
        }),
      ).activeEffectId,
    ).toBe("effect");
    expect(
      reduceRunEvent(
        projection("running", { activeEffectId: "effect" }),
        event("EffectAcknowledged", {
          stepId: "effect",
          effectId: "effect",
          resultDigest: digest,
          acknowledgement: {
            schemaVersion: "1",
            acknowledgementId: "acknowledgement",
            proofKind: "receiver_receipt",
            effectKey: "effect-key",
            operationKey: "operation",
            toolRegistrationDigest: digest,
            strategyRegistrationDigest: digest,
            normalizedTargetDigest: digest,
            resultSchemaDigest: digest,
            resultDigest: digest,
            proofDigest: digest,
            acknowledgedAt: "2026-08-03T10:01:00Z",
          },
        }),
      ).activeEffectId,
    ).toBeNull();
    expect(
      reduceRunEvent(
        projection("running"),
        event("ArtifactProduced", {
          stepId: "artifact",
          artifactId: "artifact",
          artifactDigest: digest,
        }),
      ).artifactIds,
    ).toEqual(["artifact"]);
  });

  it("covers reconciliation, verification, terminal and binding failures", () => {
    for (const [eventType, payload] of [
      [
        "EffectNeedsReconciliation",
        { stepId: "effect", effectId: "effect", effectMayHaveOccurred: true },
      ],
      [
        "EffectReconciliationRecorded",
        {
          stepId: "effect",
          effectId: "effect",
          resolution: "abandon_uncertain",
          commandId: "command",
        },
      ],
    ] as const) {
      expect(reduceRunEvent(projection("suspended"), event(eventType, payload)).status).toBe(
        "suspended",
      );
    }
    expect(
      reduceRunEvent(
        projection("running"),
        event("VerificationStarted", { stepId: "verify", artifactDigest: digest }),
      ),
    ).toMatchObject({ status: "verifying", resumeTarget: null });
    expect(
      reduceRunEvent(
        projection("verifying"),
        event("VerificationRecorded", {
          stepId: "verify",
          verificationId: "verification",
          verifierId: "verifier",
          status: "pass",
          verificationDigest: digest,
        }),
      ),
    ).toMatchObject({ verificationIds: ["verification"], passedVerifierIds: ["verifier"] });
    expect(
      reduceRunEvent(
        projection("verifying"),
        event("VerificationExceptionRecorded", {
          stepId: "verify",
          exceptionId: "exception",
          exceptionDigest: digest,
          verifierId: "verifier",
          verifierRegistrationDigest: digest,
          artifactDigest: digest,
          rubricVersion: "1",
          rubricDigest: digest,
          reviewerRole: "reviewer",
          expiresAt: "2026-08-04T10:00:00Z",
          reason: "documented exception",
          compensatingControls: ["manual review"],
        }),
      ).verificationExceptionIds,
    ).toEqual(["verifier"]);
    expect(() =>
      reduceRunEvent(
        projection("verifying", { requiredVerifierIds: ["verifier"] }),
        event("RunCompleted", {
          stepId: "complete",
          evidenceRecordId: "evidence",
          outputDigest: digest,
        }),
      ),
    ).toThrow(KafError);
    expect(() =>
      reduceRunEvent(
        projection("verifying", {
          requiredVerifierIds: ["verifier"],
          verificationExceptionIds: ["verifier"],
        }),
        event("RunCompleted", {
          stepId: "complete",
          evidenceRecordId: "evidence",
          outputDigest: digest,
        }),
      ),
    ).not.toThrow();
    expect(
      reduceRunEvent(
        projection("running"),
        event("RunFailed", { stepId: "failure", errorCode: "KAF_POLICY_DENIED" }),
      ).terminalErrorCode,
    ).toBe("KAF_POLICY_DENIED");
    expect(
      reduceRunEvent(
        projection("planning"),
        event("RunCancelled", { stepId: "cancel", reasonCode: "user", actorId: "user" }),
      ).status,
    ).toBe("cancelled");
    expect(() =>
      reduceRunEvent(
        projection("planning"),
        event(
          "ModelCallStarted",
          { stepId: "x", modelCallReservationId: "r", requestDigest: digest },
          { runId: "other" },
        ),
      ),
    ).toThrow(KafError);
  });

  it("rejects every compensation model/input path and covers remaining guard branches", () => {
    const compensationProjection = (status: RunStatus) =>
      projection(status, { executionDefinition: compensationDefinition });
    const compensationEvent = (eventType: string, payload: object) =>
      event(eventType, payload, { executionDefinition: compensationDefinition });

    const forbidden = [
      ["PlanningStarted", "accepted", { stepId: "step" }],
      [
        "ModelCallStarted",
        "planning",
        { stepId: "step", modelCallReservationId: "reservation", requestDigest: digest },
      ],
      [
        "ModelCallCompleted",
        "planning",
        {
          stepId: "step",
          modelCallReservationId: "reservation",
          responseDigest: digest,
          finishReason: "stop",
        },
      ],
      [
        "InputRequested",
        "planning",
        {
          stepId: "step",
          requestId: "request",
          inputSchemaDigest: digest,
          safePrompt: "Prompt",
        },
      ],
      [
        "InputSubmitted",
        "waiting_for_input",
        {
          stepId: "step",
          requestId: "request",
          inputSubmissionRecordId: "record",
          inputSchemaDigest: digest,
          valueDigest: digest,
        },
      ],
      [
        "ApprovalRecorded",
        "waiting_for_approval",
        {
          stepId: "step",
          decisionId: "decision",
          approvalId: "approval",
          resumeTarget: "planning",
        },
      ],
    ] as const;
    for (const [eventType, status, payload] of forbidden) {
      expect(() =>
        reduceRunEvent(compensationProjection(status), compensationEvent(eventType, payload)),
      ).toThrow(KafError);
    }

    expect(() =>
      reduceRunEvent(
        projection("running"),
        event("CompensationRequested", {
          stepId: "step",
          originalRunId: "run",
          originalEffectDigest: digest,
          compensationRunId: "compensation-run",
        }),
      ),
    ).toThrow(KafError);
    expect(
      reduceRunEvent(
        compensationProjection("running"),
        compensationEvent("CompensationRequested", {
          stepId: "step",
          originalRunId: "run",
          originalEffectDigest: digest,
          compensationRunId: "compensation-run",
        }),
      ).status,
    ).toBe("running");

    expect(() =>
      reduceRunEvent(
        projection("accepted"),
        event("ModelCallStarted", {
          stepId: "step",
          modelCallReservationId: "reservation",
          requestDigest: digest,
        }),
      ),
    ).toThrow(KafError);
    expect(() =>
      reduceRunEvent(projection("created"), event("PlanningStarted", { stepId: "step" })),
    ).toThrow(KafError);
    expect(() =>
      reduceRunEvent(
        projection("completed"),
        event("RunCancelled", { reasonCode: "late", actorId: "user" }),
      ),
    ).toThrow(KafError);

    for (const overrides of [
      { tenantId: "other" },
      { executionDefinitionDigest: digestCanonicalJson("other") },
      { executionDefinition: { ...definition, id: "other" } },
    ]) {
      expect(() =>
        reduceRunEvent(
          projection("planning"),
          event(
            "ModelCallStarted",
            { stepId: "step", modelCallReservationId: "reservation", requestDigest: digest },
            overrides,
          ),
        ),
      ).toThrow(KafError);
    }
    expect(
      reduceRunEvent(
        projection("running"),
        event("RunSuspended", {
          stepId: "step",
          resumeTarget: "running",
          reasonCode: "pause",
        }),
      ).activeEffectId,
    ).toBeNull();
    expect(
      reduceRunEvent(
        projection("verifying"),
        event("VerificationRecorded", {
          stepId: "step",
          verificationId: "verification",
          verifierId: "verifier",
          status: "fail",
          verificationDigest: digest,
        }),
      ).passedVerifierIds,
    ).toEqual([]);
  });
});
