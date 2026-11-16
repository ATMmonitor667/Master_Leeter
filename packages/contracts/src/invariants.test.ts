import { describe, expect, it } from "vitest";
import { ChatTurnInputSchema, EVENT_TYPES, HINTS_BY_STYLE, LiveEventBatchSchema, ProblemSpecSchema } from "./index.js";

describe("interview contracts", () => {
  it("logs transcript turns and cues as first-class events", () => {
    expect(EVENT_TYPES).toContain("TRANSCRIPT_TURN");
    expect(EVENT_TYPES).toContain("CUE");
  });

  it("gives fewer hints as the style gets tougher", () => {
    expect(HINTS_BY_STYLE.SUPPORTIVE).toBeGreaterThan(HINTS_BY_STYLE.NEUTRAL);
    expect(HINTS_BY_STYLE.NEUTRAL).toBeGreaterThan(HINTS_BY_STYLE.TOUGH);
  });

  it("rejects an empty chat turn and an empty event batch", () => {
    expect(ChatTurnInputSchema.safeParse({ requestId: crypto.randomUUID(), text: "  " }).success).toBe(false);
    expect(ChatTurnInputSchema.safeParse({ requestId: crypto.randomUUID(), cue: "HINT" }).success).toBe(true);
    expect(LiveEventBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it("requires exactly three hints and two follow-ups in a problem spec", () => {
    const spec = {
      id: "demo-problem", title: "Demo", concept: "demo", difficulty: "EASY", topics: ["arrays"],
      statement: "Return the largest value in the list of numbers.",
      signature: { name: "largest", params: [{ name: "values", type: "list[int]" }], returns: "int" },
      constraints: [], examples: [{ args: [[1, 2]], expected: 2 }], tests: [],
      hints: ["a", "b", "c"], followUps: ["x", "y"],
      privateNotes: { approach: "scan", complexity: "O(n)", mistakes: ["empty", "negatives"] },
      provenance: { type: "ORIGINAL", author: "test" },
    };
    expect(ProblemSpecSchema.safeParse(spec).success).toBe(true);
    expect(ProblemSpecSchema.safeParse({ ...spec, hints: ["a"] }).success).toBe(false);
  });
});
