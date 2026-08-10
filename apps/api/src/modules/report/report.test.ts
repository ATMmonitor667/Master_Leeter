import type { RunResult, SessionEvent } from "@master-leeter/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryEventLog } from "../session/event-log.js";
import { BaselineEvaluator, weightedOverall } from "./evaluator.js";
import { extractFacts, momentsFor } from "./evidence.js";
import { EvaluationQueue } from "./index.js";
import { CODING_RUBRIC_V1, rubricById, weightSum } from "./rubric.js";

const SESSION = "00000000-0000-4000-8000-000000000009";
let seq = 0;

function event(type: SessionEvent["type"], payload: Record<string, unknown> = {}): SessionEvent {
  return {
    sessionId: SESSION,
    seq: seq++,
    occurredAt: new Date(1_754_000_000_000 + seq * 30_000).toISOString(),
    type,
    actor: "SYSTEM",
    scenarioVersionId: "conveyor-rescan@1",
    payload,
    evidenceHash: `sha256:${String(seq).padStart(4, "0")}`,
    traceId: "t",
  };
}

const run = (o: Partial<RunResult> = {}): Record<string, unknown> => ({
  runId: `r${seq}`,
  language: "python",
  codeRevision: 4,
  inputHash: "h",
  status: "PASSED",
  exitCode: 0,
  cpuTimeMs: 10,
  memoryKb: 100,
  stdout: "",
  stderr: "",
  truncated: false,
  ...o,
});

beforeEach(() => {
  seq = 0;
});

/** A session that went well: clarified, coded, tested, passed, took a follow-up. */
function strongSession(): SessionEvent[] {
  return [
    event("SESSION_STARTED"),
    event("CLARIFICATION_ANSWERED", { factKey: "ordering" }),
    event("CLARIFICATION_ANSWERED", { factKey: "repeat_count" }),
    event("CLARIFICATION_ANSWERED", { factKey: "empty_input" }),
    event("SPEECH_FINAL", { transcript: "I'll keep a set of everything I've already seen" }),
    event("CODE_DELTA", { revision: 4 }),
    event("RUN_COMPLETED", run({ status: "FAILED" })),
    event("RUN_COMPLETED", run({ status: "PASSED" })),
    event("MILESTONE", { kind: "BASE_TESTS_PASS" }),
    event("PROBE_ASKED", { probeId: "invariant_proof", intent: "test correctness reasoning" }),
    event("FOLLOW_UP_PRESENTED", { followUpId: "fu-streaming-window" }),
    event("SESSION_ENDED"),
  ];
}

/** A session that went badly: no questions, no runs, nothing works. */
function weakSession(): SessionEvent[] {
  return [
    event("SESSION_STARTED"),
    event("CODE_DELTA", { revision: 2 }),
    event("SESSION_ENDED"),
  ];
}

