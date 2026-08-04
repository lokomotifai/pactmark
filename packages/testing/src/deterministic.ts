import type { Clock, IdGenerator } from "@pactmark/core";

type Sleeper = {
  readonly due: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
};

export interface FakeClockOptions {
  readonly now?: string;
  readonly monotonicMilliseconds?: number;
}

/** A manually advanced wall and monotonic clock. It never consults host time. */
export class FakeClock implements Clock {
  #wallMilliseconds: number;
  #monotonicMilliseconds: number;
  readonly #sleepers = new Set<Sleeper>();

  constructor(options: FakeClockOptions = {}) {
    const wallMilliseconds = Date.parse(options.now ?? "2026-01-01T00:00:00.000Z");
    const monotonicMilliseconds = options.monotonicMilliseconds ?? 0;
    if (!Number.isFinite(wallMilliseconds)) throw new TypeError("FakeClock now must be an instant");
    assertNonnegativeFinite(monotonicMilliseconds, "monotonicMilliseconds");
    this.#wallMilliseconds = wallMilliseconds;
    this.#monotonicMilliseconds = monotonicMilliseconds;
  }

  now(): string {
    return new Date(this.#wallMilliseconds).toISOString();
  }

  monotonicMilliseconds(): number {
    return this.#monotonicMilliseconds;
  }

  pendingSleeps(): number {
    return this.#sleepers.size;
  }

  advance(milliseconds: number): void {
    assertNonnegativeFinite(milliseconds, "milliseconds");
    this.#wallMilliseconds += milliseconds;
    this.#monotonicMilliseconds += milliseconds;
    this.#releaseDueSleepers();
  }

  setWallTime(instant: string): void {
    const next = Date.parse(instant);
    if (!Number.isFinite(next)) throw new TypeError("FakeClock instant must be an ISO datetime");
    if (next < this.#wallMilliseconds) throw new RangeError("FakeClock cannot move backwards");
    this.advance(next - this.#wallMilliseconds);
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    assertNonnegativeFinite(milliseconds, "milliseconds");
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    if (milliseconds === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const sleeper: Sleeper = {
        due: this.#monotonicMilliseconds + milliseconds,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      const onAbort = (): void => {
        this.#sleepers.delete(sleeper);
        reject(abortError(signal));
      };
      sleeper.onAbort = onAbort;
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      this.#sleepers.add(sleeper);
    });
  }

  #releaseDueSleepers(): void {
    for (const sleeper of [...this.#sleepers]) {
      if (sleeper.due > this.#monotonicMilliseconds) continue;
      this.#sleepers.delete(sleeper);
      if (sleeper.signal !== undefined && sleeper.onAbort !== undefined) {
        sleeper.signal.removeEventListener("abort", sleeper.onAbort);
      }
      sleeper.resolve();
    }
  }
}

export interface SequenceIdGeneratorOptions {
  readonly prefix?: string;
  readonly startAt?: number;
  readonly width?: number;
}

/** Produces globally ordered, human-readable IDs without randomness. */
export class SequenceIdGenerator implements IdGenerator {
  readonly #prefix: string;
  readonly #width: number;
  #sequence: number;

  constructor(options: SequenceIdGeneratorOptions = {}) {
    this.#prefix = options.prefix ?? "test";
    this.#width = options.width ?? 6;
    this.#sequence = options.startAt ?? 0;
    if (!/^[a-zA-Z0-9._-]+$/u.test(this.#prefix)) {
      throw new TypeError("SequenceIdGenerator prefix contains unsupported characters");
    }
    if (!Number.isSafeInteger(this.#width) || this.#width < 1) {
      throw new RangeError("SequenceIdGenerator width must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#sequence) || this.#sequence < 0) {
      throw new RangeError("SequenceIdGenerator startAt must be a nonnegative integer");
    }
  }

  generate(kind: string): string {
    const normalizedKind = kind.trim();
    if (!/^[a-zA-Z0-9._-]+$/u.test(normalizedKind)) {
      throw new TypeError("ID kind contains unsupported characters");
    }
    if (this.#sequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("SequenceIdGenerator sequence is exhausted");
    }
    this.#sequence += 1;
    return `${this.#prefix}-${normalizedKind}-${String(this.#sequence).padStart(this.#width, "0")}`;
  }

  currentSequence(): number {
    return this.#sequence;
  }
}

function assertNonnegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be nonnegative`);
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The operation was aborted", "AbortError");
}
