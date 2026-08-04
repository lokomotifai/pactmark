import type { RunProjection } from "@pactmark/core";

import type { PostgresEventStore } from "./event-store.js";

/** Explicit operational API for rebuilding non-authoritative run projections. */
export class PostgresProjectionRebuilder {
  constructor(readonly eventStore: PostgresEventStore) {}

  rebuild(tenantId: string, runId: string): Promise<RunProjection | undefined> {
    return this.eventStore.rebuildProjection(tenantId, runId);
  }

  async rebuildMany(
    tenantId: string,
    runIds: readonly string[],
  ): Promise<ReadonlyMap<string, RunProjection | undefined>> {
    const results = new Map<string, RunProjection | undefined>();
    for (const runId of [...new Set(runIds)]) {
      results.set(runId, await this.rebuild(tenantId, runId));
    }
    return results;
  }
}
