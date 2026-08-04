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
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  connect(): Promise<PostgresClient>;
  end?(): Promise<void>;
}

export function createPostgresDatabase(config: PoolConfig): PostgresDatabase {
  const pool = new Pool(config);
  return {
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
