import { createHash, randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { z } from "zod";
import { databaseConfig } from "../src/modules/session/pg-database.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const acknowledgement = "I_UNDERSTAND_THIS_REPLAYS_PRIVATE_DATA_DELETIONS";
const RecordSchema = z.object({
  id: z.string().uuid(), scope: z.enum(["SESSION", "ACCOUNT"]), userId: z.string().min(1).max(200),
  sessionIds: z.array(z.string().uuid()), requestedAt: z.string().datetime(),
});
const LedgerSchema = z.object({
  format: z.literal("master-leeter-erasure-ledger-v1"), exportedAt: z.string().datetime(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), records: z.array(RecordSchema),
  recordsSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

function artifact(value: string | undefined): string {
  if (!value || !isAbsolute(value)) throw new Error("ABSOLUTE_LEDGER_PATH_REQUIRED");
  const path = resolve(value); const inside = relative(root, path);
  if ((!inside || (!inside.startsWith("..") && !isAbsolute(inside))) || extname(path) !== ".json") {
    throw new Error("LEDGER_PATH_MUST_BE_JSON_OUTSIDE_REPOSITORY");
  }
  return path;
}
function connection(name: string) {
  const value = process.env[name]?.trim(); if (!value) throw new Error(`${name}_REQUIRED`);
  const config = databaseConfig(value); const url = new URL(value);
  const database = decodeURIComponent(url.pathname.slice(1));
  const fingerprint = createHash("sha256").update(`${url.hostname.toLowerCase()}\0${url.port || "5432"}\0${database}`).digest("hex");
  return { value, config, database, fingerprint };
}
const digest = (records: unknown) => createHash("sha256").update(JSON.stringify(records)).digest("hex");

async function exportLedger(path: string) {
  try { await access(path, constants.F_OK); throw new Error("REFUSING_TO_OVERWRITE_LEDGER"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const source = connection("ERASURE_LEDGER_DATABASE_URL"); const pool = new Pool({ ...source.config, max: 1 });
  try {
    const result = await pool.query<{ id: string; scope: "SESSION" | "ACCOUNT"; user_id: string; session_ids: string[]; requested_at: Date | string }>(
      "SELECT id,scope,user_id,session_ids,requested_at FROM public.privacy_deletion_requests ORDER BY requested_at,id");
    const records = result.rows.map((row) => ({ id: row.id, scope: row.scope, userId: row.user_id,
      sessionIds: row.session_ids, requestedAt: new Date(row.requested_at).toISOString() }));
    const ledger = { format: "master-leeter-erasure-ledger-v1", exportedAt: new Date().toISOString(),
      sourceFingerprint: source.fingerprint, records, recordsSha256: digest(records) };
    await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Exported ${records.length} deletion records to ${path}`);
  } finally { await pool.end(); }
}

async function replayLedger(path: string) {
  const parsed = LedgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (digest(parsed.records) !== parsed.recordsSha256) throw new Error("LEDGER_CHECKSUM_MISMATCH");
  const target = connection("RESTORE_DATABASE_URL");
  if (target.fingerprint === parsed.sourceFingerprint) throw new Error("RESTORE_TARGET_MATCHES_LEDGER_SOURCE");
  if (process.env["RESTORE_CONFIRM_DATABASE"] !== target.database) throw new Error("RESTORE_CONFIRM_DATABASE_MUST_MATCH_TARGET");
  if (process.env["ERASURE_REPLAY_ACK"] !== acknowledgement) throw new Error(`ERASURE_REPLAY_ACK_MUST_EQUAL_${acknowledgement}`);
  const pool = new Pool({ ...target.config, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      for (const record of parsed.records) await client.query(`INSERT INTO public.privacy_deletion_requests
        (id,dedupe_key,scope,reason,user_id,session_ids,requested_at)
        VALUES ($1::uuid,$2,$3,'RESTORE_REPLAY',$4,$5::uuid[],$6::timestamptz)
        ON CONFLICT (dedupe_key) DO NOTHING`, [randomUUID(),`restore:${parsed.sourceFingerprint}:${record.id}`,
        record.scope,record.userId,record.sessionIds,record.requestedAt]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    console.log(`Queued ${parsed.records.length} deletion records for replay. Boot the API with admission disabled and wait for the privacy queue to drain.`);
  } finally { client.release(); await pool.end(); }
}

async function status() {
  const source = connection("ERASURE_LEDGER_DATABASE_URL"); const pool = new Pool({ ...source.config, max: 1 });
  try {
    const result = await pool.query<{ pending: string; completed: string }>(`SELECT
      count(*) FILTER (WHERE completed_at IS NULL)::text AS pending,
      count(*) FILTER (WHERE completed_at IS NOT NULL)::text AS completed
      FROM public.privacy_deletion_requests`);
    console.log(`Deletion ledger: ${result.rows[0]?.pending ?? "0"} pending, ${result.rows[0]?.completed ?? "0"} completed.`);
    if (result.rows[0]?.pending !== "0") process.exitCode = 2;
  } finally { await pool.end(); }
}

async function main() {
  const [command, pathValue, ...extra] = process.argv.slice(2).filter((arg) => arg !== "--");
  if (command === "status" && !pathValue && !extra.length) return status();
  if (extra.length || !["export", "replay"].includes(command ?? "")) {
    throw new Error("USAGE_PRIVACY_LEDGER_EXPORT_OR_REPLAY_AND_ABSOLUTE_JSON_PATH");
  }
  const path = artifact(pathValue);
  await (command === "export" ? exportLedger(path) : replayLedger(path));
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  console.error(/^[A-Z0-9_]+$/.test(message) || message.startsWith("ERASURE_REPLAY_ACK_MUST_EQUAL_")
    ? message : "PRIVACY_LEDGER_COMMAND_FAILED"); process.exitCode = 1;
});
