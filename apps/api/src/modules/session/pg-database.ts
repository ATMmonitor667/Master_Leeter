import { Pool, type PoolConfig } from "pg";
import type { TransactionClient, TransactionPool } from "./pg-event-log.js";

/** One connection per transaction; no unchecked TLS overrides in connection URLs. */
export function databaseConfig(value: string): PoolConfig {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("DATABASE_CONFIGURATION"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
      !url.username || url.pathname.length < 2 || url.hash || url.search) {
    throw new Error("DATABASE_CONFIGURATION");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return {
    connectionString: value,
    ssl: local ? false : { rejectUnauthorized: true },
    max: 8, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  };
}

export class PgDatabase implements TransactionPool {
  private readonly pool: Pool;
  constructor(connectionString: string, onIdleError: () => void = () => {}) {
    this.pool = new Pool(databaseConfig(connectionString));
    // Never pass driver error objects containing connection details to logs.
    this.pool.on("error", onIdleError);
  }
  async query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
    const result = await this.pool.query(text, values);
    return { rows: result.rows as R[] };
  }
  async connect(): Promise<TransactionClient> {
    const client = await this.pool.connect();
    return {
      query: async <R = unknown>(text: string, values?: unknown[]) => {
        const result = await client.query(text, values);
        return { rows: result.rows as R[] };
      },
      release: () => client.release(),
    };
  }
  async close(): Promise<void> { await this.pool.end(); }
}
