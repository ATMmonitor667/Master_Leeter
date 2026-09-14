import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "./pg-database.js";
import { PgSessionStore } from "./pg-session-store.js";
import { PgEventLog } from "./pg-event-log.js";
import { loadScenarioLibrary, type LoadedScenario } from "../scenario/loader.js";
import { reconstruct } from "./resume.js";

const adminUrl = process.env["TEST_DATABASE_ADMIN_URL"];
if (!adminUrl && process.env["REQUIRE_DATABASE_TESTS"] === "1") throw new Error("TEST_DATABASE_ADMIN_URL_REQUIRED");

// Never migrate or clear the caller's database. Only the randomly generated
// database below receives writes. The maintenance server MUST be loopback.
describe.skipIf(!adminUrl)("PostgreSQL migrations and repository integration", () => {
  const name = `ml_test_${randomUUID().replaceAll("-", "")}`;
  const role = `ml_reader_${randomUUID().replaceAll("-", "")}`;
  let admin: PgDatabase | undefined;
  let db: PgDatabase;
  let created = false;
  let roleCreated = false;
  let connection: string;
  let scenario: LoadedScenario;
  let store: PgSessionStore;

  beforeAll(async () => {
    let url: URL;
    try { url = new URL(adminUrl!); } catch { throw new Error("INVALID_TEST_DATABASE_URL"); }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        !["/postgres", "/template1"].includes(url.pathname)) throw new Error("LOCAL_MAINTENANCE_DATABASE_REQUIRED");
    admin = new PgDatabase(url.toString());
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    connection = url.toString();
    db = new PgDatabase(connection);
    // Temporary cluster role belongs to this run; never change existing roles.
    await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
    roleCreated = true;
    for (const migration of ["001_init.sql", "002_session_storage.sql", "003_client_sequence.sql"]) {
      await db.query(await readFile(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
    }
    const library = await loadScenarioLibrary(fileURLToPath(new URL("../../../../../content/scenarios/", import.meta.url)));
    scenario = library.get("conveyor-rescan@1")!;
    store = new PgSessionStore(db);
  }, 30_000);

  afterAll(async () => {
    try {
      if (db) await db.close();
      // Only names generated in this test are ever deletion targets.
      if (created && /^ml_test_[a-f0-9]{32}$/.test(name)) await admin!.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      if (roleCreated && /^ml_reader_[a-f0-9]{32}$/.test(role)) await admin!.query(`DROP ROLE "${role}"`);
    } finally { await admin?.close(); }
  }, 30_000);

  const create = (key = randomUUID(), userId = randomUUID()) => store.create({
    userId, scenario, mode: "MOCK", idempotencyKey: key,
  });

  it("deduplicates concurrent creates per user without cross-user collisions", async () => {
    const user = randomUUID();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 16 }, () => create(key, user)));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect((await create(key)).id).not.toBe(results[0]!.id);
    expect(await store.idsForUser(user)).toEqual([results[0]!.id]);
  });

  it("persists pins and reconstructs code/notes through a fresh pool", async () => {
    const session = await create();
    const log = new PgEventLog(db);
    const base = { sessionId: session.id, scenarioVersionId: scenario.version.id, actor: "CANDIDATE" as const, traceId: session.traceId };
    await log.append({ ...base, type: "CODE_DELTA", payload: { revision: 3, text: "def solve(): pass" }, idempotencyKey: "code" });
    await log.append({ ...base, type: "NOTE_DELTA", payload: { text: "try a hash map" }, idempotencyKey: "notes" });
    const fresh = new PgDatabase(connection);
    try {
      expect(await new PgSessionStore(fresh).get(session.id)).toEqual(session);
      expect(await new PgSessionStore(fresh).pinnedScenario(session.id)).toEqual(scenario);
      expect(await reconstruct(new PgEventLog(fresh), session.id, session.state)).toMatchObject({
        code: "def solve(): pass", codeRevision: 3, notes: "try a hash map", lastSeq: 1,
      });
    } finally { await fresh.close(); }
  });

  it("serializes concurrent appends with no gaps and returns original retries", async () => {
    const session = await create();
    const log = new PgEventLog(db);
    const base = { sessionId: session.id, scenarioVersionId: scenario.version.id, actor: "CANDIDATE" as const, type: "NOTE_DELTA" as const, traceId: session.traceId };
    await Promise.all(Array.from({ length: 32 }, (_, n) => log.append({ ...base, payload: { text: `note-${n}` }, idempotencyKey: `key-${n}` })));
    expect((await log.read(session.id)).map((event) => event.seq)).toEqual(Array.from({ length: 32 }, (_, n) => n));
    const retries = await Promise.all(Array.from({ length: 8 }, () => log.append({ ...base, payload: { text: "changed retry" }, idempotencyKey: "key-0" })));
    expect(retries.every((result) => result.duplicate && result.event.payload["text"] === "note-0")).toBe(true);
    expect(await log.latestSeq(session.id)).toBe(31);
    await expect(log.append({ ...base, scenarioVersionId: "wrong@1", payload: {}, idempotencyKey: "bad" })).rejects.toThrow("SCENARIO_PIN_MISMATCH");
    expect(await log.latestSeq(session.id)).toBe(31);
    await expect(log.append({ ...base, actor: "INVALID" as "CANDIDATE", payload: {}, idempotencyKey: "failed-insert" })).rejects.toThrow();
    expect((await log.append({ ...base, payload: {}, idempotencyKey: "after-rollback" })).event.seq).toBe(32);
  });

  it("persists browser sequence progress and rejects reuse with another key", async () => {
    const session = await create();
    const log = new PgEventLog(db);
    const base = { sessionId: session.id, scenarioVersionId: scenario.version.id, actor: "CANDIDATE" as const, type: "NOTE_DELTA" as const, traceId: session.traceId };
    const first = await log.append({ ...base, payload: { text: "first" }, idempotencyKey: "client-0", clientSeq: 0 });
    expect(first.duplicate).toBe(false);
    const fresh = new PgDatabase(connection);
    try { expect(await new PgEventLog(fresh).latestClientSeq(session.id)).toBe(0); }
    finally { await fresh.close(); }
    expect((await log.append({ ...base, payload: { text: "retry" }, idempotencyKey: "client-0", clientSeq: 0 })).duplicate).toBe(true);
    await expect(log.append({ ...base, payload: { text: "collision" }, idempotencyKey: "another-key", clientSeq: 0 }))
      .rejects.toThrow("CLIENT_SEQUENCE_CONFLICT");
    expect(await log.latestSeq(session.id)).toBe(0);
  });

  it("keeps pause increments atomic and completed sessions terminal", async () => {
    const session = await create();
    await Promise.all(Array.from({ length: 16 }, () => store.addPause(session.id, 2)));
    expect((await store.get(session.id))!.pausedSeconds).toBe(32);
    const ended = await store.end(session.id);
    expect(await store.end(session.id)).toEqual(ended);
    expect(await store.transition(session.id, "IMPLEMENTATION")).toEqual(ended);
  });

  it("enforces immutable pins and append-only events in the database", async () => {
    const session = await create();
    await expect(db.query("UPDATE public.interview_sessions SET scenario_hash='changed' WHERE id=$1", [session.id])).rejects.toThrow();
    await new PgEventLog(db).append({ ...requestFor(session.id, session.traceId), idempotencyKey: "immutable" });
    await expect(db.query("DELETE FROM public.session_events WHERE session_id=$1", [session.id])).rejects.toThrow();
  });

  it("denies private rows to an unprivileged role even with SELECT grants", async () => {
    const session = await create();
    await new PgEventLog(db).append({ ...requestFor(session.id, session.traceId), idempotencyKey: "private-event" });
    await db.query("INSERT INTO public.session_reports (session_id,rubric_id,status,body) VALUES ($1,'test-rubric','READY',$2::jsonb)", [session.id, JSON.stringify({ private: "report" })]);
    for (const table of ["interview_sessions", "session_events", "session_reports"]) {
      const privileges = await db.query<{ allowed: boolean }>("SELECT has_table_privilege($1,$2,'SELECT') AS allowed", [role, `public.${table}`]);
      expect(privileges.rows[0]!.allowed).toBe(false);
    }
    await db.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await db.query(`GRANT SELECT ON public.interview_sessions,public.session_events,public.session_reports TO "${role}"`);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE "${role}"`);
      expect((await client.query("SELECT id FROM public.interview_sessions WHERE id=$1", [session.id])).rows).toEqual([]);
      expect((await client.query("SELECT * FROM public.session_events")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM public.session_reports")).rows).toEqual([]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  function requestFor(sessionId: string, traceId: string) {
    return { sessionId, traceId, scenarioVersionId: scenario.version.id, type: "NOTE_DELTA" as const, actor: "CANDIDATE" as const, payload: { text: "private" } };
  }
});
