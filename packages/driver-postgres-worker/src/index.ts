import {
  KafError,
  RunDelegationDescriptorSchema,
  RunLeaseSchema,
  RuntimeCapabilitiesSchema,
  createAuthorityIssuer,
  type AuthorityContext,
  type AuthorityIssuer,
  type DelegatedAuthorityVerification,
  type DelegatedRunAuthority,
  type DelegatingAuthorityIssuer,
  type DurableWakeupRequest,
  type RunDelegationDescriptor,
  type RunDriver,
  type RunLease,
  type RuntimeCapabilities,
} from "@pactmark/core";
import { z } from "zod";

import {
  WorkerWakeupClaimSchema,
  type PostgresWorkerQueue,
  type WorkerWakeupClaim,
} from "./worker-queue-contracts.js";

export {
  WorkerWakeupClaimSchema,
  type PostgresWorkerQueue,
  type WorkerWakeupClaim,
} from "./worker-queue-contracts.js";

export interface WorkerDelegatingAuthorityIssuer extends DelegatingAuthorityIssuer {
  observeLease(lease: RunLease): void;
  invalidateSchedulerReceipt(receiptId: string): void;
}

type DelegatedState = Readonly<{
  authority: AuthorityContext;
  descriptor: RunDelegationDescriptor;
}>;

export function createWorkerDelegatingAuthorityIssuer(
  issuerId: string,
): WorkerDelegatingAuthorityIssuer {
  const base = createAuthorityIssuer(issuerId);
  const issued = new WeakMap<object, DelegatedState>();
  const leases = new Map<string, Readonly<{ leaseId: string; fencingToken: number }>>();
  const invalidReceipts = new Set<string>();
  const leaseKey = (tenantId: string, runId: string): string => `${tenantId}\u0000${runId}`;
  const issue: AuthorityIssuer["issue"] = (claims) => base.issue(claims);
  const verify: AuthorityIssuer["verify"] = (authority, at) => base.verify(authority, at);

  return Object.freeze({
    issuerId: base.issuerId,
    issue,
    verify,
    observeLease(leaseInput: RunLease): void {
      const lease = RunLeaseSchema.parse(leaseInput);
      const key = leaseKey(lease.tenantId, lease.runId);
      const current = leases.get(key);
      if (current !== undefined && lease.fencingToken < current.fencingToken) {
        throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT");
      }
      leases.set(key, { leaseId: lease.leaseId, fencingToken: lease.fencingToken });
    },
    invalidateSchedulerReceipt(receiptId: string): void {
      invalidReceipts.add(z.string().trim().min(1).max(256).parse(receiptId));
    },
    issueDelegated(input: RunDelegationDescriptor): DelegatedRunAuthority {
      const descriptor = RunDelegationDescriptorSchema.parse(input);
      const active = leases.get(leaseKey(descriptor.tenant.id, descriptor.runId));
      if (
        active === undefined ||
        active.leaseId !== descriptor.leaseId ||
        active.fencingToken !== descriptor.fencingToken
      ) {
        throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT");
      }
      if (invalidReceipts.has(descriptor.schedulerReceiptId)) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH");
      }
      const authority = base.issue({
        actor: descriptor.actor,
        subject: descriptor.initiatingPrincipal,
        tenant: descriptor.tenant,
        authenticatedAt: descriptor.issuedAt,
        authenticationStrength: "phishing_resistant",
        decisionRoles: [],
        requestCorrelationId: descriptor.schedulerReceiptId,
        issuedAt: descriptor.issuedAt,
        expiresAt: descriptor.expiresAt,
        runScope: { runId: descriptor.runId, workOrderId: descriptor.workOrderId },
      });
      issued.set(authority, { authority, descriptor });
      return authority as DelegatedRunAuthority;
    },
    verifyDelegated(authority: unknown, at: Date): DelegatedAuthorityVerification {
      if (
        (typeof authority !== "object" && typeof authority !== "function") ||
        authority === null
      ) {
        return { valid: false, reason: "not_issued" };
      }
      const state = issued.get(authority);
      if (state === undefined) return { valid: false, reason: "not_issued" };
      const verified = base.verify(state.authority, at);
      if (!verified.valid) {
        return { valid: false, reason: verified.reason === "expired" ? "expired" : "other_issuer" };
      }
      if (invalidReceipts.has(state.descriptor.schedulerReceiptId)) {
        return { valid: false, reason: "scheduler_receipt_mismatch" };
      }
      const active = leases.get(leaseKey(state.descriptor.tenant.id, state.descriptor.runId));
      if (active === undefined || active.leaseId !== state.descriptor.leaseId) {
        return { valid: false, reason: "lease_mismatch" };
      }
      if (active.fencingToken !== state.descriptor.fencingToken) {
        return { valid: false, reason: "fencing_mismatch" };
      }
      return { valid: true, descriptor: state.descriptor };
    },
  });
}

