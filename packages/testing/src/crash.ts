export type CrashBoundary = string;

export interface CrashPlanEntry {
  readonly boundary: CrashBoundary;
  readonly occurrence?: number;
}

export class CrashInjectedError extends Error {
  readonly code = "KAF_TESTING_CRASH_INJECTED" as const;
  readonly boundary: CrashBoundary;
  readonly occurrence: number;

  constructor(boundary: CrashBoundary, occurrence: number) {
    super(`Injected crash at ${boundary} occurrence ${String(occurrence)}`);
    this.name = "CrashInjectedError";
    this.boundary = boundary;
    this.occurrence = occurrence;
  }
}

/** Deterministically throws at configured named boundaries. */
export class CrashInjector {
  readonly #plan: ReadonlyMap<CrashBoundary, ReadonlySet<number>>;
  readonly #hits = new Map<CrashBoundary, number>();

  constructor(entries: readonly CrashPlanEntry[] = []) {
    const plan = new Map<CrashBoundary, Set<number>>();
    for (const entry of entries) {
      if (entry.boundary.trim().length === 0) throw new TypeError("Crash boundary is required");
      const occurrence = entry.occurrence ?? 1;
      if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
        throw new RangeError("Crash occurrence must be a positive integer");
      }
      const occurrences = plan.get(entry.boundary) ?? new Set<number>();
      occurrences.add(occurrence);
      plan.set(entry.boundary, occurrences);
    }
    this.#plan = plan;
  }

  hit(boundary: CrashBoundary): void {
    if (boundary.trim().length === 0) throw new TypeError("Crash boundary is required");
    const occurrence = (this.#hits.get(boundary) ?? 0) + 1;
    this.#hits.set(boundary, occurrence);
    if (this.#plan.get(boundary)?.has(occurrence) === true) {
      throw new CrashInjectedError(boundary, occurrence);
    }
  }

  hitCount(boundary: CrashBoundary): number {
    return this.#hits.get(boundary) ?? 0;
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze(
      Object.fromEntries([...this.#hits].sort(([left], [right]) => left.localeCompare(right))),
    );
  }
}

export function crashAtEveryBoundary(
  boundaries: readonly CrashBoundary[],
): readonly CrashInjector[] {
  return boundaries.map((boundary) => new CrashInjector([{ boundary }]));
}
