import { Pool, PoolClient } from "pg";
import { getConfig } from "./config";
import { logger } from "./logger";

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;

  const config = getConfig();
  _pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  _pool.on("error", (err) => {
    logger.error("Error inesperado en el pool de conexiones PostgreSQL", {
      message: err.message,
    });
  });

  return _pool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const pool = getPool();
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    const pool = getPool();
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    logger.info("Conexión a PostgreSQL OK", {
      db: getConfig().databaseUrlSanitized,
    });
    return true;
  } catch (err) {
    logger.error("No se puede conectar a PostgreSQL", {
      message: err instanceof Error ? err.message : String(err),
      db: getConfig().databaseUrlSanitized,
    });
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    logger.info("Pool de conexiones cerrado.");
  }
}
