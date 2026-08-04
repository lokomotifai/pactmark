import { canonicalJsonStringify, KafError } from "@pactmark/core";

export type Now = () => string;

export function systemNow(): string {
  return new Date().toISOString();
}

export function recordKey(...parts: readonly string[]): string {
  return canonicalJsonStringify(parts);
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

export function assertPositiveTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new KafError("KAF_SCHEMA_INVALID", { details: { path: "ttlMs", issue: "positive" } });
  }
}

export function assertValidInstant(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new KafError("KAF_SCHEMA_INVALID", {
      details: { path: "clock.now", issue: "datetime" },
    });
  }
  return milliseconds;
}

export function hasExpired(expiresAt: string | undefined, now: string): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= assertValidInstant(now);
}

export function conflict(reason: string): never {
  throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", { details: { reason } });
}
