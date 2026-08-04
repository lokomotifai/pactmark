import { performance } from "node:perf_hooks";

import {
  createRunProjection,
  digestCanonicalJson,
  reduceRunEvent,
  type RunEvent,
  type RunProjection,
} from "@pactmark/core";

export interface ProjectionBenchmarkResult {
  readonly schemaVersion: "1";
  readonly benchmark: "event-projection";
  readonly eventCount: number;
  readonly finalSequence: number;
  readonly finalStatus: string;
  readonly elapsedMilliseconds: number;
  readonly rssDeltaBytes: number;
  readonly method: string;
}

const instant = Date.parse("2026-01-01T00:00:00.000Z");
const executionDefinition = Object.freeze({
  kind: "agent" as const,
  id: "projection-benchmark",
  version: "1.0.0",
  agentDefinitionDigest: digestCanonicalJson({ agent: "projection-benchmark@1" }),
});
const executionDefinitionDigest = digestCanonicalJson(executionDefinition);
const workOrderBindingDigest = digestCanonicalJson({ workOrder: "projection-benchmark@1" });
const valueDigest = digestCanonicalJson({ value: "fixture" });

function base(sequence: number) {
  return {
    schemaVersion: "1" as const,
    eventId: `benchmark-event-${String(sequence)}`,
    runId: "benchmark-run",
    sequence,
    occurredAt: new Date(instant + sequence).toISOString(),
    correlationId: "benchmark-correlation",
    tenantId: "benchmark-tenant",
    dataClass: "internal" as const,
    executionDefinition,
    executionDefinitionDigest,
  };
}

function eventAt(sequence: number): RunEvent {
  if (sequence === 1)
    return {
      ...base(sequence),
      eventType: "RunAccepted",
      payload: {
        workOrderId: "benchmark-work-order",
        workOrderBindingDigest,
        requiredVerifierIds: [],
      },
    };
  if (sequence === 2 || (sequence - 3) % 6 === 5)
    return {
      ...base(sequence),
      eventType: "PlanningStarted",
      payload: { stepId: `step-${String(sequence)}` },
    };
  const phase = (sequence - 3) % 6;
  if (phase === 0)
    return {
      ...base(sequence),
      eventType: "ModelCallStarted",
      payload: {
        stepId: `step-${String(sequence)}`,
        modelCallReservationId: `reservation-${String(sequence)}`,
        requestDigest: valueDigest,
      },
    };
  if (phase === 1)
    return {
      ...base(sequence),
      eventType: "ModelCallCompleted",
      payload: {
        stepId: `step-${String(sequence - 1)}`,
        modelCallReservationId: `reservation-${String(sequence - 1)}`,
        responseDigest: valueDigest,
        finishReason: "tool_call",
      },
    };
  if (phase === 2)
    return {
      ...base(sequence),
      eventType: "ExecutionStarted",
      payload: { stepId: `step-${String(sequence)}`, toolCallId: `tool-call-${String(sequence)}` },
    };
  if (phase === 3)
    return {
      ...base(sequence),
      eventType: "ToolCallRequested",
      payload: {
        stepId: `step-${String(sequence - 1)}`,
        toolCallId: `tool-call-${String(sequence - 1)}`,
        toolRegistrationDigest: valueDigest,
        argumentsDigest: valueDigest,
      },
    };
  return {
    ...base(sequence),
    eventType: "ToolCallCompleted",
    payload: {
      stepId: `step-${String(sequence - 2)}`,
      toolCallId: `tool-call-${String(sequence - 2)}`,
      resultDigest: valueDigest,
    },
  };
}

export function runProjectionBenchmark(eventCount = 10_000): ProjectionBenchmarkResult {
  if (!Number.isSafeInteger(eventCount) || eventCount < 2)
    throw new TypeError("KAF_BENCH_EVENT_COUNT_INVALID");
  let projection: RunProjection = createRunProjection({
    schemaVersion: "1",
    runId: "benchmark-run",
    tenantId: "benchmark-tenant",
    workOrderId: "benchmark-work-order",
    workOrderBindingDigest,
    executionDefinition,
    executionDefinitionDigest,
    status: "created",
    createdAt: new Date(instant).toISOString(),
    updatedAt: new Date(instant).toISOString(),
    dataClass: "internal",
    correlationId: "benchmark-correlation",
  });
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  for (let sequence = 1; sequence <= eventCount; sequence += 1)
    projection = reduceRunEvent(projection, eventAt(sequence));
  const elapsedMilliseconds = performance.now() - started;
  return Object.freeze({
    schemaVersion: "1",
    benchmark: "event-projection",
    eventCount,
    finalSequence: projection.lastSequence,
    finalStatus: projection.status,
    elapsedMilliseconds,
    rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
    method:
      "Single process; generated valid RunEvent objects; public reduceRunEvent with runtime schema validation on every event; wall clock via performance.now",
  });
}
