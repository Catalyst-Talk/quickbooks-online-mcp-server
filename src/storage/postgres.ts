import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | null = null;

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for connector auth mode");
  }

  return new Pool({
    connectionString,
    ssl:
      process.env.DATABASE_SSL_DISABLE === "true"
        ? false
        : {
            rejectUnauthorized:
              process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
          },
  });
}

export function getPostgresPool(): Pool {
  if (!pool) {
    pool = createPool();
  }

  return pool;
}

export async function queryRows<T extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  try {
    const result = await getPostgresPool().query<T>(text, values);
    return result.rows;
  } catch (error) {
    const err = error as {
      message?: string;
      code?: string;
      detail?: string;
      hint?: string;
      schema?: string;
      table?: string;
      constraint?: string;
    };
    console.error("[postgres] query failed", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
      schema: err?.schema,
      table: err?.table,
      constraint: err?.constraint,
      sql: text.replace(/\s+/g, " ").trim().slice(0, 240),
      valueCount: values.length,
    });
    throw error;
  }
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const rows = await queryRows<T>(text, values);
  return rows[0] ?? null;
}

export async function withPgClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await getPostgresPool().connect();
  } catch (error) {
    const err = error as { message?: string; code?: string };
    console.error("[postgres] failed to acquire client", {
      message: err?.message,
      code: err?.code,
    });
    throw error;
  }
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withPgTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      const err = error as { message?: string; code?: string };
      console.error("[postgres] transaction rolled back", {
        message: err?.message,
        code: err?.code,
      });
      throw error;
    }
  });
}
