import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "./pg-database.js";
import { PgSessionStore } from "./pg-session-store.js";
import { PgEventLog } from "./pg-event-log.js";
import { loadScenarioLibrary, type LoadedScenario } from "../scenario/loader.js";
import { reconstruct } from "./resume.js";
import { PgSocketTickets } from "../auth/pg-socket-tickets.js";
import { PgReportJobStore } from "../report/pg-report-store.js";
import type { SessionReport } from "../report/evaluator.js";
import { PgConsentStore } from "../privacy/pg-consent-store.js";
import { PgSessionLifecycle } from "./pg-lifecycle.js";
import { createSupabaseStorage } from "../../storage.js";
import { buildServer } from "../../index.js";
import { EvaluationQueue } from "../report/index.js";
import { PgRuntimeOwnership } from "./runtime-ownership.js";

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
    for (const migration of ["001_init.sql", "002_session_storage.sql", "003_client_sequence.sql", "004_socket_tickets.sql", "005_report_job_leases.sql", "006_consent_grants.sql", "007_deletion_tombstones.sql", "008_runtime_ownership.sql"]) {
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

  it("serves persisted sessions and resumes code from a fresh server over the full bundle", async () => {
    const session = await create();
    const firstStorage = await createSupabaseStorage(connection);
    const first = buildServer({ library: new Map(), ...firstStorage });
    await first.ready();
    try {
      await firstStorage.eventLog.append({
        sessionId: session.id, scenarioVersionId: session.scenarioVersionId,
        type: "CODE_DELTA", actor: "CANDIDATE", traceId: session.traceId,
        payload: { revision: 7, text: "def solve(): return 42" },
        clientSeq: 4, idempotencyKey: "bundle-restart-code",
      });
    } finally { await first.close(); }
    const secondStorage = await createSupabaseStorage(connection);
    const second = buildServer({ library: new Map(), ...secondStorage });
    await second.ready();
    try {
      const response = await second.inject({ method: "GET", url: `/v1/interview-sessions/${session.id}` });
      expect(response.statusCode).toBe(200);
      expect(await secondStorage.eventLog.latestClientSeq(session.id)).toBe(4);
      expect((await secondStorage.eventLog.read(session.id))[0]?.payload)
        .toEqual({ revision: 7, text: "def solve(): return 42" });
    } finally { await second.close(); }
  });

  it("deduplicates concurrent creates per user without cross-user collisions", async () => {
    const user = randomUUID();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 16 }, () => create(key, user)));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect((await create(key)).id).not.toBe(results[0]!.id);
    expect(await store.idsForUser(user)).toEqual([results[0]!.id]);
  });

  it("fences stale runtime writes and transitions across independent pools", async () => {
    const session = await create();
    const fresh = new PgDatabase(connection);
    try {
      const first = new PgRuntimeOwnership(db);
      const second = new PgRuntimeOwnership(fresh);
      const claims = await Promise.all([first.claim(session.id), second.claim(session.id)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const old = claims.find(Boolean)!;
      await db.query("UPDATE public.session_runtime_owners SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [session.id]);
      expect(await first.renew(session.id, old)).toBe(false);
      const replacement = await second.claim(session.id);
      expect(replacement).toBeTruthy();
      expect(replacement).not.toBe(old);
      await first.release(session.id, old);
      expect(await second.renew(session.id, replacement!)).toBe(true);
      const log = new PgEventLog(db);
      await expect(log.append({ ...requestFor(session.id, session.traceId), runtimeToken: old, idempotencyKey: "stale" }))
        .rejects.toThrow("RUNTIME_OWNERSHIP_LOST");
      await expect(new PgSessionLifecycle(db).transitionWithEvent(session.id, "ORAL_PROBLEM_DELIVERY", "CLARIFICATION", "stale", old))
        .rejects.toThrow("RUNTIME_OWNERSHIP_LOST");
      expect((await store.get(session.id))?.state).toBe("ORAL_PROBLEM_DELIVERY");
      expect(await log.read(session.id)).toEqual([]);
      await log.append({ ...requestFor(session.id, session.traceId), runtimeToken: replacement!, idempotencyKey: "current" });
      await store.end(session.id);
      expect(await second.renew(session.id, replacement!)).toBe(false);
      await expect(log.append({ ...requestFor(session.id, session.traceId), runtimeToken: replacement!, idempotencyKey: "after-end" }))
        .rejects.toThrow("RUNTIME_OWNERSHIP_LOST");
    } finally { await fresh.close(); }
  });

  it("discovers committed report work after restart without a report request", async () => {
    const lifecycle = new PgSessionLifecycle(db);
    const session = await lifecycle.createStarted({ userId: randomUUID(), scenario,
      mode: "MOCK", idempotencyKey: randomUUID() });
    await lifecycle.endWithReport(session.id, scenario.version.rubricId);
    const jobs = new PgReportJobStore(db);
    expect(await jobs.recoverable(new Date().toISOString(), 100)).toContain(session.id);
    const fresh = new PgDatabase(connection);
    try {
      const recovery = new EvaluationQueue(new PgEventLog(fresh), undefined, undefined, new PgReportJobStore(fresh));
      await recovery.recover(100);
      expect((await jobs.get(session.id))?.status).toBe("READY");
      expect(await jobs.recoverable(new Date().toISOString(), 100)).not.toContain(session.id);
    } finally { await fresh.close(); }
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

  it("shares and atomically consumes socket tickets across repository instances", async () => {
    const session = await create();
    const other = await create();
    const now = Date.now();
    const principal = { userId: session.userId, expiresAt: now + 60_000 };
    const issuer = new PgSocketTickets(db, () => now);
    const first = await issuer.issue(session.id, principal);
    const replacement = await issuer.issue(session.id, principal);
    const fresh = new PgDatabase(connection);
    const consumer = new PgSocketTickets(fresh, () => now);
    try {
      expect(await consumer.take(first, session.id)).toBeNull();
      expect(await consumer.take(replacement, other.id)).toBeNull();
      expect(await consumer.take(replacement, session.id)).toEqual(principal);
      expect(await issuer.take(replacement, session.id)).toBeNull();
    } finally {
      await fresh.close();
    }
  });

  it("recovers expired report work and fences the stale worker", async () => {
    const session = await create();
    const jobs = new PgReportJobStore(db);
    const t0 = "2026-09-13T00:00:00.000Z";
    await jobs.enqueue(session.id, "rubric-coding-v1", t0);
    const first = await jobs.claim(session.id, t0, "2026-09-13T00:00:10.000Z");
    expect(first).not.toBeNull();
    expect(await jobs.claim(session.id, "2026-09-13T00:00:05.000Z", "2026-09-13T00:00:15.000Z")).toBeNull();
    const fresh = new PgDatabase(connection);
    const replacement = await new PgReportJobStore(fresh)
      .claim(session.id, "2026-09-13T00:00:11.000Z", "2026-09-13T00:00:21.000Z");
    await fresh.close();
    expect(replacement).not.toBeNull();
    const report: SessionReport = {
      sessionId: session.id,
      scenarioVersionId: session.scenarioVersionId,
      rubricId: "rubric-coding-v1",
      rubricVersion: 1,
      generatedAt: "2026-09-13T00:00:12.000Z",
      overall: 50,
      dimensions: [],
      hintsUsed: [],
      probesAsked: [],
      missedOpportunities: [],
      drills: { communication: "practice", algorithmic: "practice", testing: "practice" },
    };
    expect(await jobs.complete(session.id, first!.token, report, report.generatedAt)).toBeNull();
    expect((await jobs.complete(session.id, replacement!.token, report, report.generatedAt))?.status).toBe("READY");
    expect((await new PgReportJobStore(db).get(session.id))?.report).toEqual(report);
  });

  it("persists consent history across pools and removes it for account deletion", async () => {
    const userId = randomUUID();
    const first = new PgConsentStore(db);
    await first.record(userId, {
      scope: "TRANSCRIPT",
      granted: true,
      decidedAt: "2026-09-13T00:00:00.000Z",
      noticeVersion: "consent-2026-08-1",
    });
    await first.record(userId, {
      scope: "TRANSCRIPT",
      granted: false,
      decidedAt: "2026-09-13T00:01:00.000Z",
      noticeVersion: "consent-2026-08-1",
    });
    const fresh = new PgDatabase(connection);
    try {
      const restored = new PgConsentStore(fresh);
      expect((await restored.get(userId)).grants.map((grant) => grant.granted)).toEqual([true, false]);
      expect(await restored.deleteForUser(userId)).toBe(2);
      expect((await first.get(userId)).grants).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  it("tombstones before redaction and refuses resurrection", async () => {
    const session = await create();
    const log = new PgEventLog(db);
    await log.append({ ...requestFor(session.id, session.traceId), idempotencyKey: "private-before-delete" });
    await store.end(session.id);
    await store.tombstone(session.id, "2026-09-13T00:00:00.000Z");
    expect(await log.redact(session.id)).toBe(1);
    expect(await store.get(session.id)).toBeNull();
    expect((await log.read(session.id))[0]?.payload).toEqual({ redacted: true });
    await expect(log.append({ ...requestFor(session.id, session.traceId), idempotencyKey: "resurrection" }))
      .rejects.toThrow("SESSION_DELETED");
    await expect(db.query("UPDATE public.session_events SET payload='{}'::jsonb WHERE session_id=$1", [session.id])).rejects.toThrow();
  });

  it("commits lifecycle evidence and the report outbox atomically", async () => {
    const lifecycle = new PgSessionLifecycle(db, () => "2026-09-13T00:10:00.000Z");
    const session = await lifecycle.createStarted({
      userId: randomUUID(),
      scenario,
      mode: "MOCK",
      idempotencyKey: randomUUID(),
    });
    expect((await new PgEventLog(db).read(session.id)).map((event) => event.type)).toEqual(["SESSION_STARTED"]);
    const transitioned = await lifecycle.transitionWithEvent(
      session.id,
      "ORAL_PROBLEM_DELIVERY",
      "CLARIFICATION",
      "brief delivered",
    );
    expect(transitioned.state).toBe("CLARIFICATION");
    await expect(lifecycle.transitionWithEvent(session.id, "ORAL_PROBLEM_DELIVERY", "CLARIFICATION", "stale"))
      .rejects.toThrow("STALE_SESSION_STATE");
    const ended = await lifecycle.endWithReport(session.id, scenario.version.rubricId);
    expect(ended.endedAt).toBe("2026-09-13T00:10:00.000Z");
    expect((await new PgEventLog(db).read(session.id)).map((event) => event.type)).toEqual([
      "SESSION_STARTED",
      "STATE_TRANSITIONED",
      "SESSION_ENDED",
    ]);
    expect(await new PgReportJobStore(db).get(session.id)).toMatchObject({ status: "QUEUED", rubricId: scenario.version.rubricId });
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
