import {
  DigestSchema,
  DurableWakeupRequestSchema,
  ExecutionDefinitionRefSchema,
  PrincipalSchema,
  PurposeSchema,
  ResourceScopeSchema,
  RunLeaseSchema,
} from "@pactmark/core";
import { z } from "zod";

export const WorkerWakeupClaimSchema = z
  .object({
    schemaVersion: z.literal("1"),
    receiptId: z.string().trim().min(1).max(256),
    requestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    request: DurableWakeupRequestSchema,
    initiatingPrincipal: PrincipalSchema,
    workOrderId: z.string().trim().min(1).max(256),
    workOrderBindingDigest: DigestSchema,
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    purpose: PurposeSchema,
    maximumScopes: z.array(ResourceScopeSchema).max(256),
    lease: RunLeaseSchema,
    claimedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type WorkerWakeupClaim = z.infer<typeof WorkerWakeupClaimSchema>;

export interface PostgresWorkerQueue {
  readonly transactionDomain: string;
  readonly atomicCommandAndWakeup: boolean;
  recoverStale(now: string): Promise<number>;
  claim(
    input: Readonly<{
      holderId: string;
      now: string;
      limit: number;
      leaseTtlMs: number;
    }>,
  ): Promise<readonly WorkerWakeupClaim[]>;
  renew(claim: WorkerWakeupClaim, now: string, leaseTtlMs: number): Promise<WorkerWakeupClaim>;
  complete(
    claim: WorkerWakeupClaim,
    result: Readonly<{ status: "completed" | "parked" | "failed"; completedAt: string }>,
  ): Promise<void>;
  release(
    claim: WorkerWakeupClaim,
    retry: Readonly<{ retryAt: string; reasonCode: string }>,
  ): Promise<void>;
}
