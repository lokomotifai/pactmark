import { KafError } from "@pactmark/core";

import type { PostgresMaintenanceDatabase } from "./database.js";
import type { ProtectedStoreDeletion } from "./record-stores.js";

export interface PostgresRetentionMaintenanceOptions {
  readonly now?: () => string;
  readonly onDelete?: (record: ProtectedStoreDeletion) => void | Promise<void>;
}

export interface PostgresRetentionPurgeResult {
  readonly acceptedWorkOrders: number;
  readonly inputSubmissions: number;
  readonly contexts: number;
  readonly artifacts: number;
  readonly total: number;
}

type RetentionRow = Readonly<{
  tenant_id: string;
  record_id: string;
}>;

/** Explicit operator-only, cross-tenant retention boundary. */
export class PostgresRetentionMaintenance {
  readonly #database: PostgresMaintenanceDatabase;
  readonly #now: () => string;
  readonly #onDelete: PostgresRetentionMaintenanceOptions["onDelete"];

  constructor(
    database: PostgresMaintenanceDatabase,
    options: PostgresRetentionMaintenanceOptions = {},
  ) {
    const operatorMaintenance: unknown = Reflect.get(database, "operatorMaintenance");
    if (operatorMaintenance !== true) {
      throw new KafError("KAF_RUNTIME_NOT_READY", {
        details: { reason: "operator_retention_database_required" },
      });
    }
    this.#database = database;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onDelete = options.onDelete;
  }

  purgeExpiredAcceptedWorkOrders(now = this.#now()): Promise<number> {
    return this.#purge(
      `DELETE FROM pactmark_work_orders
       WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       RETURNING tenant_id,work_order_id AS record_id`,
      "accepted_work_order",
      now,
    );
  }

  purgeExpiredInputSubmissions(now = this.#now()): Promise<number> {
    return this.#purge(
      `DELETE FROM pactmark_input_submissions
       WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       RETURNING tenant_id,(run_id || '/' || request_id) AS record_id`,
      "input_submission",
      now,
    );
  }

  purgeExpiredContexts(now = this.#now()): Promise<number> {
    return this.#purge(
      `DELETE FROM pactmark_context_snapshots
       WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       RETURNING tenant_id,snapshot_id AS record_id`,
      "context",
      now,
    );
  }

  purgeExpiredArtifacts(now = this.#now()): Promise<number> {
    return this.#purge(
      `DELETE FROM pactmark_artifacts
       WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       RETURNING tenant_id,artifact_id AS record_id`,
      "artifact",
      now,
    );
  }

  async purgeAllExpired(now = this.#now()): Promise<PostgresRetentionPurgeResult> {
    assertTimestamp(now);
    const artifacts = await this.purgeExpiredArtifacts(now);
    const contexts = await this.purgeExpiredContexts(now);
    const inputSubmissions = await this.purgeExpiredInputSubmissions(now);
    const acceptedWorkOrders = await this.purgeExpiredAcceptedWorkOrders(now);
    return Object.freeze({
      acceptedWorkOrders,
      inputSubmissions,
      contexts,
      artifacts,
      total: acceptedWorkOrders + inputSubmissions + contexts + artifacts,
    });
  }

  async #purge(
    statement: string,
    storeKind: ProtectedStoreDeletion["storeKind"],
    now: string,
  ): Promise<number> {
    assertTimestamp(now);
    const result = await this.#database.query<RetentionRow>(statement, [now]);
    for (const row of result.rows) {
      await this.#onDelete?.({
        tenantId: row.tenant_id,
        storeKind,
        recordId: row.record_id,
        reason: "expired",
      });
    }
    return result.rowCount;
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new KafError("KAF_SCHEMA_INVALID", {
      details: { path: "now", issue: "valid_timestamp_required" },
    });
  }
}