export interface PostgresRunWorkerOptions {
  readonly queue: PostgresWorkerQueue;
  readonly driver: RunDriver;
  readonly authorityIssuer: WorkerDelegatingAuthorityIssuer;
  readonly workerId: string;
  readonly clock: Readonly<{ now(): string }>;
  readonly concurrency?: number;
  readonly leaseTtlMs?: number;
  readonly renewalIntervalMs?: number;
  readonly retryDelayMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const WORKER_CAPABILITIES: RuntimeCapabilities = RuntimeCapabilitiesSchema.parse({
  schemaVersion: "1",
  executionProfile: "durable",
  durableStorage: true,
  protectedContext: false,
  protectedWorkOrders: false,
  protectedInputSubmissions: false,
  streaming: false,
  cancellation: true,
  sandbox: "none",
  networkPolicy: "none",
  backgroundWakeup: true,
  atomicCommandAndWakeup: true,
  humanDecisions: false,
  typedInput: false,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: ["postgres"],
});

export class PostgresRunWorker {
  readonly capabilities = WORKER_CAPABILITIES;
  readonly #options: Required<
    Pick<
      PostgresRunWorkerOptions,
      "concurrency" | "leaseTtlMs" | "renewalIntervalMs" | "retryDelayMs" | "pollIntervalMs"
    >
  > &
    PostgresRunWorkerOptions;
  readonly #stopController = new AbortController();

