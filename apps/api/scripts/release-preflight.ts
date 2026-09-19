import { runtimeConfig } from "../src/config.js";
import { PgDatabase, databaseConfig } from "../src/modules/session/pg-database.js";
import { authenticatorFromEnv } from "../src/modules/auth/index.js";
import { questionBankFromEnv } from "../src/modules/scenario/question-bank.js";
import { assertDurableSchema } from "../src/storage.js";

async function main() {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  if (args.length > 1 || (args[0] && args[0] !== "--database")) {
    throw new Error("Usage: pnpm release:preflight [--database]");
  }
  // Deliberately do not load a developer's env file. Operators inject the exact
  // release environment. Offline validation performs no network or file writes.
  const config = runtimeConfig({ ...process.env, NODE_ENV: "production" });
  databaseConfig(config.databaseUrl!);
  authenticatorFromEnv(process.env);
  questionBankFromEnv(process.env, new Map());
  if (config.release === "development") throw new Error("RELEASE_ID_REQUIRED");
  console.log("Production configuration valid (values withheld).");
  if (args[0] !== "--database") {
    console.log("Offline check only; database, provider and hosted acceptance remain pending.");
    return;
  }
  const db = new PgDatabase(config.databaseUrl!);
  try {
    const client = await db.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await assertDurableSchema(client);
      // Check effective privileges as well as RLS. An accidental table grant
      // can expose data through a later permissive policy or view.
      const tableAccess = await client.query<{ exposed: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_roles role CROSS JOIN pg_class relation
        JOIN pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE role.rolname IN ('anon','authenticated') AND ns.nspname='public'
          AND relation.relkind IN ('r','p','v','m')
          AND relation.relname = ANY($1::text[])
          AND (has_table_privilege(role.oid,relation.oid,'SELECT')
            OR has_table_privilege(role.oid,relation.oid,'INSERT')
            OR has_table_privilege(role.oid,relation.oid,'UPDATE')
            OR has_table_privilege(role.oid,relation.oid,'DELETE'))
      ) AS exposed`, [[
        "interview_sessions", "session_events", "session_reports", "socket_tickets",
        "consent_grants", "session_runtime_owners", "runtime_inputs", "interview_preparations",
        "api_rate_limits", "privacy_deletion_requests", "support_incidents", "interview_questions",
      ]]);
      if (tableAccess.rows[0]?.exposed !== false) throw new Error("PRIVATE_TABLE_ACCESS_EXPOSED");
      const functions = await client.query<{ exposed: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_roles role CROSS JOIN pg_proc proc
        JOIN pg_namespace ns ON ns.oid=proc.pronamespace
        WHERE role.rolname IN ('anon','authenticated') AND ns.nspname='public'
          AND proc.prosecdef AND has_function_privilege(role.oid,proc.oid,'EXECUTE')
      ) AS exposed`);
      if (functions.rows[0]?.exposed !== false) throw new Error("DEFINER_FUNCTION_ACCESS_EXPOSED");
      const bank = await client.query<{ available: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM public.interview_questions WHERE status='ACTIVE') AS available",
      );
      if (bank.rows[0]?.available !== true) throw new Error("ACTIVE_QUESTION_BANK_REQUIRED");
      await client.query("COMMIT");
      console.log("Required schema, API privileges, browser-role isolation and active bank passed (read-only).");
      console.log("Run db:migrate --check separately with the migration connection to verify the release journal.");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  } finally { await db.close(); }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  // No driver/provider exception strings or environment values reach output.
  const allowed = /^(CONFIGURATION_INVALID:[A-Z_,]+|RELEASE_ID_REQUIRED|STORAGE_SCHEMA_INCOMPLETE|DATABASE_CONFIGURATION|PRIVATE_TABLE_ACCESS_EXPOSED|DEFINER_FUNCTION_ACCESS_EXPOSED|ACTIVE_QUESTION_BANK_REQUIRED)$/;
  console.error(allowed.test(message) || message.startsWith("Usage:") ? message : "RELEASE_PREFLIGHT_FAILED");
  process.exitCode = 1;
});
