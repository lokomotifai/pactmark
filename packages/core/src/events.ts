import { z } from "zod";
import { ExecutionDefinitionRefSchema } from "./agent.js";
import { KafError } from "./errors.js";
import { EffectAcknowledgementSchema, EffectStrategyKindSchema } from "./effects.js";
import {
  type RunProjection,
  RunProjectionSchema,
  type RunStatus,
  RUN_TRANSITIONS,
  ResumeTargetSchema,
  TerminalRunStatusSchema,
} from "./run.js";
import { DigestSchema, JsonValueSchema } from "./serialization.js";
import { DataClassSchema } from "./work-order.js";

const EventBaseSchema = z.object({
  schemaVersion: z.literal("1"),
  eventId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  tenantId: z.string().min(1),
  dataClass: DataClassSchema,
  executionDefinition: ExecutionDefinitionRefSchema,
  executionDefinitionDigest: DigestSchema,
  prevHash: DigestSchema.optional(),
});

function event<T extends string, S extends z.ZodRawShape>(eventType: T, payload: z.ZodObject<S>) {
  return EventBaseSchema.extend({ eventType: z.literal(eventType), payload }).strict();
}

const StepPayload = z.object({ stepId: z.string().min(1) }).strict();
export const RunEventSchema = z.discriminatedUnion("eventType", [
  event(
    "RunAccepted",
    z
      .object({
        workOrderId: z.string().min(1),
        workOrderBindingDigest: DigestSchema,
        requiredVerifierIds: z.array(z.string().min(1)),
      })
      .strict(),
  ),
  event("PlanningStarted", StepPayload),
  event(
    "ModelCallStarted",
    z
      .object({
        stepId: z.string().min(1),
        modelCallReservationId: z.string().min(1),
        requestDigest: DigestSchema,
      })
      .strict(),
  ),
  event(
    "ModelCallCompleted",
    z
      .object({
        stepId: z.string().min(1),
        modelCallReservationId: z.string().min(1),
        responseDigest: DigestSchema,
        finishReason: z.string().min(1),
      })
      .strict(),
  ),
  event(
    "ExecutionStarted",
    z.object({ stepId: z.string().min(1), toolCallId: z.string().min(1).optional() }).strict(),
  ),
  event(
    "ToolCallRequested",
    z
      .object({
        stepId: z.string().min(1),
        toolCallId: z.string().min(1),
        toolRegistrationDigest: DigestSchema,
        argumentsDigest: DigestSchema,
      })
      .strict(),
  ),
  event(
    "ToolCallCompleted",
    z
      .object({
        stepId: z.string().min(1),
        toolCallId: z.string().min(1),
        resultDigest: DigestSchema,
      })
      .strict(),
  ),
  event(
    "RetryScheduled",
    z
      .object({
        stepId: z.string().min(1),
        boundary: z.enum(["model", "tool"]),
        boundaryKey: z.string().min(1),
        attempt: z.number().int().positive(),
        nextAttempt: z.number().int().positive(),
        classification: z.enum(["timed_out", "retryable", "uncertain"]),
        delayMs: z.number().int().nonnegative(),
        notBefore: z.iso.datetime({ offset: true }),
      })
      .strict(),
  ),
  event(
    "RetryResumed",
    z
      .object({
        stepId: z.string().min(1),
        boundary: z.enum(["model", "tool"]),
        boundaryKey: z.string().min(1),
        attempt: z.number().int().positive(),
      })
      .strict(),
  ),
  event(
    "InputRequested",
    z
      .object({
        stepId: z.string().min(1),
        requestId: z.string().min(1),
        inputSchemaDigest: DigestSchema,
        safePrompt: z.string().min(1),
      })
      .strict(),
  ),
  event(
    "InputSubmitted",
    z
      .object({
        stepId: z.string().min(1),
        requestId: z.string().min(1),
        inputSubmissionRecordId: z.string().min(1),
        inputSchemaDigest: DigestSchema,
        valueDigest: DigestSchema,
      })
      .strict(),
  ),
  event(
    "ApprovalRequested",
    z
      .object({
        stepId: z.string().min(1),
        decisionId: z.string().min(1),
        decisionGateDigest: DigestSchema,
        proposedEffectDigest: DigestSchema,
      })
      .strict(),
  ),
  event(
    "ApprovalRecorded",
    z
      .object({
        stepId: z.string().min(1),
        decisionId: z.string().min(1),
        approvalId: z.string().min(1),
        resumeTarget: z.enum(["planning", "running"]),
      })
      .strict(),
  ),
  event(
    "ApprovalRejected",
    z
      .object({
        stepId: z.string().min(1),
        decisionId: z.string().min(1),
        nextStatus: z.enum(["planning", "failed", "cancelled"]),
        reasonCode: z.string().min(1),
      })
      .strict(),
  ),
  event(
    "EffectPrepared",
    z
      .object({
        stepId: z.string().min(1),
        effectId: z.string().min(1),
        effectDigest: DigestSchema,
        effectKey: z.string().min(1),
        strategy: EffectStrategyKindSchema,
      })
      .strict(),
  ),
  event(
    "EffectDispatched",
    z
      .object({
        stepId: z.string().min(1),
        effectId: z.string().min(1),
        attempt: z.number().int().positive(),
      })
      .strict(),
  ),
  event(
    "EffectAcknowledged",
    z
      .object({
        stepId: z.string().min(1),
        effectId: z.string().min(1),
        resultDigest: DigestSchema,
        acknowledgement: EffectAcknowledgementSchema,
      })
      .strict(),
  ),
  event(
    "EffectUncertain",
    z
      .object({
        stepId: z.string().min(1),
        effectId: z.string().min(1),
        uncertaintyCode: z.string().min(1),
      })
      .strict(),
  ),
  event(
    "EffectNeedsReconciliation",
    z
      .object({
        stepId: z.string().min(1),
        effectId: z.string().min(1),
        effectMayHaveOccurred: z.literal(true),
      })
      .strict(),
  ),
  event(
    "EffectReconciliationRecorded",
    z
      .object({
        stepId: z.string().min(1),
        effectId: z.string().min(1),
        resolution: z.enum(["recovered_acknowledgement", "abandon_uncertain"]),
        commandId: z.string().min(1),
      })
      .strict(),
  ),
  event(
    "EffectAbandoned",
    z
      .object({
        stepId: z.string().min(1),
        effectId: z.string().min(1),
        reason: z.string().min(1),
        effectMayHaveOccurred: z.literal(true),
      })
      .strict(),
  ),
  event(
    "CompensationRequested",
    z
      .object({
        stepId: z.string().min(1),
        originalRunId: z.string().min(1),
        originalEffectDigest: DigestSchema,
        compensationRunId: z.string().min(1),
      })
      .strict(),
  ),
  event(
    "EffectCompensated",
    z
      .object({
        stepId: z.string().min(1),
        originalEffectDigest: DigestSchema,
        compensationEffectDigest: DigestSchema,
        acknowledgementDigest: DigestSchema,
      })
      .strict(),
  ),
  event(
    "ArtifactProduced",
    z
      .object({
        stepId: z.string().min(1),
        artifactId: z.string().min(1),
        artifactDigest: DigestSchema,
      })
      .strict(),
  ),
  event(
    "VerificationStarted",
    z.object({ stepId: z.string().min(1), artifactDigest: DigestSchema }).strict(),
  ),
  event(
    "VerificationRecorded",
    z
      .object({
        stepId: z.string().min(1),
        verificationId: z.string().min(1),
        verifierId: z.string().min(1),
        status: z.enum(["pass", "fail", "needs_review"]),
        verificationDigest: DigestSchema,
      })
      .strict(),
  ),
  event(
    "VerificationExceptionRecorded",
    z
      .object({
        stepId: z.string().min(1),
        exceptionId: z.string().min(1),
        exceptionDigest: DigestSchema,
        verifierId: z.string().min(1),
        verifierRegistrationDigest: DigestSchema,
        artifactDigest: DigestSchema,
        rubricVersion: z.string().min(1),
        rubricDigest: DigestSchema,
        reviewerRole: z.string().min(1),
        expiresAt: z.iso.datetime({ offset: true }),
        reason: z.string().min(1),
        compensatingControls: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  ),
  event(
    "RunSuspended",
    z
      .object({
        stepId: z.string().min(1),
        resumeTarget: ResumeTargetSchema,
        reasonCode: z.string().min(1),
        effectId: z.string().min(1).optional(),
      })
      .strict(),
  ),
  event(
    "RunCompleted",
    z
      .object({
        stepId: z.string().min(1),
        evidenceRecordId: z.string().min(1),
        outputDigest: DigestSchema,
      })
      .strict(),
  ),
  event(
    "RunFailed",
    z
      .object({
        stepId: z.string().min(1).optional(),
        errorCode: z.string().regex(/^KAF_[A-Z0-9_]+$/),
        safeDetails: z.record(z.string(), JsonValueSchema).optional(),
      })
      .strict(),
  ),
  event(
    "RunCancelled",
    z
      .object({
        stepId: z.string().min(1).optional(),
        reasonCode: z.string().min(1),
        actorId: z.string().min(1),
      })
      .strict(),
  ),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent["eventType"];

const STATE_PRESERVING_EVENTS: Readonly<Partial<Record<RunStatus, readonly RunEventType[]>>> = {
  planning: ["ModelCallStarted", "ModelCallCompleted", "RetryScheduled", "RetryResumed"],
  running: [
    "ToolCallRequested",
    "ToolCallCompleted",
    "RetryScheduled",
    "RetryResumed",
    "EffectPrepared",
    "EffectDispatched",
    "EffectAcknowledged",
    "EffectUncertain",
    "ArtifactProduced",
    "CompensationRequested",
    "EffectCompensated",
  ],
  suspended: ["EffectNeedsReconciliation", "EffectReconciliationRecorded", "EffectAcknowledged"],
  verifying: ["VerificationRecorded", "VerificationExceptionRecorded"],
};

function nextStatusFor(eventValue: RunEvent): RunStatus | undefined {
  switch (eventValue.eventType) {
    case "RunAccepted":
      return "accepted";
    case "PlanningStarted":
      return "planning";
    case "ExecutionStarted":
      return "running";
    case "InputRequested":
      return "waiting_for_input";
    case "InputSubmitted":
      return "planning";
    case "ApprovalRequested":
      return "waiting_for_approval";
    case "ApprovalRecorded":
      return eventValue.payload.resumeTarget;
    case "ApprovalRejected":
      return eventValue.payload.nextStatus;
    case "VerificationStarted":
      return "verifying";
    case "RunSuspended":
      return "suspended";
    case "RunCompleted":
      return "completed";
    case "RunFailed":
      return "failed";
    case "RunCancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function assertKindAllowed(
  projection: RunProjection,
  eventValue: RunEvent,
  next: RunStatus | undefined,
): void {
  const kind = projection.executionDefinition.kind;
  if (kind === "compensation") {
    const forbidden =
      eventValue.eventType === "PlanningStarted" ||
      eventValue.eventType === "ModelCallStarted" ||
      eventValue.eventType === "ModelCallCompleted" ||
      eventValue.eventType === "InputRequested" ||
      eventValue.eventType === "InputSubmitted" ||
      next === "planning";
    if (forbidden)
      throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
        details: { reason: "compensation_has_no_model_or_input", eventType: eventValue.eventType },
      });
  }
  if (eventValue.eventType === "CompensationRequested" && kind !== "compensation") {
    // Request belongs to the newly linked compensation stream; original terminal streams stay immutable.
    throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
      details: { reason: "compensation_event_requires_compensation_run" },
    });
  }
}

export function reduceRunEvent(previous: RunProjection, input: unknown): RunProjection {
  const projection = RunProjectionSchema.parse(previous);
  const eventValue = RunEventSchema.parse(input);
  if (TerminalRunStatusSchema.safeParse(projection.status).success)
    throw new KafError("KAF_RUNTIME_TERMINAL");
  if (
    eventValue.runId !== projection.runId ||
    eventValue.tenantId !== projection.tenantId ||
    eventValue.executionDefinitionDigest !== projection.executionDefinitionDigest ||
    JSON.stringify(eventValue.executionDefinition) !==
      JSON.stringify(projection.executionDefinition)
  ) {
    throw new KafError("KAF_RUNTIME_EVENT_BINDING");
  }
  if (eventValue.sequence !== projection.lastSequence + 1)
    throw new KafError("KAF_RUNTIME_EVENT_SEQUENCE", {
      details: { expected: projection.lastSequence + 1, received: eventValue.sequence },
    });

  const next = nextStatusFor(eventValue);
  assertKindAllowed(projection, eventValue, next);
  if (next === undefined) {
    const allowed = STATE_PRESERVING_EVENTS[projection.status] ?? [];
    if (!allowed.includes(eventValue.eventType))
      throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
        details: { state: projection.status, eventType: eventValue.eventType },
      });
  } else if (!(RUN_TRANSITIONS[projection.status] as readonly RunStatus[]).includes(next)) {
    throw new KafError("KAF_RUNTIME_INVALID_TRANSITION", {
      details: { from: projection.status, to: next, eventType: eventValue.eventType },
    });
  }

  if (eventValue.eventType === "RunCompleted") {
    const satisfied = projection.requiredVerifierIds.every(
      (id) =>
        projection.passedVerifierIds.includes(id) ||
        projection.verificationExceptionIds.includes(id),
    );
    if (!satisfied) throw new KafError("KAF_VERIFICATION_REQUIRED");
  }

  const base: RunProjection = {
    ...projection,
    status: next ?? projection.status,
    lastSequence: eventValue.sequence,
    lastEventId: eventValue.eventId,
    updatedAt: eventValue.occurredAt,
  };
  switch (eventValue.eventType) {
    case "PlanningStarted":
    case "ExecutionStarted":
    case "InputRequested":
    case "InputSubmitted":
    case "ApprovalRequested":
    case "ApprovalRecorded":
    case "ApprovalRejected":
    case "VerificationStarted":
    case "RunSuspended":
    case "RunCompleted":
      base.currentStepId = eventValue.payload.stepId;
      break;
    default:
      break;
  }
  switch (eventValue.eventType) {
    case "RunAccepted":
      base.requiredVerifierIds = eventValue.payload.requiredVerifierIds;
      break;
    case "InputRequested":
      base.waitingRequestId = eventValue.payload.requestId;
      break;
    case "InputSubmitted":
      base.waitingRequestId = null;
      break;
    case "ApprovalRequested":
      base.waitingDecisionId = eventValue.payload.decisionId;
      break;
    case "ApprovalRecorded":
    case "ApprovalRejected":
      base.waitingDecisionId = null;
      break;
    case "RunSuspended":
      base.resumeTarget = eventValue.payload.resumeTarget;
      base.activeEffectId = eventValue.payload.effectId ?? null;
      break;
    case "PlanningStarted":
    case "ExecutionStarted":
    case "VerificationStarted":
      base.resumeTarget = null;
      break;
    case "EffectPrepared":
      base.activeEffectId = eventValue.payload.effectId;
      break;
    case "EffectAcknowledged":
    case "EffectAbandoned":
      base.activeEffectId = null;
      break;
    case "ArtifactProduced":
      base.artifactIds = [...base.artifactIds, eventValue.payload.artifactId];
      break;
    case "VerificationRecorded":
      base.verificationIds = [...base.verificationIds, eventValue.payload.verificationId];
      if (eventValue.payload.status === "pass")
        base.passedVerifierIds = [
          ...new Set([...base.passedVerifierIds, eventValue.payload.verifierId]),
        ];
      break;
    case "VerificationExceptionRecorded":
      base.verificationExceptionIds = [
        ...new Set([...base.verificationExceptionIds, eventValue.payload.verifierId]),
      ];
      break;
    case "RunFailed":
      base.terminalErrorCode = eventValue.payload.errorCode;
      break;
    default:
      break;
  }
  return RunProjectionSchema.parse(base);
}

export function rebuildRunProjection(
  initial: RunProjection,
  events: readonly unknown[],
): RunProjection {
  return events.reduce<RunProjection>(
    (projection, eventValue) => reduceRunEvent(projection, eventValue),
    initial,
  );
}
