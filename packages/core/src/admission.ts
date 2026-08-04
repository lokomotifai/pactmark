import { z } from "zod";

import { PrincipalSchema, TenantSchema } from "./authority.js";
import { CommandIdSchema } from "./commands.js";

export const AdmissionCategorySchema = z.enum([
  "request_start",
  "queued_run",
  "active_run",
  "model_call",
  "tool_call",
  "active_execution",
  "cost_window",
  "sse_connection",
]);
export type AdmissionCategory = z.infer<typeof AdmissionCategorySchema>;

export const QuotaMetricSchema = z.enum([
  ...AdmissionCategorySchema.options,
  "model_tokens",
  "model_io_bytes",
  "model_cost_minor",
]);
export type QuotaMetric = z.infer<typeof QuotaMetricSchema>;

export const QuotaLimitSchema = z
  .object({
    schemaVersion: z.literal("1"),
    scope: z.enum(["tenant", "principal"]).default("tenant"),
    metric: QuotaMetricSchema,
    resourceKey: z.string().trim().min(1).max(512),
    maximum: z.number().positive(),
    retryAfterSeconds: z.number().int().min(1).max(3600),
  })
  .strict();
export type QuotaLimit = z.infer<typeof QuotaLimitSchema>;

export const AdmissionReservationSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().trim().min(1).max(256),
    tenant: TenantSchema,
    principal: PrincipalSchema,
    commandId: CommandIdSchema.optional(),
    category: AdmissionCategorySchema,
    resourceKey: z.string().trim().min(1).max(512),
    amount: z.number().positive(),
    state: z.enum(["reserved", "released", "expired"]),
    fencingToken: z.number().int().nonnegative(),
    reservedAtServerTime: z.iso.datetime({ offset: true }),
    leaseExpiresAt: z.iso.datetime({ offset: true }),
    releasedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type AdmissionReservation = z.infer<typeof AdmissionReservationSchema>;

export const ActiveExecutionReservationSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().trim().min(1).max(256),
    tenant: TenantSchema,
    runId: z.string().trim().min(1).max(256),
    stepId: z.string().trim().min(1).max(256),
    boundary: z.enum(["model", "tool", "verifier", "scheduled_backoff", "runtime_internal"]),
    boundaryKey: z.string().trim().min(1).max(512),
    leaseId: z.string().trim().min(1).max(256),
    fencingToken: z.number().int().nonnegative(),
    startedAtServerTime: z.iso.datetime({ offset: true }),
    maxChargeMs: z.number().int().positive(),
    state: z.enum(["reserved", "settled", "closed_uncertain"]),
    settledChargeMs: z.number().int().nonnegative().optional(),
    refundedMs: z.number().int().nonnegative().optional(),
    settledAtServerTime: z.iso.datetime({ offset: true }).optional(),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const hasSettlement =
      value.settledChargeMs !== undefined ||
      value.refundedMs !== undefined ||
      value.settledAtServerTime !== undefined;
    if (value.state === "reserved" && hasSettlement) {
      context.addIssue({ code: "custom", message: "reserved execution cannot be settled" });
    }
    if (value.state !== "reserved") {
      if (
        value.settledChargeMs === undefined ||
        value.refundedMs === undefined ||
        value.settledAtServerTime === undefined ||
        value.settledChargeMs + value.refundedMs !== value.maxChargeMs ||
        (value.state === "closed_uncertain" &&
          (value.settledChargeMs !== value.maxChargeMs || value.refundedMs !== 0))
      ) {
        context.addIssue({ code: "custom", message: "execution settlement is inconsistent" });
      }
    }
  });
export type ActiveExecutionReservation = z.infer<typeof ActiveExecutionReservationSchema>;

export const AdmissionRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenant: TenantSchema,
    principal: PrincipalSchema,
    commandId: CommandIdSchema.optional(),
    category: AdmissionCategorySchema,
    resourceKey: z.string().trim().min(1).max(512),
    amount: z.number().positive(),
    leaseDurationMs: z.number().int().positive(),
  })
  .strict();
export type AdmissionRequest = z.infer<typeof AdmissionRequestSchema>;

export type AdmissionDecision =
  | { readonly admitted: true; readonly reservation: AdmissionReservation }
  | {
      readonly admitted: false;
      readonly code: string;
      readonly retryAfterSeconds: number;
    };

export interface AdmissionController {
  /**
   * Pure, host-owned admission policy classification. It must not mutate or
   * reserve quota; RunCommandTransaction.reserveAdmission is the sole
   * authoritative quota mutation and may invoke this callback inside a short
   * command transaction so exact command replay can bypass policy re-evaluation.
   */
  evaluate(request: AdmissionRequest): Promise<AdmissionDecision>;
}

export interface QuotaStore {
  reserve(request: AdmissionRequest): Promise<AdmissionDecision>;
  release(
    tenantId: string,
    reservationId: string,
    fencingToken: number,
    releasedAt: string,
  ): Promise<void>;
  reconcileExpired(at: string): Promise<number>;
}

export const CircuitBreakerStateSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: z.string().trim().min(1).max(256),
    providerKey: z.string().trim().min(1).max(512),
    state: z.enum(["closed", "open", "half_open"]),
    failureCount: z.number().int().nonnegative(),
    openedAt: z.iso.datetime({ offset: true }).optional(),
    probeLeaseId: z.string().trim().min(1).max(256).optional(),
    probeFencingToken: z.number().int().nonnegative().optional(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const hasLease = value.probeLeaseId !== undefined;
    const hasFence = value.probeFencingToken !== undefined;
    if (hasLease !== hasFence || (value.state === "half_open") !== hasLease) {
      context.addIssue({
        code: "custom",
        message: "half-open probe lease and fence are inconsistent",
      });
    }
  });
export type CircuitBreakerState = z.infer<typeof CircuitBreakerStateSchema>;

export interface CircuitBreakerStore {
  get(tenantId: string, providerKey: string): Promise<CircuitBreakerState | undefined>;
  compareAndSet(
    expected: CircuitBreakerState | undefined,
    next: CircuitBreakerState,
  ): Promise<boolean>;
}
