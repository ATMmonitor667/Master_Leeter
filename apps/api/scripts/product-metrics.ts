import { PgDatabase } from "../src/modules/session/pg-database.js";

interface Counts {
  attempted_interviews: string;
  completed_interviews: string;
  activated_voice: string;
  reports_ready: string;
  report_failures: string;
  accounts_with_interviews: string;
  returning_accounts: string;
  disconnected_interviews: string;
  recovered_interviews: string;
  support_incidents: string;
  pending_deletions: string;
  mean_report_seconds: string | null;
}

function daysArgument(args: string[]): number {
  if (args.length === 0) return 30;
  if (args.length !== 2 || args[0] !== "--days") throw new Error("Usage: pnpm product:metrics [--days 1..365]");
  const days = Number(args[1]);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("METRICS_DAYS_INVALID");
  return days;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : null;
}

async function main() {
  const days = daysArgument(process.argv.slice(2));
  const connectionString = process.env["METRICS_DATABASE_URL"]?.trim() || process.env["DATABASE_URL"]?.trim();
  if (!connectionString) throw new Error("METRICS_DATABASE_URL_REQUIRED");
  const db = new PgDatabase(connectionString);
  try {
    const result = await db.query<Counts>(`WITH recent AS (
        SELECT * FROM public.interview_sessions
        WHERE deleted_at IS NULL AND created_at >= now() - ($1::integer * interval '1 day')
      ), account_counts AS (
        SELECT user_id,count(*) AS interviews FROM recent GROUP BY user_id
      ), event_flags AS (
        SELECT e.session_id,
          bool_or(e.type='BRIEF_DELIVERED') AS voice,
          bool_or(e.type='CONNECTION_LOST') AS disconnected,
          bool_or(e.type='CONNECTION_RESTORED') AS recovered
        FROM public.session_events e JOIN recent s ON s.id=e.session_id GROUP BY e.session_id
      ) SELECT
        (SELECT count(*) FROM recent)::text AS attempted_interviews,
        (SELECT count(*) FROM recent WHERE ended_at IS NOT NULL)::text AS completed_interviews,
        (SELECT count(*) FROM event_flags WHERE voice)::text AS activated_voice,
        (SELECT count(*) FROM public.session_reports r JOIN recent s ON s.id=r.session_id WHERE r.status='READY')::text AS reports_ready,
        (SELECT count(*) FROM public.session_reports r JOIN recent s ON s.id=r.session_id WHERE r.status='FAILED')::text AS report_failures,
        (SELECT count(*) FROM account_counts)::text AS accounts_with_interviews,
        (SELECT count(*) FROM account_counts WHERE interviews >= 2)::text AS returning_accounts,
        (SELECT count(*) FROM event_flags WHERE disconnected)::text AS disconnected_interviews,
        (SELECT count(*) FROM event_flags WHERE disconnected AND recovered)::text AS recovered_interviews,
        (SELECT count(*) FROM public.support_incidents WHERE created_at >= now() - ($1::integer * interval '1 day'))::text AS support_incidents,
        (SELECT count(*) FROM public.privacy_deletion_requests WHERE completed_at IS NULL)::text AS pending_deletions,
        (SELECT round(avg(extract(epoch FROM (r.completed_at-r.created_at)))::numeric,2)::text
          FROM public.session_reports r JOIN recent s ON s.id=r.session_id
          WHERE r.status='READY' AND r.completed_at IS NOT NULL) AS mean_report_seconds`, [days]);
    const row = result.rows[0];
    if (!row) throw new Error("METRICS_UNAVAILABLE");
    const number = (value: string) => Number.parseInt(value, 10);
    const attempted = number(row.attempted_interviews);
    const completed = number(row.completed_interviews);
    const voice = number(row.activated_voice);
    const disconnected = number(row.disconnected_interviews);
    const output = {
      windowDays: days,
      generatedAt: new Date().toISOString(),
      counts: {
        attemptedInterviews: attempted,
        completedInterviews: completed,
        activatedVoice: voice,
        reportsReady: number(row.reports_ready),
        reportFailures: number(row.report_failures),
        accountsWithInterviews: number(row.accounts_with_interviews),
        returningAccounts: number(row.returning_accounts),
        disconnectedInterviews: disconnected,
        recoveredInterviews: number(row.recovered_interviews),
        supportIncidents: number(row.support_incidents),
        pendingDeletions: number(row.pending_deletions),
      },
      ratesPercent: {
        voiceActivation: rate(voice, attempted),
        completion: rate(completed, attempted),
        reportReadyAfterCompletion: rate(number(row.reports_ready), completed),
        recoveryAfterDisconnect: rate(number(row.recovered_interviews), disconnected),
        returningAccounts: rate(number(row.returning_accounts), number(row.accounts_with_interviews)),
      },
      latencySeconds: {
        meanReportReady: row.mean_report_seconds === null ? null : Number.parseFloat(row.mean_report_seconds),
      },
      scope: "Aggregate counts only; deleted sessions, user IDs, session IDs, content, transcripts and code are excluded.",
      externalSignals: "Visits and Supabase signups remain provider/host metrics. This command does not infer them from application traffic.",
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  const safe = error instanceof Error && [
    "METRICS_DATABASE_URL_REQUIRED", "METRICS_DAYS_INVALID", "METRICS_UNAVAILABLE",
  ].includes(error.message) ? error.message : error instanceof Error && error.message.startsWith("Usage:")
    ? error.message : "METRICS_UNAVAILABLE";
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
});
