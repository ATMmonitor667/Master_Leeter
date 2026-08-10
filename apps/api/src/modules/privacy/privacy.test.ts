import type { SessionEvent } from "@master-leeter/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryEventLog } from "../session/event-log.js";
import {
  CURRENT_NOTICE_VERSION,
  RETENTION_DAYS,
  emptyConsent,
  isExpired,
  isPermitted,
  latestGrant,
  record,
  scopesToPurge,
} from "./consent.js";
import { REDACTED, executeDeletion, redactionFor, type Deletable } from "./deletion.js";

const NOW = "2026-08-10T00:00:00.000Z";
const SESSION = "00000000-0000-4000-8000-00000000000c";

const grant = (scope: Parameters<typeof isPermitted>[1], granted: boolean, overrides = {}) => ({
  scope,
  granted,
  decidedAt: NOW,
  noticeVersion: CURRENT_NOTICE_VERSION,
  ...overrides,
});

describe("consent — absence is a no", () => {
  it("permits nothing by default", () => {
    const consent = emptyConsent("u1");
    // Invariant 10 and its neighbours. There is no "assume yes until they
    // object" branch anywhere in this module.
    expect(isPermitted(consent, "TRANSCRIPT")).toBe(false);
    expect(isPermitted(consent, "RAW_AUDIO")).toBe(false);
    expect(isPermitted(consent, "CALIBRATION")).toBe(false);
  });

  it("permits a scope only after an explicit grant", () => {
    const consent = record(emptyConsent("u1"), grant("TRANSCRIPT", true));
    expect(isPermitted(consent, "TRANSCRIPT")).toBe(true);
    expect(isPermitted(consent, "RAW_AUDIO")).toBe(false);
  });

  it("honours a revocation", () => {
    let consent = record(emptyConsent("u1"), grant("RAW_AUDIO", true));
    consent = record(consent, grant("RAW_AUDIO", false, { decidedAt: "2026-08-11T00:00:00.000Z" }));
    expect(isPermitted(consent, "RAW_AUDIO")).toBe(false);
  });

  it("treats a grant against an outdated notice as no consent", () => {
    // If the wording changed, they consented to something else.
    const consent = record(emptyConsent("u1"), grant("TRANSCRIPT", true, { noticeVersion: "old-notice" }));
    expect(isPermitted(consent, "TRANSCRIPT")).toBe(false);
  });

  it("keeps the decision history rather than overwriting it", () => {
    // "Did they consent at the time?" is the only version of that question that
    // matters, and it is unanswerable if grants are overwritten.
    let consent = record(emptyConsent("u1"), grant("CALIBRATION", true));
    consent = record(consent, grant("CALIBRATION", false, { decidedAt: "2026-08-12T00:00:00.000Z" }));

    expect(consent.grants).toHaveLength(2);
    expect(latestGrant(consent, "CALIBRATION")?.granted).toBe(false);
  });

  it("lists scopes that must be purged after revocation", () => {
    let consent = record(emptyConsent("u1"), grant("RAW_AUDIO", true));
    expect(scopesToPurge(consent)).toEqual([]);

    consent = record(consent, grant("RAW_AUDIO", false, { decidedAt: "2026-08-11T00:00:00.000Z" }));
    expect(scopesToPurge(consent)).toContain("RAW_AUDIO");
  });

  it("keeps audio retention shortest of all", () => {
    // Audio is the highest-risk artifact the system can hold; the longer it
    // exists the more it is worth to an attacker.
    expect(RETENTION_DAYS.RAW_AUDIO).toBeLessThan(RETENTION_DAYS.TRANSCRIPT);
    expect(RETENTION_DAYS.RAW_AUDIO).toBeLessThan(RETENTION_DAYS.CALIBRATION);
  });

  it("expires artifacts past their window", () => {
    const created = Date.parse("2026-01-01T00:00:00.000Z");
    const fortyDaysLater = created + 40 * 24 * 60 * 60 * 1000;

    expect(isExpired("RAW_AUDIO", new Date(created).toISOString(), fortyDaysLater)).toBe(true);
    expect(isExpired("TRANSCRIPT", new Date(created).toISOString(), fortyDaysLater)).toBe(false);
  });
});