  constructor(options: PostgresRunWorkerOptions) {
    this.#options = {
      ...options,
      workerId: z.string().trim().min(1).max(256).parse(options.workerId),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(256)
        .parse(options.concurrency ?? 4),
      leaseTtlMs: z
        .number()
        .int()
        .min(1_000)
        .max(3_600_000)
        .parse(options.leaseTtlMs ?? 30_000),
      renewalIntervalMs: z
        .number()
        .int()
        .min(100)
        .max(1_200_000)
        .parse(options.renewalIntervalMs ?? Math.floor((options.leaseTtlMs ?? 30_000) / 3)),
      retryDelayMs: z
        .number()
        .int()
        .min(0)
        .max(3_600_000)
        .parse(options.retryDelayMs ?? 5_000),
      pollIntervalMs: z
        .number()
        .int()
        .min(1)
        .max(60_000)
        .parse(options.pollIntervalMs ?? 250),
    };
    if (options.queue.transactionDomain !== "postgres" || !options.queue.atomicCommandAndWakeup) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { requiredCapability: "postgres_atomic_command_wakeup" },
      });
    }
    if (this.#options.renewalIntervalMs >= this.#options.leaseTtlMs) {
      throw new TypeError("KAF_RUNTIME_LEASE_RENEWAL_INTERVAL_INVALID");
    }
  }

  stop(): void {
    this.#stopController.abort("worker_stop");
  }

  async start(signal?: AbortSignal): Promise<void> {
    const combined =
      signal === undefined
        ? this.#stopController.signal
        : AbortSignal.any([signal, this.#stopController.signal]);
    const sleep = this.#options.sleep ?? defaultSleep;
    while (!combined.aborted) {
      const count = await this.runOnce(combined);
      if (count === 0) {
        try {
          await sleep(this.#options.pollIntervalMs, combined);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          throw error;
        }
      }
    }
  }

  async runOnce(signal: AbortSignal = this.#stopController.signal): Promise<number> {
    if (signal.aborted) return 0;
    const now = this.#options.clock.now();
    await this.#options.queue.recoverStale(now);
    const claims = await this.#options.queue.claim({
      holderId: this.#options.workerId,
      now,
      limit: this.#options.concurrency,
      leaseTtlMs: this.#options.leaseTtlMs,
    });
    await Promise.all(
      claims.map((input) => this.#dispatch(WorkerWakeupClaimSchema.parse(input), signal)),
    );
    return claims.length;
  }

  async #dispatch(claim: WorkerWakeupClaim, signal: AbortSignal): Promise<void> {
    if (
      claim.lease.state !== "active" ||
      Date.parse(claim.lease.expiresAt) <= Date.parse(this.#options.clock.now())
    ) {
      await this.#release(claim, "KAF_STORAGE_LEASE_EXPIRED");
      return;
    }
    let activeClaim = claim;
    const renewalFailure: { error?: Error } = {};
    const renewalStop = new AbortController();
    const leaseLost = new AbortController();
    let renewal: Promise<void> | undefined;
    try {
      this.#options.authorityIssuer.observeLease(claim.lease);
      const authority = this.#options.authorityIssuer.issueDelegated(this.#descriptor(claim));
      const verified = this.#options.authorityIssuer.verifyDelegated(
        authority,
        new Date(this.#options.clock.now()),
      );
      if (!verified.valid) throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH");
      if (signal.aborted) {
        await this.#release(claim, "KAF_RUNTIME_ABORTED");
        return;
      }
      renewal = this.#renewLease(claim, renewalStop.signal, (renewed) => {
        activeClaim = renewed;
      }).catch((error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error("KAF_RUNTIME_LEASE_RENEWAL_FAILED");
        renewalFailure.error = normalized;
        leaseLost.abort(normalized);
      });
      const executionSignal = AbortSignal.any([signal, leaseLost.signal]);
      const result = await this.#options.driver.execute(
        authority,
        { tenantId: claim.request.tenantId, runId: claim.request.runId },
        { signal: executionSignal },
      );
      renewalStop.abort("execution_finished");
      await renewal;
      if (renewalFailure.error !== undefined) throw renewalFailure.error;
      executionSignal.throwIfAborted();
      await this.#options.queue.complete(activeClaim, {
        status: result.status,
        completedAt: this.#options.clock.now(),
      });
      this.#options.authorityIssuer.invalidateSchedulerReceipt(claim.receiptId);
    } catch (error) {
      await this.#release(
        activeClaim,
        renewalFailure.error instanceof KafError
          ? renewalFailure.error.code
          : renewalFailure.error !== undefined
            ? "KAF_STORAGE_CONCURRENCY_CONFLICT"
            : signal.aborted
              ? "KAF_RUNTIME_ABORTED"
              : error instanceof KafError
                ? error.code
                : "KAF_RUNTIME_WORKER_FAILURE",
      );
    } finally {
      renewalStop.abort("dispatch_finished");
      await renewal;
    }
  }

  async #renewLease(
    original: WorkerWakeupClaim,
    signal: AbortSignal,
    observe: (claim: WorkerWakeupClaim) => void,
  ): Promise<void> {
    const sleep = this.#options.sleep ?? defaultSleep;
    let current = original;
    while (!isSignalAborted(signal)) {
      try {
        await sleep(this.#options.renewalIntervalMs, signal);
      } catch (error) {
        if (
          isSignalAborted(signal) &&
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }
        throw error;
      }
      if (isSignalAborted(signal)) return;
      const renewed = WorkerWakeupClaimSchema.parse(
        await this.#options.queue.renew(
          current,
          this.#options.clock.now(),
          this.#options.leaseTtlMs,
        ),
      );
      if (
        renewed.receiptId !== original.receiptId ||
        renewed.requestDigest !== original.requestDigest ||
        renewed.workOrderBindingDigest !== original.workOrderBindingDigest ||
        renewed.executionDefinitionDigest !== original.executionDefinitionDigest ||
        renewed.lease.tenantId !== original.lease.tenantId ||
        renewed.lease.runId !== original.lease.runId
      ) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH");
      }
      if (
        renewed.lease.state !== "active" ||
        renewed.lease.leaseId !== original.lease.leaseId ||
        renewed.lease.fencingToken !== original.lease.fencingToken ||
        Date.parse(renewed.lease.expiresAt) <= Date.parse(this.#options.clock.now())
      ) {
        throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT");
      }
      this.#options.authorityIssuer.observeLease(renewed.lease);
      current = renewed;
      observe(renewed);
    }
  }

  #descriptor(claim: WorkerWakeupClaim): RunDelegationDescriptor {
    return RunDelegationDescriptorSchema.parse({
      schemaVersion: "1",
      actor: { type: "system_worker", id: this.#options.workerId },
      initiatingPrincipal: claim.initiatingPrincipal,
      tenant: { id: claim.request.tenantId },
      runId: claim.request.runId,
      workOrderId: claim.workOrderId,
      workOrderBindingDigest: claim.workOrderBindingDigest,
      executionDefinition: claim.executionDefinition,
      executionDefinitionDigest: claim.executionDefinitionDigest,
      purpose: claim.purpose,
      maximumScopes: claim.maximumScopes,
      schedulerReceiptId: claim.receiptId,
      schedulerReceiptDigest: claim.requestDigest,
      leaseId: claim.lease.leaseId,
      fencingToken: claim.lease.fencingToken,
      issuedAt: claim.claimedAt,
      expiresAt: claim.lease.expiresAt,
      decisionRights: [],
    });
  }

  #release(claim: WorkerWakeupClaim, reasonCode: string): Promise<void> {
    const retryAt = new Date(
      Date.parse(this.#options.clock.now()) + this.#options.retryDelayMs,
    ).toISOString();
    this.#options.authorityIssuer.invalidateSchedulerReceipt(claim.receiptId);
    return this.#options.queue.release(claim, { retryAt, reasonCode });
  }
}

function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export type { DurableWakeupRequest };
export {
  DurablePostgresWorkerQueue,
  type DurablePostgresWorkerQueueOptions,
  type WorkerPostgresClient,
  type WorkerPostgresDatabase,
  type WorkerSqlResult,
} from "./postgres-queue.js";
