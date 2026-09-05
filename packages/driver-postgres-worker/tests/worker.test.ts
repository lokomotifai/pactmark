import { describe, expect, it, vi } from "vitest";
import type { RunDriver, RunLease } from "@pactmark/core";

import {
  PostgresRunWorker,
  createWorkerDelegatingAuthorityIssuer,
  type PostgresWorkerQueue,
  type WorkerWakeupClaim,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const now = "2026-08-03T12:00:00.000Z";

function lease(overrides: Partial<RunLease> = {}): RunLease {
  return {
    schemaVersion: "1",
    leaseId: "lease-1",
    tenantId: "tenant-1",
    runId: "run-1",
    holderId: "worker-1",
    fencingToken: 1,
    acquiredAt: now,
    expiresAt: "2026-08-03T12:01:00.000Z",
    state: "active",
    ...overrides,
  };
}

function claim(overrides: Partial<WorkerWakeupClaim> = {}): WorkerWakeupClaim {
  return {
    schemaVersion: "1",
    receiptId: "receipt-1",
    requestDigest: digest,
    request: {
      schemaVersion: "1",
      tenantId: "tenant-1",
      runId: "run-1",
      reason: "run_accepted",
      notBefore: now,
      deduplicationKey: "command-1",
      payload: {},
    },
    initiatingPrincipal: { type: "user", id: "person-1" },
    workOrderId: "work-1",
    workOrderBindingDigest: digest,
    executionDefinition: {
      kind: "agent",
      id: "agent-1",
      version: "0.1.0",
      agentDefinitionDigest: digest,
    },
    executionDefinitionDigest: digest,
    purpose: { code: "test", registryVersion: "1" },
    maximumScopes: [{ kind: "record", value: "1", normalizationVersion: "1" }],
    lease: lease(),
    claimedAt: now,
    ...overrides,
  };
}

function descriptor(inputLease = lease()) {
  return {
    schemaVersion: "1" as const,
    actor: { type: "system_worker" as const, id: "worker-1" },
    initiatingPrincipal: { type: "user" as const, id: "person-1" },
    tenant: { id: inputLease.tenantId },
    runId: inputLease.runId,
    workOrderId: "work-1",
    workOrderBindingDigest: digest,
    executionDefinition: {
      kind: "agent" as const,
      id: "agent-1",
      version: "0.1.0",
      agentDefinitionDigest: digest,
    },
    executionDefinitionDigest: digest,
    purpose: { code: "test", registryVersion: "1" },
    maximumScopes: [{ kind: "record", value: "1", normalizationVersion: "1" }],
    schedulerReceiptId: "receipt-1",
    schedulerReceiptDigest: digest,
    leaseId: inputLease.leaseId,
    fencingToken: inputLease.fencingToken,
    issuedAt: now,
    expiresAt: inputLease.expiresAt,
    decisionRights: [] as [],
  };
}

describe("delegated worker authority", () => {
  it("is run-, receipt-, lease-, and fencing-bound", () => {
    const issuer = createWorkerDelegatingAuthorityIssuer("worker-issuer");
    issuer.observeLease(lease());
    const authority = issuer.issueDelegated(descriptor());
    expect(issuer.verifyDelegated(authority, new Date(now))).toMatchObject({ valid: true });
    expect(issuer.verify(authority, new Date(now))).toMatchObject({
      valid: true,
      claims: {
        actor: { type: "system_worker" },
        subject: { id: "person-1" },
        authenticationStrength: "single_factor",
        decisionRoles: [],
      },
    });

    issuer.observeLease(lease({ fencingToken: 2 }));
    expect(issuer.verifyDelegated(authority, new Date(now))).toEqual({
      valid: false,
      reason: "fencing_mismatch",
    });
    expect(() => {
      issuer.observeLease(lease({ fencingToken: 1 }));
    }).toThrow();
  });

  it("expires delegated authority and detects lease replacement", () => {
    const issuer = createWorkerDelegatingAuthorityIssuer("worker-issuer");
    issuer.observeLease(lease());
    const authority = issuer.issueDelegated(descriptor());
    expect(issuer.verifyDelegated(authority, new Date("2026-08-03T12:02:00.000Z"))).toEqual({
      valid: false,
      reason: "expired",
    });
    issuer.observeLease(lease({ leaseId: "lease-2", fencingToken: 2 }));
    expect(issuer.verifyDelegated(authority, new Date(now))).toEqual({
      valid: false,
      reason: "lease_mismatch",
    });
  });

  it("does not alias delimiter-bearing tenant and run lease tuples", () => {
    const issuer = createWorkerDelegatingAuthorityIssuer("worker-issuer");
    const first = lease({ tenantId: "a\u0000b", runId: "c", leaseId: "lease-a" });
    const second = lease({ tenantId: "a", runId: "b\u0000c", leaseId: "lease-b" });
    issuer.observeLease(first);
    issuer.observeLease(second);
    expect(
      issuer.verifyDelegated(issuer.issueDelegated(descriptor(first)), new Date(now)),
    ).toMatchObject({
      valid: true,
    });
    expect(
      issuer.verifyDelegated(issuer.issueDelegated(descriptor(second)), new Date(now)),
    ).toMatchObject({ valid: true });
  });

  it("rejects unobserved and invalidated scheduler authority", () => {
    const issuer = createWorkerDelegatingAuthorityIssuer("worker-issuer");
    expect(() => issuer.issueDelegated(descriptor())).toThrow();
    expect(issuer.verifyDelegated(null, new Date(now))).toEqual({
      valid: false,
      reason: "not_issued",
    });
    expect(issuer.verifyDelegated({}, new Date(now))).toEqual({
      valid: false,
      reason: "not_issued",
    });
    issuer.observeLease(lease());
    const authority = issuer.issueDelegated(descriptor());
    issuer.invalidateSchedulerReceipt("receipt-1");
    expect(issuer.verifyDelegated(authority, new Date(now))).toEqual({
      valid: false,
      reason: "scheduler_receipt_mismatch",
    });
    expect(() => issuer.issueDelegated(descriptor())).toThrow();
  });
});

function setup(
  input: {
    claims?: readonly WorkerWakeupClaim[];
    execute?: RunDriver["execute"];
    clock?: string;
    renew?: PostgresWorkerQueue["renew"];
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    renewalIntervalMs?: number;
  } = {},
) {
  const complete = vi.fn<PostgresWorkerQueue["complete"]>().mockResolvedValue(undefined);
  const release = vi.fn<PostgresWorkerQueue["release"]>().mockResolvedValue(undefined);
  const recoverStale = vi.fn<PostgresWorkerQueue["recoverStale"]>().mockResolvedValue(0);
  const claimQueue = vi
    .fn<PostgresWorkerQueue["claim"]>()
    .mockResolvedValue(input.claims ?? [claim()]);
  const renew = vi.fn<PostgresWorkerQueue["renew"]>(
    input.renew ??
      (async (value) => {
        await Promise.resolve();
        return value;
      }),
  );
  const queue: PostgresWorkerQueue = {
    transactionDomain: "postgres",
    atomicCommandAndWakeup: true,
    recoverStale,
    claim: claimQueue,
    renew,
    complete,
    release,
  };
  const issuer = createWorkerDelegatingAuthorityIssuer("worker-issuer");
  const execute = vi.fn<RunDriver["execute"]>(
    input.execute ??
      (async () => {
        await Promise.resolve();
        return { status: "completed", runId: "run-1" };
      }),
  );
  const driver: RunDriver = {
    capabilities: {
      schemaVersion: "1",
      executionProfile: "durable",
      durableStorage: true,
      protectedContext: true,
      protectedWorkOrders: true,
      protectedInputSubmissions: true,
      streaming: true,
      cancellation: true,
      sandbox: "isolated",
      networkPolicy: "enforced",
      backgroundWakeup: true,
      atomicCommandAndWakeup: true,
      humanDecisions: true,
      typedInput: true,
      effectReconciliation: true,
      compensation: true,
      modelCredentials: true,
      toolCredentials: true,
      telemetry: "metadata_only",
      transactionDomains: ["postgres"],
    },
    execute,
  };
  const worker = new PostgresRunWorker({
    queue,
    driver,
    authorityIssuer: issuer,
    workerId: "worker-1",
    clock: { now: () => input.clock ?? now },
    concurrency: 2,
    retryDelayMs: 1_000,
    ...(input.renewalIntervalMs === undefined
      ? {}
      : { renewalIntervalMs: input.renewalIntervalMs }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
  });
  return { worker, queue, issuer, execute, complete, release, renew, recoverStale, claimQueue };
}

function immediateThenAbortableSleep(): (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void> {
  let calls = 0;
  return async (_milliseconds, signal) => {
    calls += 1;
    if (calls === 1) return;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  };
}

describe("PostgresRunWorker", () => {
  it("recovers, claims, dispatches with delegated authority, and completes", async () => {
    const subject = setup();
    expect(subject.worker.capabilities).toMatchObject({
      executionProfile: "durable",
      backgroundWakeup: true,
      atomicCommandAndWakeup: true,
    });
    await expect(subject.worker.runOnce()).resolves.toBe(1);
    expect(subject.recoverStale).toHaveBeenCalledWith(now);
    expect(subject.claimQueue).toHaveBeenCalledWith(
      expect.objectContaining({ holderId: "worker-1", limit: 2 }),
    );
    expect(subject.execute).toHaveBeenCalledOnce();
    expect(subject.complete).toHaveBeenCalledWith(
      expect.objectContaining({ receiptId: "receipt-1" }),
      { status: "completed", completedAt: now },
    );
  });

  it("parks expired claims without dispatch", async () => {
    const expired = claim({ lease: lease({ expiresAt: "2026-08-03T11:59:59.000Z" }) });
    const subject = setup({ claims: [expired] });
    await subject.worker.runOnce();
    expect(subject.execute).not.toHaveBeenCalled();
    expect(subject.release).toHaveBeenCalledWith(expired, {
      retryAt: "2026-08-03T12:00:01.000Z",
      reasonCode: "KAF_STORAGE_LEASE_EXPIRED",
    });
  });

  it("releases failed work with only a safe code", async () => {
    const subject = setup({
      execute: async () => {
        await Promise.resolve();
        throw new Error("secret detail");
      },
    });
    await subject.worker.runOnce();
    expect(subject.complete).not.toHaveBeenCalled();
    expect(subject.release).toHaveBeenCalledWith(expect.anything(), {
      retryAt: "2026-08-03T12:00:01.000Z",
      reasonCode: "KAF_RUNTIME_WORKER_FAILURE",
    });
  });

  it("does no queue work for an already aborted call", async () => {
    const subject = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(subject.worker.runOnce(controller.signal)).resolves.toBe(0);
    expect(subject.claimQueue).not.toHaveBeenCalled();
  });

  it("releases a claim when cancellation arrives after polling", async () => {
    const controller = new AbortController();
    const subject = setup();
    subject.claimQueue.mockImplementationOnce(async () => {
      await Promise.resolve();
      controller.abort();
      return [claim()];
    });
    await expect(subject.worker.runOnce(controller.signal)).resolves.toBe(1);
    expect(subject.execute).not.toHaveBeenCalled();
    expect(subject.release).toHaveBeenCalledWith(expect.anything(), {
      retryAt: "2026-08-03T12:00:01.000Z",
      reasonCode: "KAF_RUNTIME_ABORTED",
    });
  });

  it("renews the lease while execution is active and completes with the renewed claim", async () => {
    let markRenewed: (() => void) | undefined;
    const renewed = new Promise<void>((resolve) => {
      markRenewed = resolve;
    });
    const extended = claim({
      lease: lease({ expiresAt: "2026-08-03T12:02:00.000Z" }),
    });
    const subject = setup({
      renewalIntervalMs: 100,
      sleep: immediateThenAbortableSleep(),
      renew: () => {
        markRenewed?.();
        return Promise.resolve(extended);
      },
      execute: async () => {
        await renewed;
        return { status: "completed", runId: "run-1" };
      },
    });
    await subject.worker.runOnce();
    expect(subject.renew).toHaveBeenCalledOnce();
    expect(subject.complete).toHaveBeenCalledWith(extended, {
      status: "completed",
      completedAt: now,
    });
  });

  it("aborts active execution and releases safely when lease renewal loses fencing", async () => {
    let executionSignal: AbortSignal | undefined;
    const subject = setup({
      renewalIntervalMs: 100,
      sleep: immediateThenAbortableSleep(),
      renew: async () => {
        await Promise.resolve();
        return claim({
          lease: lease({
            leaseId: "lease-replaced",
            fencingToken: 2,
            expiresAt: "2026-08-03T12:02:00.000Z",
          }),
        });
      },
      execute: async (_authority, _run, options) => {
        executionSignal = options.signal;
        await new Promise<void>((_resolve, reject) => {
          if (executionSignal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          executionSignal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
        return { status: "completed", runId: "run-1" };
      },
    });
    await subject.worker.runOnce();
    expect(executionSignal?.aborted).toBe(true);
    expect(subject.complete).not.toHaveBeenCalled();
    expect(subject.release).toHaveBeenCalledWith(expect.anything(), {
      retryAt: "2026-08-03T12:00:01.000Z",
      reasonCode: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
  });

  it("stops its polling loop cleanly", async () => {
    const subject = setup({ claims: [] });
    const controller = new AbortController();
    const worker = new PostgresRunWorker({
      queue: subject.queue,
      driver: { capabilities: subject.worker.capabilities, execute: subject.execute },
      authorityIssuer: subject.issuer,
      workerId: "worker-2",
      clock: { now: () => now },
      sleep: async () => {
        await Promise.resolve();
        controller.abort();
      },
    });
    await expect(worker.start(controller.signal)).resolves.toBeUndefined();
    expect(subject.claimQueue).toHaveBeenCalledOnce();
  });

  it("aborts the default poll sleep without surfacing an error", async () => {
    const subject = setup({ claims: [] });
    const worker = new PostgresRunWorker({
      queue: subject.queue,
      driver: { capabilities: subject.worker.capabilities, execute: subject.execute },
      authorityIssuer: subject.issuer,
      workerId: "worker-3",
      clock: { now: () => now },
      pollIntervalMs: 10,
    });
    const running = worker.start();
    setTimeout(() => {
      worker.stop();
    }, 0);
    await expect(running).resolves.toBeUndefined();
  });

  it("fails closed for a non-atomic or non-Postgres queue", () => {
    const subject = setup({ claims: [] });
    expect(
      () =>
        new PostgresRunWorker({
          queue: { ...subject.queue, transactionDomain: "memory" },
          driver: { capabilities: subject.worker.capabilities, execute: subject.execute },
          authorityIssuer: subject.issuer,
          workerId: "worker-2",
          clock: { now: () => now },
        }),
    ).toThrow();
    expect(
      () =>
        new PostgresRunWorker({
          queue: subject.queue,
          driver: { capabilities: subject.worker.capabilities, execute: subject.execute },
          authorityIssuer: subject.issuer,
          workerId: "worker-2",
          clock: { now: () => now },
          leaseTtlMs: 1_000,
          renewalIntervalMs: 1_000,
        }),
    ).toThrow("KAF_RUNTIME_LEASE_RENEWAL_INTERVAL_INVALID");
  });
});
