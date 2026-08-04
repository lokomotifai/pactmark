import { z } from "zod";
import { ExecutionDefinitionRefSchema } from "./agent.js";
import { DigestSchema } from "./serialization.js";
import { DataClassSchema } from "./work-order.js";

export const RunStatusSchema = z.enum([
  "created",
  "accepted",
  "planning",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "suspended",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const TerminalRunStatusSchema = z.enum(["completed", "failed", "cancelled"]);
export type TerminalRunStatus = z.infer<typeof TerminalRunStatusSchema>;
export const ResumeTargetSchema = z.enum(["planning", "running", "verifying"]);
export type ResumeTarget = z.infer<typeof ResumeTargetSchema>;

export const RUN_TRANSITIONS = {
  created: ["accepted", "failed"],
  accepted: ["planning", "running", "waiting_for_approval", "failed", "cancelled"],
  planning: [
    "running",
    "waiting_for_input",
    "waiting_for_approval",
    "suspended",
    "failed",
    "cancelled",
  ],
  running: [
    "planning",
    "waiting_for_input",
    "waiting_for_approval",
    "verifying",
    "suspended",
    "failed",
    "cancelled",
  ],
  waiting_for_input: ["planning", "failed", "cancelled"],
  waiting_for_approval: ["running", "planning", "failed", "cancelled"],
  suspended: ["planning", "running", "verifying", "failed", "cancelled"],
  verifying: [
    "completed",
    "planning",
    "waiting_for_input",
    "waiting_for_approval",
    "suspended",
    "failed",
    "cancelled",
  ],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Readonly<Record<RunStatus, readonly RunStatus[]>>;

export const RunSchema = z
  .object({
    schemaVersion: z.literal("1"),
    runId: z.string().min(1),
    tenantId: z.string().min(1),
    workOrderId: z.string().min(1),
    workOrderBindingDigest: DigestSchema,
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    status: RunStatusSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    dataClass: DataClassSchema,
    correlationId: z.string().min(1),
  })
  .strict();
export type Run = z.infer<typeof RunSchema>;

export const RunProjectionSchema = RunSchema.extend({
  lastSequence: z.number().int().nonnegative(),
  lastEventId: z.string().min(1).nullable(),
  currentStepId: z.string().min(1).nullable(),
  resumeTarget: ResumeTargetSchema.nullable(),
  waitingRequestId: z.string().min(1).nullable(),
  waitingDecisionId: z.string().min(1).nullable(),
  activeEffectId: z.string().min(1).nullable(),
  artifactIds: z.array(z.string().min(1)),
  verificationIds: z.array(z.string().min(1)),
  requiredVerifierIds: z.array(z.string().min(1)),
  passedVerifierIds: z.array(z.string().min(1)),
  verificationExceptionIds: z.array(z.string().min(1)),
  terminalErrorCode: z.string().min(1).nullable(),
}).strict();
export type RunProjection = z.infer<typeof RunProjectionSchema>;

export function createRunProjection(run: Run): RunProjection {
  return {
    ...run,
    lastSequence: 0,
    lastEventId: null,
    currentStepId: null,
    resumeTarget: null,
    waitingRequestId: null,
    waitingDecisionId: null,
    activeEffectId: null,
    artifactIds: [],
    verificationIds: [],
    requiredVerifierIds: [],
    passedVerifierIds: [],
    verificationExceptionIds: [],
    terminalErrorCode: null,
  };
}
