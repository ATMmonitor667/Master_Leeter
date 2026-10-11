import type { SessionEvent } from "@master-leeter/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CONTENT_ROOT } from "../../index.js";
import { GeminiClient, GeminiError } from "../../lib/gemini.js";
import { loadScenarioLibrary, type LoadedScenario } from "../scenario/loader.js";
import { IndependentGeminiEvaluator } from "./independent-evaluator.js";
import type { EvaluationProgress } from "./evaluator.js";

let scenario: LoadedScenario;
beforeAll(async () => { scenario = [...(await loadScenarioLibrary(CONTENT_ROOT)).values()][0]!; });
function event(seq: number, type: SessionEvent["type"], payload: Record<string, unknown>): SessionEvent {
  return { sessionId: "00000000-0000-4000-8000-000000000001", seq, type, payload, actor: "CANDIDATE",
    scenarioVersionId: scenario.version.id, occurredAt: "2026-10-11T12:00:00.000Z", evidenceHash: "sha256:test", traceId: "test" };
}
const grade = (transcript = false) => ({ score: 75, confidence: 0.8, summary: "Evidence supports this estimate.",
  strengths: ["Clear reasoning"], improvements: ["Check boundaries"],
  dimensions: (transcript ? ["understanding", "approach", "complexity", "testingDebugging", "communication"] :
    ["correctness", "contractCoverage", "edgeCases", "complexity"]).map((key) => ({ key, score: 75, rationale: "Observable evidence" })),
  evidence: transcript ? [{ seq: 2, claim: "Explained complexity", quote: "linear time" }] : [{ seq: 1, claim: "Submitted code" }],
});
function fixture() {
  const client = new GeminiClient({ model: "fixture", apiKey: "test-only" });
  const generate = vi.spyOn(client, "generateJson");
  const evaluator = new IndependentGeminiEvaluator(client);
  const events = [event(1, "CODE_DELTA", { text: "def solve(items): return []", revision: 7 }),
    event(2, "SPEECH_FINAL", { transcript: "My solution uses linear time", segmentId: "turn1" })];
  return { evaluator, generate, events, context: { scenario } };
}

describe("independent evidence-backed graders", () => {
  it("separates solution and speech evidence and preserves revision/turn citations", async () => {
    const { evaluator, generate, events, context } = fixture();
    generate.mockResolvedValueOnce(grade()).mockResolvedValueOnce(grade(true));
    const result = await evaluator.evaluate(events, "rubric-coding-v1", context);
    expect(result.solutionGrade?.evidence[0]).toMatchObject({ seq: 1, codeRevision: 7 });
    expect(result.transcriptGrade?.evidence[0]).toMatchObject({ seq: 2, quote: "linear time", segmentId: "turn1" });
    const solutionPrompt = JSON.parse(generate.mock.calls[0]![0].prompt);
    const transcriptPrompt = JSON.parse(generate.mock.calls[1]![0].prompt);
    expect(solutionPrompt.sealedSolution.code).toBe(events[0]!.payload.text);
    expect(JSON.stringify(solutionPrompt)).not.toContain("My solution uses linear time");
    expect(transcriptPrompt.candidateTurns).toHaveLength(1);
    expect(JSON.stringify(transcriptPrompt)).not.toContain("def solve");
    expect(transcriptPrompt).not.toHaveProperty("privateReference");
    expect(transcriptPrompt.publicQuestionContext.facts.every((fact: { disclosure: string }) => fact.disclosure === "ALWAYS")).toBe(true);
  });

  it("reports insufficient evidence without paying for a provider call", async () => {
    const { evaluator, generate } = fixture();
    const result = await evaluator.evaluate([], "rubric-coding-v1");
    expect(result.solutionGrade?.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.transcriptGrade?.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(generate).not.toHaveBeenCalled();
  });

  it("persists the first grade and retries only the unfinished grader", async () => {
    const { evaluator, generate, events, context } = fixture();
    const checkpoints: EvaluationProgress[] = [];
    generate.mockResolvedValueOnce(grade()).mockRejectedValueOnce(new Error("network"));
    await expect(evaluator.evaluateWithProgress(events, "rubric-coding-v1", context, {}, async (value) => {
      checkpoints.push(structuredClone(value));
    })).rejects.toThrow("network");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.solutionGrade?.status).toBe("SCORED");
    generate.mockResolvedValueOnce(grade(true));
    const result = await evaluator.evaluateWithProgress(events, "rubric-coding-v1", context, checkpoints[0]!, async () => {});
    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.solutionGrade).toEqual(checkpoints[0]!.solutionGrade);
    expect(result.transcriptGrade?.status).toBe("SCORED");
  });

  it.each(["missing evidence", "wrong event", "missing dimension", "private leak"])("rejects %s in solution grades", async (failure) => {
    const { evaluator, generate, events, context } = fixture();
    const reply = grade();
    if (failure === "missing evidence") reply.evidence = [];
    if (failure === "wrong event") reply.evidence[0]!.seq = 2;
    if (failure === "missing dimension") reply.dimensions.pop();
    if (failure === "private leak") {
      const privateText = scenario.version.solutionFamilies.flatMap((family) => family.invariants).find((value) => value.length >= 8)!;
      expect(privateText).toBeTruthy();
      reply.summary = privateText;
    }
    generate.mockResolvedValue(reply);
    const errors = { "missing evidence": "GRADE_WITHOUT_EVIDENCE", "wrong event": "INVALID_GRADE_CITATION",
      "missing dimension": "MISSING_GRADE_DIMENSION", "private leak": "PRIVATE_REFERENCE_LEAK" };
    await expect(evaluator.evaluate(events, "rubric-coding-v1", context)).rejects.toThrow(errors[failure as keyof typeof errors]);
  });

  it("rejects fabricated speech quotes", async () => {
    const { evaluator, generate, events, context } = fixture();
    const reply = { ...grade(true), evidence: [{ seq: 2, claim: "Explained complexity", quote: "I proved every boundary case" }] };
    generate.mockResolvedValueOnce(grade()).mockResolvedValueOnce(reply);
    await expect(evaluator.evaluate(events, "rubric-coding-v1", context)).rejects.toThrow("NON_VERBATIM_TRANSCRIPT_CITATION");
  });

  it("stops provider requests immediately after quota exhaustion", async () => {
    const { evaluator, generate, events, context } = fixture();
    generate.mockRejectedValue(new GeminiError("quota", "RATE_LIMITED", 429));
    await expect(evaluator.evaluate(events, "rubric-coding-v1", context)).rejects.toThrow("quota");
    await expect(evaluator.evaluate(events, "rubric-coding-v1", context)).rejects.toThrow("EVALUATOR_CIRCUIT_OPEN");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