describe("rubric", () => {
  it("weights sum to exactly 1", () => {
    // An overall score computed from weights that don't sum to 1 is meaningless.
    expect(weightSum(CODING_RUBRIC_V1)).toBe(1);
  });

  it("has seven dimensions, each with evidence sources", () => {
    expect(CODING_RUBRIC_V1.dimensions).toHaveLength(7);
    for (const d of CODING_RUBRIC_V1.dimensions) {
      expect(d.evidenceFrom.length).toBeGreaterThan(0);
      expect(d.lookingFor.length).toBeGreaterThan(0);
    }
  });

  it("scores only observable behavior", () => {
    // Invariant: no personality, medical, psychological, or protected-class
    // inference. There is no dimension here that could express one.
    const text = JSON.stringify(CODING_RUBRIC_V1).toLowerCase();
    for (const forbidden of ["personality", "attitude", "confidence level", "intelligence", "culture fit"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("rejects an unknown rubric id rather than defaulting", () => {
    expect(() => rubricById("made-up")).toThrow(/Unknown rubric/);
  });
});

describe("evidence extraction is deterministic and does not judge", () => {
  it("counts clarifications and records which facts were reached", () => {
    const facts = extractFacts(strongSession());
    expect(facts.clarificationsAsked).toBe(3);
    expect(facts.clarificationFactKeys).toEqual(["ordering", "repeat_count", "empty_input"]);
  });

  it("records runs and the first passing sequence", () => {
    const facts = extractFacts(strongSession());
    expect(facts.runs).toHaveLength(2);
    expect(facts.firstPassSeq).not.toBeNull();
  });

  it("quotes what the candidate said verbatim", () => {
    // A paraphrased quote is an unfalsifiable citation.
    const facts = extractFacts(strongSession());
    const said = facts.moments.find((m) => m.kind === "said");
    expect(said?.summary).toBe("I'll keep a set of everything I've already seen");
  });

  it("carries an evidence hash on every moment so citations are verifiable", () => {
    for (const m of extractFacts(strongSession()).moments) {
      expect(m.evidenceHash).toMatch(/^sha256:/);
    }
  });

  it("ties run evidence to a code revision", () => {
    const runMoment = extractFacts(strongSession()).moments.find((m) => m.kind === "run");
    expect(runMoment?.codeRevision).toBe(4);
  });

  it("produces the same facts every time", () => {
    seq = 0;
    const a = extractFacts(strongSession());
    seq = 0;
    const b = extractFacts(strongSession());
    expect(a).toEqual(b);
  });

  it("selects moments relevant to each dimension", () => {
    const facts = extractFacts(strongSession());
    expect(momentsFor(facts, "correctness").every((m) => ["run", "milestone"].includes(m.kind))).toBe(true);
    expect(momentsFor(facts, "problemUnderstanding").some((m) => m.kind === "clarification")).toBe(true);
  });
});

describe("baseline evaluator", () => {
  const evaluator = new BaselineEvaluator(() => "2026-08-10T00:00:00.000Z");

  it("scores a strong session above a weak one", async () => {
    seq = 0;
    const strong = await evaluator.evaluate(strongSession(), "rubric-coding-v1");
    seq = 0;
    const weak = await evaluator.evaluate(weakSession(), "rubric-coding-v1");
    expect(strong.overall).toBeGreaterThan(weak.overall);
  });

  it("cites evidence for every dimension it scores confidently", async () => {
    const report = await evaluator.evaluate(strongSession(), "rubric-coding-v1");
    for (const d of report.dimensions) {
      if (d.confidence >= 0.5) {
        expect(d.evidence.length, `${d.dimension} scored ${d.score} with no evidence`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every dimension a rationale", async () => {
    const report = await evaluator.evaluate(strongSession(), "rubric-coding-v1");
    for (const d of report.dimensions) expect(d.rationale.length).toBeGreaterThan(0);
  });

  it("reports low confidence where the log is silent", async () => {
    // Communication lives almost entirely in speech. Until the transcript
    // classifier lands, a confident score there would be a fabrication.
    const report = await evaluator.evaluate(weakSession(), "rubric-coding-v1");
    const communication = report.dimensions.find((d) => d.dimension === "communication");
    expect(communication?.confidence).toBeLessThan(0.3);
  });

  it("keeps scores inside the band", async () => {
    for (const events of [strongSession(), weakSession()]) {
      seq = 0;
      const report = await evaluator.evaluate(events, "rubric-coding-v1");
      for (const d of report.dimensions) {
        expect(d.score).toBeGreaterThanOrEqual(1);
        expect(d.score).toBeLessThanOrEqual(4);
      }
    }
  });

  it("penalizes hint dependence on approach", async () => {
    seq = 0;
    const unaided = await evaluator.evaluate(strongSession(), "rubric-coding-v1");
    seq = 0;
    const withHints = await evaluator.evaluate(
      [...strongSession(), event("HINT_GIVEN", { level: 1 }), event("HINT_GIVEN", { level: 2 })],
      "rubric-coding-v1",
    );

    const approachOf = (r: { dimensions: Array<{ dimension: string; score: number }> }) =>
      r.dimensions.find((d) => d.dimension === "approach")?.score ?? 0;
    expect(approachOf(withHints)).toBeLessThan(approachOf(unaided));
  });

  it("flags missed opportunities", async () => {
    const report = await evaluator.evaluate(weakSession(), "rubric-coding-v1");
    expect(report.missedOpportunities).toContain("Did not ask any clarifying questions before starting.");
    expect(report.missedOpportunities).toContain("Never executed the code against a case of their own.");
  });

  it("prescribes three drills", async () => {
    const report = await evaluator.evaluate(weakSession(), "rubric-coding-v1");
    expect(Object.values(report.drills).every((d) => d.length > 0)).toBe(true);
  });

  it("is deterministic — the same log scores the same twice", async () => {
    seq = 0;
    const a = await evaluator.evaluate(strongSession(), "rubric-coding-v1");
    seq = 0;
    const b = await evaluator.evaluate(strongSession(), "rubric-coding-v1");
    expect(a).toEqual(b);
  });

  it("refuses to compute an overall score from broken weights", () => {
    const broken = { ...CODING_RUBRIC_V1, dimensions: CODING_RUBRIC_V1.dimensions.slice(0, 3) };
    expect(() => weightedOverall(broken, [])).toThrow(/weights sum/);
  });
});

describe("evaluation queue", () => {
  let log: InMemoryEventLog;
  let queue: EvaluationQueue;

  beforeEach(async () => {
    seq = 0;
    log = new InMemoryEventLog();
    for (const e of strongSession()) {
      await log.append({
        sessionId: e.sessionId,
        type: e.type,
        actor: e.actor,
        scenarioVersionId: e.scenarioVersionId,
        payload: e.payload,
        traceId: e.traceId,
        idempotencyKey: `k${e.seq}`,
      });
    }
    queue = new EvaluationQueue(log);
  });

  it("produces a report from the event log", async () => {
    queue.enqueue(SESSION, "rubric-coding-v1");
    const job = await queue.settled(SESSION);
    expect(job?.status).toBe("READY");
    expect(job?.report?.dimensions).toHaveLength(7);
  });

  it("is idempotent on enqueue", async () => {
    const first = queue.enqueue(SESSION, "rubric-coding-v1");
    const second = queue.enqueue(SESSION, "rubric-coding-v1");
    expect(second).toBe(first);
  });

  it("fails cleanly for a session with no events, and stays retryable", async () => {
    queue.enqueue("00000000-0000-4000-8000-0000000000aa", "rubric-coding-v1");
    const job = await queue.settled("00000000-0000-4000-8000-0000000000aa");
    expect(job?.status).toBe("FAILED");
    expect(job?.error).toMatch(/no events/);
    expect(job?.attempts).toBe(1);
  });

  it("regenerates from the same immutable events after a rubric change", async () => {
    // This is what append-only buys: improving the rubric re-scores every past
    // session without re-running a single interview.
    queue.enqueue(SESSION, "rubric-coding-v1");
    const first = await queue.settled(SESSION);

    const again = await queue.regenerate(SESSION, "rubric-coding-v1");
    expect(again.status).toBe("READY");
    expect(again.report?.overall).toBe(first?.report?.overall);
  });

  it("a failed evaluation does not touch the events it read", async () => {
    const before = await log.read(SESSION);
    queue.enqueue("00000000-0000-4000-8000-0000000000bb", "rubric-coding-v1");
    await queue.settled("00000000-0000-4000-8000-0000000000bb");
    expect(await log.read(SESSION)).toEqual(before);
  });
});
