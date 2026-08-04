import { z } from "zod";

import type {
  ActiveExecutionReservation,
  AdmissionRequest,
  AdmissionReservation,
} from "./admission.js";
import type { AuthorizationReservation } from "./authorization-reservation.js";
import type { CapabilityGrant, CapabilityGrantUseClaim } from "./capability.js";
import type { CommandContext, CommandRecord, CommandScope } from "./commands.js";
import type {
  Approval,
  ApprovalUseClaim,
  DecisionGate,
  DecisionRejection,
  DecisionSubmissionChallenge,
} from "./decision.js";
import type { ContextSnapshot, InputSubmissionRecord } from "./context.js";
import type { EffectRecord, ProtectedEffectResultRecord } from "./effects.js";
import type { RunEvent } from "./events.js";
import type { RunProjection } from "./run.js";
import type { ModelCallReservation } from "./model.js";
import { DigestSchema, JsonValueSchema } from "./serialization.js";
import type { AcceptedWorkOrder } from "./work-order.js";

export const RunTransitionKeySchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: z.string().trim().min(1).max(256),
    runId: z.string().trim().min(1).max(256),
    transitionKind: z.string().trim().min(1).max(256),
    transitionKey: z.string().trim().min(1).max(512),
    workOrderBindingDigest: DigestSchema,
    executionDefinitionDigest: DigestSchema,
    leaseId: z.string().trim().min(1).max(256).optional(),
    fencingToken: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RunTransitionKey = z.infer<typeof RunTransitionKeySchema>;

export const DurableWakeupRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: z.string().trim().min(1).max(256),
    runId: z.string().trim().min(1).max(256),
    reason: z.enum([
      "run_accepted",
      "resume",
      "input_submitted",
      "decision_recorded",
      "transition",
    ]),
    notBefore: z.iso.datetime({ offset: true }),
    deduplicationKey: z.string().trim().min(1).max(512),
    payload: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict();
export type DurableWakeupRequest = z.infer<typeof DurableWakeupRequestSchema>;

export const DurableWakeupReceiptSchema = z
  .object({
    schemaVersion: z.literal("1"),
    receiptId: z.string().trim().min(1).max(256),
    requestDigest: DigestSchema,
    enqueuedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DurableWakeupReceipt = z.infer<typeof DurableWakeupReceiptSchema>;

export const ProtectedInputSubmissionWriteSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: z.string().trim().min(1).max(256),
    runId: z.string().trim().min(1).max(256),
    requestId: z.string().trim().min(1).max(256),
    recordId: z.string().trim().min(1).max(256),
    recordDigest: DigestSchema,
  })
  .strict();
export type ProtectedInputSubmissionWrite = z.infer<typeof ProtectedInputSubmissionWriteSchema>;

/**
 * Compile-only transaction surface. Concrete stores provide transaction-bound
 * implementations; none of these methods may expose model, network, or tool
 * callbacks while a command transaction is open.
 */
export interface RunCommandTransaction {
  reserveAdmission(request: AdmissionRequest): Promise<AdmissionReservation>;
  putAcceptedWorkOrder(workOrder: AcceptedWorkOrder): Promise<void>;
  putInputSubmission(record: InputSubmissionRecord): Promise<void>;
  putContextSnapshot(snapshot: ContextSnapshot): Promise<void>;
  issueCapabilityGrant(grant: CapabilityGrant): Promise<void>;
  reserveCapabilityGrantUse(
    grantId: string,
    authorizationKey: string,
    at: string,
  ): Promise<CapabilityGrantUseClaim>;
  appendRunEvent(event: RunEvent): Promise<void>;
  putRunProjection(projection: RunProjection): Promise<void>;
  putCommandRecord(record: CommandRecord): Promise<void>;
  putDecisionChallenge(challenge: DecisionSubmissionChallenge): Promise<void>;
  putDecisionGate(gate: DecisionGate): Promise<void>;
  consumeDecisionChallenge(
    challengeId: string,
    commandId: string,
    consumedAt: string,
  ): Promise<void>;
  putApproval(approval: Approval): Promise<void>;
  putDecisionRejection(rejection: DecisionRejection): Promise<void>;
  claimApproval(
    approvalId: string,
    authorizationKey: string,
    at: string,
  ): Promise<ApprovalUseClaim>;
  putAuthorizationReservation(reservation: AuthorizationReservation): Promise<void>;
  putEffectRecord(record: EffectRecord): Promise<void>;
  putProtectedEffectResult(record: ProtectedEffectResultRecord): Promise<void>;
  /**
   * Atomically reserves or settles active-execution time against the tenant/run
   * aggregate. Stores must use their authoritative clock and return the
   * normalized durable record.
   */
  putActiveExecutionReservation(
    reservation: ActiveExecutionReservation,
    runMaximumActiveExecutionMs: number,
  ): Promise<ActiveExecutionReservation>;
  putModelCallReservation(reservation: ModelCallReservation): Promise<void>;
  enqueueWakeup(request: DurableWakeupRequest): Promise<DurableWakeupReceipt>;
}

export type CommandTransactionResult<T> = Readonly<{
  value: T;
  commandRecord: CommandRecord;
  replayed: boolean;
}>;

export interface RunCommandUnitOfWork {
  readonly transactionDomain: string;
  readonly atomicCommandAndWakeup: boolean;
  transactCommand<T>(
    scope: CommandScope,
    commandContext: CommandContext,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<CommandTransactionResult<T>>;
  transactTransition<T>(
    transitionKey: RunTransitionKey,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<T>;
}

export const TransactionalEffectBindingSchema = z
  .object({
    schemaVersion: z.literal("1"),
    transactionDomain: z.string().trim().min(1).max(256),
    tenantId: z.string().trim().min(1).max(256),
    runId: z.string().trim().min(1).max(256),
    effectId: z.string().trim().min(1).max(256),
    effectKey: z.string().trim().min(1).max(512),
    authorizationReservationId: z.string().trim().min(1).max(256),
    fencingToken: z.number().int().nonnegative(),
  })
  .strict();
export type TransactionalEffectBinding = z.infer<typeof TransactionalEffectBindingSchema>;

/** The sole port allowed to coordinate a registered same-domain effect callback. */
export interface TransactionCoordinator {
  readonly transactionDomain: string;
  execute<T>(
    binding: TransactionalEffectBinding,
    callback: (transaction: RunCommandTransaction) => Promise<T>,
  ): Promise<T>;
}
