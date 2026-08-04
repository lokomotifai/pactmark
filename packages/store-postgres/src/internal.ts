import { KafError } from "@pactmark/core";

export function conflict(reason: string): never {
  throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", { details: { reason } });
}

export function assertNonempty(value: string, path: string): void {
  if (value.trim().length === 0) {
    throw new KafError("KAF_SCHEMA_INVALID", { details: { path, issue: "too_small" } });
  }
}

export function assertNonnegative(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KafError("KAF_SCHEMA_INVALID", {
      details: { path, issue: "nonnegative_integer" },
    });
  }
}

export function assertPositive(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new KafError("KAF_SCHEMA_INVALID", { details: { path, issue: "positive_integer" } });
  }
}

export function parseJsonColumn(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
