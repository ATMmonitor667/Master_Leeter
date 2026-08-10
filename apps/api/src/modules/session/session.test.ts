import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadScenarioFile } from "../scenario/loader.js";
import type { LoadedScenario } from "../scenario/loader.js";
import { SessionChannel } from "./channel.js";
import { type EventLog, InMemoryEventLog, evidenceHash } from "./event-log.js";
import { InMemorySessionStore, SessionNotFoundError, remainingSeconds } from "./session-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");

let scenario: LoadedScenario;

beforeAll(async () => {
  scenario = await loadScenarioFile(SCENARIO_PATH);
});

/**
 * Conformance suite.
 *
 * Any EventLog implementation must pass this. Currently exercised against the
 * in-memory log; point it at PgEventLog with a live database and the Postgres
 * implementation is verified against the same contract rather than a
 * hand-written parallel set of tests that drift.
 */
function eventLogConformance(name: string, make: () => EventLog) {
  describe(`event log conformance — ${name}`, () => {
    let log: EventLog;
    const S = "00000000-0000-4000-8000-000000000001";

    const req = (key: string, overrides: Record<string, unknown> = {}) => ({
      sessionId: S,
      type: "CODE_DELTA" as const,
      actor: "CANDIDATE" as const,
      scenarioVersionId: "conveyor-rescan@1",
      payload: { revision: 1 },
      traceId: "t",
      idempotencyKey: key,
      ...overrides,
    });

    beforeEach(() => {
      log = make();
    });

    it("assigns strictly increasing sequence numbers from zero", async () => {
      const a = await log.append(req("k1"));
      const b = await log.append(req("k2"));
      const c = await log.append(req("k3"));
      expect([a.event.seq, b.event.seq, c.event.seq]).toEqual([0, 1, 2]);
    });

    it("assigns sequence server-side, ignoring anything the client thinks", async () => {
      const r = await log.append(req("k1", { seq: 99 } as Record<string, unknown>));
      expect(r.event.seq).toBe(0);
    });

    it("is idempotent — a replayed key returns the original event", async () => {
      const first = await log.append(req("same-key"));
      const second = await log.append(req("same-key", { payload: { revision: 2 } }));

      expect(second.duplicate).toBe(true);
      expect(second.event).toEqual(first.event);
      expect(await log.latestSeq(S)).toBe(0);
    });

    it("scopes idempotency to a session", async () => {
      const other = "00000000-0000-4000-8000-000000000002";
      await log.append(req("shared"));
      const r = await log.append(req("shared", { sessionId: other }));
      expect(r.duplicate).toBe(false);
      expect(r.event.seq).toBe(0);
    });

    it("reads back in sequence order", async () => {
      for (let i = 0; i < 5; i++) await log.append(req(`k${i}`));
      const events = await log.read(S);
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    });

    it("reads from a lower bound for reconnect replay", async () => {
      for (let i = 0; i < 5; i++) await log.append(req(`k${i}`));
      expect((await log.read(S, 3)).map((e) => e.seq)).toEqual([3, 4]);
    });

    it("reports -1 for a session with no events", async () => {
      expect(await log.latestSeq("00000000-0000-4000-8000-00000000000f")).toBe(-1);
    });

    it("stamps an evidence hash on every event", async () => {
      const r = await log.append(req("k1"));
      expect(r.event.evidenceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("exposes no mutation surface at all", () => {
      // Append-only is a type-level guarantee, not a convention (invariant 8).
      const surface = make() as unknown as Record<string, unknown>;
      expect(surface["update"]).toBeUndefined();
      expect(surface["delete"]).toBeUndefined();
      expect(surface["truncate"]).toBeUndefined();
    });
  });
}

eventLogConformance("in-memory", () => new InMemoryEventLog());

describe("evidence hash", () => {
  const base = {
    sessionId: "s",
    type: "SPEECH_FINAL" as const,
    actor: "CANDIDATE" as const,
    payload: { a: 1, b: 2 },
  };

  it("is stable regardless of payload key order", () => {
    expect(evidenceHash(base)).toBe(evidenceHash({ ...base, payload: { b: 2, a: 1 } }));
  });

  it("changes when the evidence changes", () => {
    expect(evidenceHash(base)).not.toBe(evidenceHash({ ...base, payload: { a: 1, b: 3 } }));
  });
});

describe("session store", () => {
  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  const create = (key = "idem-1") =>
    store.create({ userId: "u1", scenario, mode: "MOCK", idempotencyKey: key });

  it("pins the scenario version and its content hash", async () => {
    const s = await create();
    expect(s.scenarioVersionId).toBe("conveyor-rescan@1");
    expect(s.scenarioHash).toBe(scenario.contentHash);
  });

  it("pins policy at creation so a later config change cannot alter a live session", async () => {
    const s = await create();
    expect(s.policy.mode).toBe("MOCK");
    expect(s.policy.maxHintLevel).toBe(2);
  });

  it("takes duration from the scenario, not the mode default", async () => {
    const s = await create();
    expect(s.expectedSeconds).toBe(scenario.version.target.expectedMinutes * 60);
  });

  it("is idempotent on create", async () => {
    const a = await create("same");
    const b = await create("same");
    expect(b.id).toBe(a.id);
  });

  it("issues distinct sessions for distinct keys", async () => {
    expect((await create("a")).id).not.toBe((await create("b")).id);
  });

  it("refuses to start a session on a non-active scenario version", async () => {
    const retired: LoadedScenario = {
      ...scenario,
      version: { ...scenario.version, status: "RETIRED" },
    };
    await expect(
      store.create({ userId: "u1", scenario: retired, mode: "MOCK", idempotencyKey: "k" }),
    ).rejects.toThrow(/RETIRED/);
  });

  it("ends idempotently", async () => {
    const s = await create();
    const first = await store.end(s.id);
    const second = await store.end(s.id);
    expect(second.endedAt).toBe(first.endedAt);
    expect(second.state).toBe("EVALUATION");
  });

  it("throws a typed error for an unknown session", async () => {
    await expect(store.end("nope")).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe("timer", () => {
  it("does not start counting before the interview starts", async () => {
    const store = new InMemorySessionStore();
    const s = await store.create({ userId: "u", scenario, mode: "MOCK", idempotencyKey: "k" });
    expect(remainingSeconds(s, Date.now())).toBe(s.expectedSeconds);
  });

  it("excludes paused time so a dropped connection does not eat the clock", async () => {
    const start = Date.parse("2026-08-09T00:00:00.000Z");
    const store = new InMemorySessionStore(() => new Date(start).toISOString());
    const created = await store.create({ userId: "u", scenario, mode: "MOCK", idempotencyKey: "k" });
    await store.transition(created.id, "CLARIFICATION");
    await store.addPause(created.id, 120);

    const s = await store.get(created.id);
    if (!s) throw new Error("missing session");

    // Ten minutes of wall clock, two of which were a connection drop.
    const remaining = remainingSeconds(s, start + 600_000);
    expect(remaining).toBe(s.expectedSeconds - 600 + 120);
  });

  it("reports zero once ended", async () => {
    const store = new InMemorySessionStore();
    const created = await store.create({ userId: "u", scenario, mode: "MOCK", idempotencyKey: "k" });
    await store.transition(created.id, "CLARIFICATION");
    const ended = await store.end(created.id);
    expect(remainingSeconds(ended, Date.now())).toBe(0);
  });
});

describe("session channel — reconnect semantics", () => {
  let store: InMemorySessionStore;
  let log: InMemoryEventLog;
  let channel: SessionChannel;
  let sessionId: string;

  const clientEvent = (clientSeq: number, key: string, overrides: Record<string, unknown> = {}) => ({
    sessionId,
    clientSeq,
    idempotencyKey: key,
    type: "CODE_DELTA",
    occurredAt: "2026-08-09T00:00:00.000Z",
    payload: { revision: clientSeq },
    ...overrides,
  });

  beforeEach(async () => {
    store = new InMemorySessionStore();
    log = new InMemoryEventLog();
    channel = new SessionChannel({ sessions: store, eventLog: log });
    const s = await store.create({ userId: "u", scenario, mode: "MOCK", idempotencyKey: "k" });
    sessionId = s.id;
  });

  it("acks an accepted event with its server sequence", async () => {
    const r = await channel.handleClientEvent(clientEvent(0, "e0"));
    expect(r.accepted).toBe(true);
    expect(r.messages[0]).toEqual({ kind: "ACK", clientSeq: 0, seq: 0 });
  });

  it("acks a duplicate identically — the client cannot tell", async () => {
    const first = await channel.handleClientEvent(clientEvent(0, "e0"));
    const retry = await channel.handleClientEvent(clientEvent(0, "e0"));
    expect(retry.messages).toEqual(first.messages);
    expect(await log.latestSeq(sessionId)).toBe(0);
  });

  it("requests replay rather than appending past a gap", async () => {
    await channel.handleClientEvent(clientEvent(0, "e0"));
    const gapped = await channel.handleClientEvent(clientEvent(5, "e5"));

    expect(gapped.accepted).toBe(false);
    expect(gapped.messages[0]).toEqual({ kind: "REPLAY_FROM", seq: 1 });
    // Nothing was written — a hole in the evidence is worse than being behind.
    expect(await log.latestSeq(sessionId)).toBe(0);
  });

  it("recovers once the missing events arrive", async () => {
    await channel.handleClientEvent(clientEvent(0, "e0"));
    await channel.handleClientEvent(clientEvent(3, "e3"));
    for (const i of [1, 2, 3]) await channel.handleClientEvent(clientEvent(i, `e${i}`));
    expect(await log.latestSeq(sessionId)).toBe(3);
  });

  it("a replayed old event does not rewind the expected sequence", async () => {
    for (const i of [0, 1, 2]) await channel.handleClientEvent(clientEvent(i, `e${i}`));
    await channel.handleClientEvent(clientEvent(1, "e1"));

    const next = await channel.handleClientEvent(clientEvent(3, "e3"));
    expect(next.accepted).toBe(true);
  });

  it("rejects events after the session has ended", async () => {
    await store.end(sessionId);
    const r = await channel.handleClientEvent(clientEvent(0, "e0"));
    expect(r.accepted).toBe(false);
    expect(r.messages[0]).toMatchObject({ code: "SESSION_ENDED" });
  });

  it("rejects an unknown session", async () => {
    const r = await channel.handleClientEvent({
      ...clientEvent(0, "e0"),
      sessionId: "00000000-0000-4000-8000-0000000000ff",
    });
    expect(r.messages[0]).toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it("rejects a malformed event without crashing the channel", async () => {
    const r = await channel.handleClientEvent({ nonsense: true });
    expect(r.accepted).toBe(false);
    expect(r.messages[0]).toMatchObject({ code: "INVALID_EVENT" });
  });

  it("resumes a refreshed browser with missed events and current state", async () => {
    for (const i of [0, 1, 2, 3]) await channel.handleClientEvent(clientEvent(i, `e${i}`));
    await store.transition(sessionId, "CLARIFICATION");

    channel.forget(sessionId);
    const resumed = await channel.resume(sessionId, 1);

    const acks = resumed.messages.filter((m) => m.kind === "ACK");
    expect(acks.map((a) => (a.kind === "ACK" ? a.seq : -1))).toEqual([2, 3]);

    const state = resumed.messages.at(-1);
    expect(state).toMatchObject({ kind: "STATE", state: "CLARIFICATION" });
  });

  it("accepts events again after a reconnect", async () => {
    await channel.handleClientEvent(clientEvent(0, "e0"));
    channel.forget(sessionId);
    const afterReconnect = await channel.handleClientEvent(clientEvent(0, "e0"));
    expect(afterReconnect.messages[0]).toMatchObject({ kind: "ACK" });
  });
});
