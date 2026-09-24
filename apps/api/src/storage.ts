import { PgSocketTickets } from "./modules/auth/pg-socket-tickets.js";
import { PgConsentStore } from "./modules/privacy/pg-consent-store.js";
import { PgDeletionStore } from "./modules/privacy/pg-deletion-store.js";
import { PgReportJobStore } from "./modules/report/pg-report-store.js";
import { PgDatabase } from "./modules/session/pg-database.js";
import { PgEventLog, type QueryClient, type TransactionPool } from "./modules/session/pg-event-log.js";
import { PgSessionLifecycle } from "./modules/session/pg-lifecycle.js";
import { PgSessionStore } from "./modules/session/pg-session-store.js";
import { PgRuntimeOwnership } from "./modules/session/runtime-ownership.js";
import { PgPreparationStore } from "./modules/preparation/pg-store.js";
import { PgRateLimitStore, type SessionAdmissionPolicy } from "./modules/admission/index.js";
import { PgSupportIncidentStore } from "./modules/support/index.js";

export interface StorageDatabase extends TransactionPool {
  close(): Promise<void>;
  acquireProcessLease?(): Promise<void>;
  checkProcessLease?(): Promise<void>;
  isProcessLeaseHealthy?(): boolean;
}

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
  ["api_rate_limits", ["SELECT", "INSERT", "UPDATE"]],
  ["privacy_deletion_requests", ["SELECT", "INSERT", "UPDATE"]],
  ["support_incidents", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
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
      AND table_name='session_reports' AND column_name='viewed_at') AS report_engagement,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='interview_sessions' AND column_name='interviewer_tone') AS preparation_tone,
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND indexname='one_active_interview_per_user') AS one_active_interview,
    has_function_privilege(current_user, to_regprocedure('public.redact_session_events(uuid)'), 'EXECUTE') AS redaction`);
  const row = result.rows[0];
  if (!row || Object.keys(row).length !== accessChecks.length + 8 ||
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
  admission?: SessionAdmissionPolicy,
  enforceSingleReplica = false,
) {
  const db = createDatabase(connectionString);
  try {
    await assertDurableSchema(db);
    if (enforceSingleReplica) {
      if (!db.acquireProcessLease || !db.checkProcessLease || !db.isProcessLeaseHealthy) throw new Error("API_REPLICA_LEASE_UNAVAILABLE");
      await db.acquireProcessLease();
    }
  } catch (error) {
    try { await db.close(); } catch { /* Preserve readiness failure. */ }
    // Driver errors can include host/connection details. Expose only safe codes.
    const safe = error instanceof Error ? error.message : "";
    throw new Error(["STORAGE_SCHEMA_INCOMPLETE", "API_REPLICA_ALREADY_ACTIVE", "API_REPLICA_LEASE_UNAVAILABLE"].includes(safe)
      ? safe : "STORAGE_UNAVAILABLE");
  }
  let closing: Promise<void> | undefined;
  return {
    sessionStore: new PgSessionStore(db),
    eventLog: new PgEventLog(db),
    lifecycle: new PgSessionLifecycle(db, undefined, admission),
    runtimeOwnership: new PgRuntimeOwnership(db),
    socketTickets: new PgSocketTickets(db),
    consentStore: new PgConsentStore(db),
    deletionStore: new PgDeletionStore(db),
    supportStore: new PgSupportIncidentStore(db),
    reportJobStore: new PgReportJobStore(db),
    preparationStore: new PgPreparationStore(db),
    rateLimiter: new PgRateLimitStore(db),
    storageReadiness: async () => {
      if (enforceSingleReplica) await db.checkProcessLease!();
      await db.query("SELECT 1 AS ready");
    },
    writesPermitted: () => !enforceSingleReplica || db.isProcessLeaseHealthy!(),
    closeStorage: () => closing ??= db.close(),
  };
}
