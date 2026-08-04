import { JsonValueSchema, canonicalJsonStringify, type JsonValue } from "@pactmark/core";

export interface ContractReport {
  readonly suite: string;
  readonly passedChecks: readonly string[];
}

export class ContractViolation extends Error {
  readonly code = "KAF_TESTING_CONTRACT_VIOLATION" as const;
  readonly suite: string;
  readonly check: string;

  constructor(suite: string, check: string, details?: string) {
    super(`${suite} contract failed at ${check}${details === undefined ? "" : `: ${details}`}`);
    this.name = "ContractViolation";
    this.suite = suite;
    this.check = check;
  }
}

export class ContractRecorder {
  readonly #suite: string;
  readonly #checks: string[] = [];

  constructor(suite: string) {
    this.#suite = suite;
  }

  assert(condition: boolean, check: string, details?: string): void {
    if (!condition) throw new ContractViolation(this.#suite, check, details);
    this.#checks.push(check);
  }

  async rejects(operation: () => Promise<unknown>, check: string): Promise<void> {
    await this.captureRejection(operation, check);
  }

  async captureRejection(operation: () => Promise<unknown>, check: string): Promise<unknown> {
    try {
      await operation();
    } catch (error) {
      this.#checks.push(check);
      return error;
    }
    throw new ContractViolation(this.#suite, check, "operation unexpectedly succeeded");
  }

  report(): ContractReport {
    return Object.freeze({ suite: this.#suite, passedChecks: Object.freeze([...this.#checks]) });
  }
}

export function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

export type SafeErrorSurfaceFactory = (error: unknown) => unknown;

export function assertSafeErrorSurface(
  contract: ContractRecorder,
  error: unknown,
  toSurface: SafeErrorSurfaceFactory,
  sensitiveMarker: string,
  check: string,
): JsonValue {
  contract.assert(sensitiveMarker.length > 0, `${check}-sensitive-marker-present`);
  let untrustedSurface: unknown;
  try {
    untrustedSurface = toSurface(error);
  } catch (surfaceError) {
    throw new ContractViolation(contract.report().suite, check, describeError(surfaceError));
  }
  const parsed = JsonValueSchema.safeParse(untrustedSurface);
  contract.assert(parsed.success, `${check}-schema-valid`);
  const surface = parsed.success ? parsed.data : null;
  contract.assert(
    !canonicalJsonStringify(surface).includes(sensitiveMarker),
    `${check}-sensitive-marker-redacted`,
  );
  if (isJsonObject(surface)) {
    const code = surface["code"];
    contract.assert(
      typeof code === "string" && /^KAF_[A-Z0-9_]+$/u.test(code),
      `${check}-stable-code`,
    );
  } else {
    contract.assert(false, `${check}-stable-code`);
  }
  return surface;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
