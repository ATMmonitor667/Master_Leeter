import { Pool, type PoolClient, type PoolConfig } from "pg";
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
  private leaseClient: PoolClient | undefined;
  private leaseHealthy = false;
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

  /** Hold one session advisory lock for the lifetime of the hosted API. */
  async acquireProcessLease(): Promise<void> {
    if (this.leaseClient) throw new Error("API_REPLICA_LEASE_ALREADY_HELD");
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(506205347141724093::bigint) AS acquired",
      );
      if (result.rows[0]?.acquired !== true) throw new Error("API_REPLICA_ALREADY_ACTIVE");
      this.leaseClient = client;
      this.leaseHealthy = true;
      client.on("error", () => { this.leaseHealthy = false; });
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async checkProcessLease(): Promise<void> {
    if (!this.leaseClient || !this.leaseHealthy) throw new Error("API_REPLICA_LEASE_LOST");
    try { await this.leaseClient.query("SELECT 1"); }
    catch { this.leaseHealthy = false; throw new Error("API_REPLICA_LEASE_LOST"); }
  }

  isProcessLeaseHealthy(): boolean { return Boolean(this.leaseClient && this.leaseHealthy); }

  async close(): Promise<void> {
    const client = this.leaseClient;
    this.leaseClient = undefined;
    this.leaseHealthy = false;
    if (client) {
      try { await client.query("SELECT pg_advisory_unlock(506205347141724093::bigint)"); }
      catch { /* A dropped connection has already released its session locks. */ }
      client.release();
    }
    await this.pool.end();
  }
}
