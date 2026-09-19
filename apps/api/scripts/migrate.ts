import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { databaseConfig } from "../src/modules/session/pg-database.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const journal = "public.master_leeter_migrations";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const mode = args[0] ?? "--plan";
  if (args.length > 1 || !["--plan", "--status", "--apply"].includes(mode)) {
    throw new Error("Usage: pnpm db:migrate [--plan|--status|--apply]");
  }
  const migrations: Array<{ name: string; sql: string; checksum: string }> = [];
  for (const directory of ["supabase/migrations", "apps/api/migrations"]) {
    const names = (await readdir(resolve(root, directory))).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const name of names) {
      // Normalize checkout line endings so Windows and Linux record the same hash.
      const sql = (await readFile(resolve(root, directory, name), "utf8")).replace(/\r\n/g, "\n");
      migrations.push({ name: `${directory}/${name}`, sql, checksum: createHash("sha256").update(sql).digest("hex") });
    }
  }
  if (mode === "--plan") {
    for (const migration of migrations) console.log(`${migration.name} ${migration.checksum}`);
    console.log("Offline plan only. No database connection or writes.");
    return;
  }
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (!url) throw new Error("MIGRATION_DATABASE_URL_REQUIRED");
  const config = databaseConfig(url);
  const database = decodeURIComponent(new URL(url).pathname.slice(1));
  if (mode === "--apply" && process.env["MIGRATION_CONFIRM_DATABASE"] !== database) {
    throw new Error("MIGRATION_CONFIRM_DATABASE_MUST_MATCH_TARGET");
  }
  const pool = new Pool({ ...config, max: 1, statement_timeout: 120_000 });
  pool.on("error", () => { console.error("MIGRATION_CONNECTION_FAILED"); process.exitCode = 1; });
  try {
    const client = await pool.connect();
    try {
      // Requires a direct/session-pooler connection: this lock spans transactions.
      const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(728451, 1) AS locked");
      if (!locked.rows[0]?.locked) throw new Error("MIGRATION_ALREADY_RUNNING");
      try {
        const present = await client.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [journal]);
        const applied = present.rows[0]?.present
          ? (await client.query<{ name: string; checksum: string }>(`SELECT name,checksum FROM ${journal} ORDER BY position`)).rows
          : [];
        for (let i = 0; i < applied.length; i++) {
          if (applied[i]?.name !== migrations[i]?.name || applied[i]?.checksum !== migrations[i]?.checksum) {
            throw new Error("MIGRATION_HISTORY_DRIFT");
          }
        }
        for (let i = 0; i < migrations.length; i++) console.log(`${i < applied.length ? "APPLIED" : "PENDING"} ${migrations[i]!.name}`);
        if (mode === "--status") return;
        if (!present.rows[0]?.present) {
          const legacy = await client.query<{ present: boolean }>("SELECT to_regclass('public.interview_sessions') IS NOT NULL OR to_regclass('public.interview_questions') IS NOT NULL AS present");
          if (legacy.rows[0]?.present) throw new Error("MIGRATION_UNTRACKED_SCHEMA_REQUIRES_RECONCILIATION");
        }
        // One transaction covers both DDL and its journal entries. Existing
        // migrations have standalone outer BEGIN/COMMIT lines; retain function bodies.
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL lock_timeout = '10s'");
          await client.query(`CREATE TABLE IF NOT EXISTS ${journal} (
            position integer PRIMARY KEY, name text UNIQUE NOT NULL,
            checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
            applied_at timestamptz NOT NULL DEFAULT now()
          )`);
          await client.query(`ALTER TABLE ${journal} ENABLE ROW LEVEL SECURITY`);
          await client.query(`REVOKE ALL ON ${journal} FROM PUBLIC`);
          await client.query(`DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON ${journal} FROM anon; END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON ${journal} FROM authenticated; END IF;
          END $$`);
          for (let i = applied.length; i < migrations.length; i++) {
            const migration = migrations[i]!;
            await client.query(migration.sql.replace(/^\s*(?:BEGIN|COMMIT);\s*$/gm, ""));
            await client.query(`INSERT INTO ${journal}(position,name,checksum) VALUES ($1,$2,$3)`, [i + 1, migration.name, migration.checksum]);
          }
          await client.query("COMMIT");
          console.log(`Committed ${migrations.length - applied.length} migrations.`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock(728451, 1)");
      }
    } finally { client.release(); }
  } finally { await pool.end(); }
}

main().catch((error: unknown) => {
  // Driver messages can contain credentials, SQL or private data.
  const message = error instanceof Error ? error.message : "";
  console.error(/^(MIGRATION_[A-Z_]+|DATABASE_CONFIGURATION)$/.test(message) || message.startsWith("Usage:")
    ? message : "MIGRATION_FAILED: review database configuration and migration compatibility");
  process.exitCode = 1;
});