describe("redaction — the log keeps its shape, loses its content", () => {
  const event = (type: SessionEvent["type"], payload: Record<string, unknown>): SessionEvent => ({
    sessionId: SESSION,
    seq: 3,
    occurredAt: NOW,
    type,
    actor: "CANDIDATE",
    scenarioVersionId: "conveyor-rescan@1",
    payload,
    evidenceHash: "sha256:original",
    traceId: "t",
  });

  it("removes what the person said", () => {
    const redacted = redactionFor(event("SPEECH_FINAL", { transcript: "I'll use a set here" }));
    expect(JSON.stringify(redacted)).not.toContain("I'll use a set");
  });

  it("removes their code", () => {
    const redacted = redactionFor(event("CODE_DELTA", { revision: 4, text: "def secret(): pass" }));
    expect(JSON.stringify(redacted)).not.toContain("def secret");
  });

  it("keeps the structural fields, so no gap appears", () => {
    // A gap in the sequence is indistinguishable from data loss, which would
    // make every future audit of this log suspect.
    const redacted = redactionFor(event("SPEECH_FINAL", { transcript: "x" }));
    expect(redacted.seq).toBe(3);
    expect(redacted.type).toBe("SPEECH_FINAL");
    expect(redacted.occurredAt).toBe(NOW);
    expect(redacted.actor).toBe("CANDIDATE");
  });

  it("marks the event as redacted rather than pretending nothing was there", () => {
    // Silent erasure makes "never happened" and "removed on request"
    // indistinguishable. A tombstone is honest.
    const redacted = redactionFor(event("SPEECH_FINAL", { transcript: "x" }));
    expect(redacted.payload["redacted"]).toBe(true);
  });

  it("preserves the original evidence hash", () => {
    // It still attests to the original content, so an audit can prove the log
    // was redacted rather than fabricated — without the content being
    // recoverable from the hash.
    const redacted = redactionFor(event("SPEECH_FINAL", { transcript: "x" }));
    expect(redacted.evidenceHash).toBe("sha256:original");
  });

  it("keeps non-identifying run metadata while dropping output", () => {
    // "A test failed after 40ms" is not personal. The stdout of their code is.
    const redacted = redactionFor(
      event("RUN_COMPLETED", { status: "FAILED", cpuTimeMs: 40, stdout: "B2", stderr: "boom" }),
    );
    expect(redacted.payload["status"]).toBe("FAILED");
    expect(redacted.payload["cpuTimeMs"]).toBe(40);
    expect(redacted.payload["stdout"]).toBe(REDACTED);
    expect(redacted.payload["stderr"]).toBe(REDACTED);
  });
});

