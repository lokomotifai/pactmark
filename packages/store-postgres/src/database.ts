import { Pool, type PoolConfig, type PoolClient, type QueryResultRow } from "pg";

export interface SqlResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface PostgresClient {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  release(): void;
}

export interface PostgresDatabase {
  /** Present only when this package owns the pool and must install tenant RLS context. */
  readonly tenantTransactions?: true;
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  connect(): Promise<PostgresClient>;
  end?(): Promise<void>;
}

export interface PostgresMaintenanceDatabase extends PostgresDatabase {
  /** Explicit host assertion that this connection uses the operator maintenance role. */
  readonly operatorMaintenance: true;
}

export function createPostgresDatabase(config: PoolConfig): PostgresDatabase {
  const pool = new Pool(config);
  return {
    tenantTransactions: true,
    // The generic preserves each caller's explicit SQL row contract through the pg boundary.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
      const result = await pool.query<Row>(text, values as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    connect: async () => wrapClient(await pool.connect()),
    end: async () => pool.end(),
  };
}

/**
 * Creates the explicitly privileged database boundary used only for migrations
 * and cross-tenant maintenance. Application requests and workers must use
 * `createPostgresDatabase` with a non-owner role instead.
 */
export function createPostgresMaintenanceDatabase(config: PoolConfig): PostgresMaintenanceDatabase {
  return Object.freeze({
    ...createPostgresDatabase(config),
    operatorMaintenance: true as const,
  });
}

function wrapClient(client: PoolClient): PostgresClient {
  return {
    // The generic preserves each caller's explicit SQL row contract through the pg boundary.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
      const result = await client.query<Row>(text, values as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    release: () => {
      client.release();
    },
  };
}

export async function withTransaction<T>(
  database: PostgresDatabase,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Binds PostgreSQL RLS to one tenant for exactly one transaction. The local
 * setting is cleared by COMMIT/ROLLBACK and can never bleed through the pool.
 */
export function withTenantTransaction<T>(
  database: PostgresDatabase,
  tenantId: string,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  return withTransaction(database, async (client) => {
    await client.query("SELECT set_config('pactmark.tenant_id', $1, true)", [tenantId]);
    return operation(client);
  });
}

export function queryForTenant<Row extends QueryResultRow = QueryResultRow>(
  database: PostgresDatabase,
  tenantId: string,
  text: string,
  values?: readonly unknown[],
): Promise<SqlResult<Row>> {
  if (database.tenantTransactions !== true) return database.query<Row>(text, values);
  return withTenantTransaction(database, tenantId, (client) => client.query<Row>(text, values));
}
