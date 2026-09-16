import { PgSocketTickets } from "./modules/auth/pg-socket-tickets.js";
import { PgConsentStore } from "./modules/privacy/pg-consent-store.js";
import { PgReportJobStore } from "./modules/report/pg-report-store.js";
import { PgDatabase } from "./modules/session/pg-database.js";
import { PgEventLog, type QueryClient, type TransactionPool } from "./modules/session/pg-event-log.js";
import { PgSessionLifecycle } from "./modules/session/pg-lifecycle.js";
import { PgSessionStore } from "./modules/session/pg-session-store.js";
import { PgRuntimeOwnership } from "./modules/session/runtime-ownership.js";
import { PgPreparationStore } from "./modules/preparation/pg-store.js";

export interface StorageDatabase extends TransactionPool { close(): Promise<void> }

/** Check each required privilege separately: PostgreSQL comma lists mean ANY. */
const tableRequirements = [
  ["interview_sessions", ["SELECT", "INSERT", "UPDATE"]],
  ["session_events", ["SELECT", "INSERT"]],
  ["session_reports", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
  ["socket_tickets", ["SELECT", "INSERT", "DELETE"]],
  ["consent_grants", ["SELECT", "INSERT", "DELETE"]],
  ["session_runtime_owners", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
  ["runtime_inputs", ["SELECT", "INSERT", "UPDATE"]],
  ["interview_preparations", ["SELECT", "INSERT", "UPDATE"]],
] as const;

export async function assertDurableSchema(db: QueryClient): Promise<void> {
  const accessChecks = tableRequirements.flatMap(([table, privileges]) =>
    privileges.map((privilege) =>
      `has_table_privilege(current_user, to_regclass('public.${table}'), '${privilege}') AS ${table}_${privilege.toLowerCase()}`));
  const result = await db.query<Record<string, boolean | null>>(`SELECT
    ${accessChecks.join(",\n    ")},
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='interview_sessions' AND column_name='deleted_at') AS tombstones,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='session_events' AND column_name='client_seq') AS client_sequence,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='session_reports' AND column_name='lease_token') AS report_leases,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='session_reports' AND column_name='progress') AS grader_progress,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='interview_sessions' AND column_name='interviewer_tone') AS preparation_tone,
    has_function_privilege(current_user, to_regprocedure('public.redact_session_events(uuid)'), 'EXECUTE') AS redaction`);
  const row = result.rows[0];
  if (!row || Object.keys(row).length !== accessChecks.length + 6 ||
      Object.values(row).some((value) => value !== true)) throw new Error("STORAGE_SCHEMA_INCOMPLETE");
}

/**
 * Complete repository composition for integration acceptance. Startup activation
 * remains separate until runtime ownership, routing and deadlines are durable.
 * No migrations or writes are performed by this factory.
 */
export async function createSupabaseStorage(
  connectionString: string,
  createDatabase: (url: string) => StorageDatabase = (url) => new PgDatabase(url),
) {
  const db = createDatabase(connectionString);
  try {
    await assertDurableSchema(db);
  } catch (error) {
    try { await db.close(); } catch { /* Preserve readiness failure. */ }
    // Driver errors can include host/connection details. Expose only safe codes.
    throw new Error(error instanceof Error && error.message === "STORAGE_SCHEMA_INCOMPLETE"
      ? "STORAGE_SCHEMA_INCOMPLETE" : "STORAGE_UNAVAILABLE");
  }
  let closing: Promise<void> | undefined;
  return {
    sessionStore: new PgSessionStore(db),
    eventLog: new PgEventLog(db),
    lifecycle: new PgSessionLifecycle(db),
    runtimeOwnership: new PgRuntimeOwnership(db),
    socketTickets: new PgSocketTickets(db),
    consentStore: new PgConsentStore(db),
    reportJobStore: new PgReportJobStore(db),
    preparationStore: new PgPreparationStore(db),
    closeStorage: () => closing ??= db.close(),
  };
}