describe("event log redaction", () => {
  let log: InMemoryEventLog;

  beforeEach(async () => {
    log = new InMemoryEventLog();
    for (const [i, payload] of [
      { transcript: "hello there" },
      { revision: 1, text: "my code" },
      { revision: 2, text: "more code" },
    ].entries()) {
      await log.append({
        sessionId: SESSION,
        type: i === 0 ? "SPEECH_FINAL" : "CODE_DELTA",
        actor: "CANDIDATE",
        scenarioVersionId: "conveyor-rescan@1",
        payload,
        traceId: "t",
        idempotencyKey: `k${i}`,
      });
    }
  });

  it("redacts every event in the session", async () => {
    expect(await log.redact(SESSION)).toBe(3);
    const events = await log.read(SESSION);
    expect(JSON.stringify(events)).not.toContain("hello there");
    expect(JSON.stringify(events)).not.toContain("my code");
  });

  it("leaves no gaps in the sequence", async () => {
    await log.redact(SESSION);
    expect((await log.read(SESSION)).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("does not resurrect payloads when an old client event is replayed", async () => {
    await log.redact(SESSION);
    await log.append({
      sessionId: SESSION,
      type: "CODE_DELTA",
      actor: "CANDIDATE",
      scenarioVersionId: "conveyor-rescan@1",
      payload: { revision: 1, text: "my code" },
      traceId: "t",
      idempotencyKey: "k1",
    });

    const events = await log.read(SESSION);
    const restored = events.filter((e) => JSON.stringify(e).includes("my code"));
    expect(restored, "a replayed event resurrected deleted content").toHaveLength(1);
    expect(restored[0]?.seq).toBe(3);
  });

  it("is a no-op for an unknown session", async () => {
    expect(await log.redact("00000000-0000-4000-8000-0000000000ff")).toBe(0);
  });
});

describe("deletion", () => {
  class FakeStore implements Deletable {
    deletedSessions: string[] = [];
    deletedUsers: string[] = [];
    constructor(
      readonly name: string,
      private readonly explode = false,
    ) {}

    async deleteForSession(sessionId: string): Promise<number> {
      if (this.explode) throw new Error("store unavailable");
      this.deletedSessions.push(sessionId);
      return 1;
    }
    async deleteForUser(userId: string): Promise<number> {
      if (this.explode) throw new Error("store unavailable");
      this.deletedUsers.push(userId);
      return 1;
    }
  }

  let log: InMemoryEventLog;

  beforeEach(async () => {
    log = new InMemoryEventLog();
    await log.append({
      sessionId: SESSION,
      type: "SPEECH_FINAL",
      actor: "CANDIDATE",
      scenarioVersionId: "s@1",
      payload: { transcript: "private" },
      traceId: "t",
      idempotencyKey: "k",
    });
  });

  it("redacts events and reports how many", async () => {
    const receipt = await executeDeletion(
      { scope: "SESSION", userId: "u1", sessionId: SESSION, requestedAt: NOW },
      { eventLog: log, sessionsOf: async () => [SESSION], stores: [] },
    );
    expect(receipt.eventsRedacted).toBe(1);
  });

  it("reaches every registered store", async () => {
    const reports = new FakeStore("reports");
    const audio = new FakeStore("audio");

    await executeDeletion(
      { scope: "SESSION", userId: "u1", sessionId: SESSION, requestedAt: NOW },
      { eventLog: log, sessionsOf: async () => [SESSION], stores: [reports, audio] },
    );

    expect(reports.deletedSessions).toEqual([SESSION]);
    expect(audio.deletedSessions).toEqual([SESSION]);
  });

  it("admits when a store could not be reached", async () => {
    // A receipt claiming success it did not achieve is worse than one that
    // says a store was unreachable.
    const receipt = await executeDeletion(
      { scope: "SESSION", userId: "u1", sessionId: SESSION, requestedAt: NOW },
      { eventLog: log, sessionsOf: async () => [SESSION], stores: [new FakeStore("reports", true)] },
    );

    expect(receipt.unreachable[0]).toMatch(/reports/);
  });

  it("keeps going after one store fails", async () => {
    const healthy = new FakeStore("audio");
    await executeDeletion(
      { scope: "SESSION", userId: "u1", sessionId: SESSION, requestedAt: NOW },
      {
        eventLog: log,
        sessionsOf: async () => [SESSION],
        stores: [new FakeStore("reports", true), healthy],
      },
    );
    expect(healthy.deletedSessions).toEqual([SESSION]);
  });

  it("deletes every session for an account", async () => {
    const reports = new FakeStore("reports");
    const receipt = await executeDeletion(
      { scope: "ACCOUNT", userId: "u1", requestedAt: NOW },
      { eventLog: log, sessionsOf: async () => [SESSION, "other"], stores: [reports] },
    );

    expect(receipt.sessionIds).toEqual([SESSION, "other"]);
    expect(reports.deletedUsers).toEqual(["u1"]);
  });

  it("notes when the log cannot be redacted at all", async () => {
    const noRedact = { read: log.read.bind(log), append: log.append.bind(log), latestSeq: log.latestSeq.bind(log) };
    const receipt = await executeDeletion(
      { scope: "SESSION", userId: "u1", sessionId: SESSION, requestedAt: NOW },
      { eventLog: noRedact, sessionsOf: async () => [SESSION], stores: [] },
    );
    expect(receipt.unreachable[0]).toMatch(/redaction/);
  });
});
