import { KafError, RunLeaseSchema, type RunLease, type RunLeaseStore } from "@pactmark/core";

import {
  assertPositiveTtl,
  assertValidInstant,
  cloneJson,
  conflict,
  recordKey,
  systemNow,
  type Now,
} from "./internal.js";

export interface MemoryRunLeaseStoreOptions {
  readonly now?: Now;
  readonly generateLeaseId?: (
    input: Readonly<{
      tenantId: string;
      runId: string;
      fencingToken: number;
    }>,
  ) => string;
}

export class MemoryRunLeaseStore implements RunLeaseStore {
  readonly #leases = new Map<string, RunLease>();
  readonly #lastFencingTokens = new Map<string, number>();
  readonly #now: Now;
  readonly #generateLeaseId: NonNullable<MemoryRunLeaseStoreOptions["generateLeaseId"]>;
  #leaseCounter = 0;

  constructor(options: MemoryRunLeaseStoreOptions = {}) {
    this.#now = options.now ?? systemNow;
    this.#generateLeaseId =
      options.generateLeaseId ??
      ((input) => {
        this.#leaseCounter += 1;
        return `memory-lease-${String(input.fencingToken)}-${String(this.#leaseCounter)}`;
      });
  }

  async acquire(
    tenantId: string,
    runId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<RunLease | undefined> {
    await Promise.resolve();
    assertNonempty(tenantId, "tenantId");
    assertNonempty(runId, "runId");
    assertNonempty(holderId, "holderId");
    assertPositiveTtl(ttlMs);
    const now = this.#now();
    const nowMs = assertValidInstant(now);
    const key = recordKey(tenantId, runId);
    const existing = this.#leases.get(key);
    if (
      existing !== undefined &&
      existing.state === "active" &&
      Date.parse(existing.expiresAt) > nowMs
    ) {
      return undefined;
    }
    if (existing !== undefined && existing.state === "active") {
      this.#leases.set(key, { ...existing, state: "expired" });
    }
    const fencingToken = (this.#lastFencingTokens.get(key) ?? 0) + 1;
    this.#lastFencingTokens.set(key, fencingToken);
    const lease = RunLeaseSchema.parse({
      schemaVersion: "1",
      leaseId: this.#generateLeaseId({ tenantId, runId, fencingToken }),
      tenantId,
      runId,
      holderId,
      fencingToken,
      acquiredAt: now,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      state: "active",
    });
    this.#leases.set(key, lease);
    return cloneJson(lease);
  }

  async renew(input: RunLease, ttlMs: number): Promise<RunLease> {
    await Promise.resolve();
    const lease = RunLeaseSchema.parse(input);
    assertPositiveTtl(ttlMs);
    const now = this.#now();
    const nowMs = assertValidInstant(now);
    const key = recordKey(lease.tenantId, lease.runId);
    const current = this.#leases.get(key);
    if (!sameLease(current, lease) || current.state !== "active") conflict("stale_lease");
    if (Date.parse(current.expiresAt) <= nowMs) {
      this.#leases.set(key, { ...current, state: "expired" });
      conflict("expired_lease");
    }
    const renewed = RunLeaseSchema.parse({
      ...current,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    });
    this.#leases.set(key, renewed);
    return cloneJson(renewed);
  }

  async release(input: RunLease): Promise<void> {
    await Promise.resolve();
    const lease = RunLeaseSchema.parse(input);
    const key = recordKey(lease.tenantId, lease.runId);
    const current = this.#leases.get(key);
    if (!sameLease(current, lease) || current.state !== "active") conflict("stale_lease");
    this.#leases.set(key, { ...current, state: "released" });
  }

  isActive(input: RunLease): boolean {
    try {
      this.assertActive(input);
      return true;
    } catch {
      return false;
    }
  }

  assertActive(input: RunLease): void {
    const lease = RunLeaseSchema.parse(input);
    const current = this.#leases.get(recordKey(lease.tenantId, lease.runId));
    const nowMs = assertValidInstant(this.#now());
    if (
      !sameLease(current, lease) ||
      current.state !== "active" ||
      Date.parse(current.expiresAt) <= nowMs
    ) {
      conflict("stale_or_expired_fence");
    }
  }

  inspect(tenantId: string, runId: string): RunLease | undefined {
    const lease = this.#leases.get(recordKey(tenantId, runId));
    return lease === undefined ? undefined : cloneJson(lease);
  }
}

function sameLease(left: RunLease | undefined, right: RunLease): left is RunLease {
  return (
    left !== undefined &&
    left.leaseId === right.leaseId &&
    left.tenantId === right.tenantId &&
    left.runId === right.runId &&
    left.holderId === right.holderId &&
    left.fencingToken === right.fencingToken
  );
}

function assertNonempty(value: string, path: string): void {
  if (value.trim().length === 0) {
    throw new KafError("KAF_SCHEMA_INVALID", { details: { path, issue: "too_small" } });
  }
}
