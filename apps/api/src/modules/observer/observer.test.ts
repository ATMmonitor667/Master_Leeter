import type { RunResult } from "@master-leeter/contracts";
import { describe, expect, it } from "vitest";
import {
  applyRunResult,
  applySnapshot,
  complexityMismatch,
  emptyMilestoneState,
  failureFingerprint,
  normalizeComplexity,
} from "./milestones.js";
import { buildSnapshot, detectSolutionFamily } from "./semantic-snapshot.js";

const OPTIMAL = `def first_rescan(readings):
    seen = set()
    for r in readings:
        if r in seen:
            return r
        seen.add(r)
    return None
`;

const NESTED = `def first_rescan(readings):
    for i in range(len(readings)):
        for j in range(i):
            if readings[i] == readings[j]:
                return readings[i]
    return None
`;

const SORTED = `def first_rescan(readings):
    ordered = sorted(readings)
    for i in range(1, len(ordered)):
        if ordered[i] == ordered[i - 1]:
            return ordered[i]
    return None
`;

const TWO_PASS = `def first_rescan(readings):
    counts = {}
    for r in readings:
        counts[r] = counts.get(r, 0) + 1
    for r in readings:
        if counts[r] > 1:
            return r
    return None
`;

const RECURSIVE = `def walk(node):
    if node is None:
        return 0
    return 1 + walk(node.next)
`;

describe("semantic snapshot", () => {
  it("summarizes functions", async () => {
    const s = await buildSnapshot(OPTIMAL, 1);
    expect(s.functions).toHaveLength(1);
    expect(s.functions[0]).toMatchObject({ name: "first_rescan", params: ["readings"], loopCount: 1 });
  });

  it("detects the containers in play, whether constructed or literal", async () => {
    expect((await buildSnapshot(OPTIMAL, 1)).dataStructures).toContain("set");
    expect((await buildSnapshot("x = {}\n", 1)).dataStructures).toContain("dict");
    expect((await buildSnapshot("x = {1, 2}\n", 1)).dataStructures).toContain("set");
  });

  it("measures loop nesting", async () => {
    expect((await buildSnapshot(NESTED, 1)).functions[0]?.maxLoopDepth).toBe(2);
    expect((await buildSnapshot(OPTIMAL, 1)).functions[0]?.maxLoopDepth).toBe(1);
  });

  it("spots direct recursion", async () => {
    expect((await buildSnapshot(RECURSIVE, 1)).functions[0]?.recursive).toBe(true);
    expect((await buildSnapshot(OPTIMAL, 1)).functions[0]?.recursive).toBe(false);
  });

  it("notices early returns", async () => {
    expect((await buildSnapshot(OPTIMAL, 1)).functions[0]?.hasEarlyReturn).toBe(true);
  });

  it("parses half-written code without refusing", async () => {
    // Candidate code is broken most of the time it is being typed. A parser
    // that only works on valid input would produce snapshots exactly when the
    // candidate is least interesting.
    const s = await buildSnapshot("def f(xs):\n    seen = set()\n    for x in\n", 1);
    expect(s.syntaxValid).toBe(false);
    expect(s.dataStructures).toContain("set");
  });

  it("reports valid syntax for complete code", async () => {
    expect((await buildSnapshot(OPTIMAL, 1)).syntaxValid).toBe(true);
  });

  it("computes changed regions against the previous revision", async () => {
    const edited = OPTIMAL.replace("seen.add(r)", "seen.add(r)  # remember it");
    const s = await buildSnapshot(edited, 2, { code: OPTIMAL });

    expect(s.changedRegions).toHaveLength(1);
    expect(s.churn).toBeGreaterThan(0);
    expect(s.churn).toBeLessThan(0.3);
  });

  it("reports zero churn for a first revision", async () => {
    const s = await buildSnapshot(OPTIMAL, 1);
    expect(s.churn).toBe(0);
    expect(s.changedRegions).toEqual([]);
  });

  it("reports high churn for a wholesale rewrite", async () => {
    const s = await buildSnapshot(NESTED, 2, { code: OPTIMAL });
    expect(s.churn).toBeGreaterThan(0.5);
  });
});

describe("solution family detection", () => {
  it("recognizes the single-pass seen-set family", async () => {
    expect(detectSolutionFamily(await buildSnapshot(OPTIMAL, 1))).toBe("sf-set-single-pass");
  });

  it("recognizes a nested scan", async () => {
    expect(detectSolutionFamily(await buildSnapshot(NESTED, 1))).toBe("sf-nested-loop");
  });

  it("recognizes a sort-based approach", async () => {
    expect(detectSolutionFamily(await buildSnapshot(SORTED, 1))).toBe("sf-sort");
  });

  it("recognizes count-then-rescan", async () => {
    expect(detectSolutionFamily(await buildSnapshot(TWO_PASS, 1))).toBe("sf-count-then-scan");
  });

  it("returns null rather than guessing on an empty file", async () => {
    // A wrong family feeds the complexity probe, and probing someone about an
    // approach they are not taking is a visible product failure.
    expect(detectSolutionFamily(await buildSnapshot("", 1))).toBeNull();
    expect(detectSolutionFamily(await buildSnapshot("# thinking\n", 1))).toBeNull();
  });
});

describe("milestones", () => {
  const run = (o: Partial<RunResult> = {}): RunResult => ({
    runId: "r",
    language: "python",
    codeRevision: 1,
    inputHash: "h",
    status: "FAILED",
    exitCode: 0,
    cpuTimeMs: 10,
    memoryKb: 100,
    stdout: "",
    stderr: "",
    truncated: false,
    ...o,
  });

  it("emits FIRST_COMPILES once", () => {
    let state = emptyMilestoneState();
    const first = applyRunResult(state, run({ status: "FAILED" }));
    expect(first.emitted).toContain("FIRST_COMPILES");

    state = first.state;
    expect(applyRunResult(state, run({ status: "FAILED" })).emitted).not.toContain("FIRST_COMPILES");
  });

  it("does not emit FIRST_COMPILES on a compile error", () => {
    const r = applyRunResult(emptyMilestoneState(), run({ status: "COMPILE_ERROR" }));
    expect(r.emitted).not.toContain("FIRST_COMPILES");
  });

  it("emits BASE_TESTS_PASS when every visible test passes", () => {
    const r = applyRunResult(
      emptyMilestoneState(),
      run({ status: "PASSED", visibleTestsPassed: 3, visibleTestsTotal: 3 }),
    );
    expect(r.emitted).toContain("BASE_TESTS_PASS");
  });

  it("withholds BASE_TESTS_PASS on a partial pass", () => {
    const r = applyRunResult(
      emptyMilestoneState(),
      run({ status: "PASSED", visibleTestsPassed: 2, visibleTestsTotal: 3 }),
    );
    expect(r.emitted).not.toContain("BASE_TESTS_PASS");
  });

  it("emits REPEATED_SAME_FAILURE only on the third identical failure", () => {
    let state = emptyMilestoneState();
    const failure = run({ status: "FAILED", stderr: "AssertionError: expected B2" });

    for (const expected of [false, false, true]) {
      const r = applyRunResult(state, failure);
      state = r.state;
      expect(r.emitted.includes("REPEATED_SAME_FAILURE")).toBe(expected);
    }
  });

  it("resets the streak when the failure changes", () => {
    let state = emptyMilestoneState();
    state = applyRunResult(state, run({ stderr: "error A" })).state;
    state = applyRunResult(state, run({ stderr: "error A" })).state;

    const different = applyRunResult(state, run({ stderr: "error B" }));
    expect(different.emitted).not.toContain("REPEATED_SAME_FAILURE");
    expect(different.state.consecutiveIdenticalFailures).toBe(1);
  });

  it("resets the streak on success", () => {
    let state = emptyMilestoneState();
    for (let i = 0; i < 3; i++) state = applyRunResult(state, run({ stderr: "same" })).state;

    state = applyRunResult(state, run({ status: "PASSED" })).state;
    expect(state.consecutiveIdenticalFailures).toBe(0);
  });

  it("ignores timing noise when deciding two failures are the same", () => {
    // Three runs of one bug produce three CPU readings. Treating those as
    // different failures would defeat repeat detection entirely.
    const a = failureFingerprint(run({ cpuTimeMs: 11, memoryKb: 100, stderr: "boom" }));
    const b = failureFingerprint(run({ cpuTimeMs: 97, memoryKb: 900, stderr: "boom" }));
    expect(a).toBe(b);
  });

  it("emits LARGE_REWRITE on high churn in a non-trivial file", () => {
    const r = applySnapshot(emptyMilestoneState(), {
      revision: 4,
      parsedAt: "",
      syntaxValid: true,
      functions: [],
      dataStructures: [],
      callsMade: [],
      totalLines: 12,
      nonEmptyLines: 10,
      changedRegions: [{ startLine: 0, endLine: 9 }],
      churn: 0.8,
    });
    expect(r.emitted).toContain("LARGE_REWRITE");
  });

  it("does not call early typing a rewrite", () => {
    const r = applySnapshot(emptyMilestoneState(), {
      revision: 2,
      parsedAt: "",
      syntaxValid: true,
      functions: [],
      dataStructures: [],
      callsMade: [],
      totalLines: 3,
      nonEmptyLines: 2,
      changedRegions: [{ startLine: 0, endLine: 1 }],
      churn: 1,
    });
    expect(r.emitted).not.toContain("LARGE_REWRITE");
  });
});

describe("complexity comparison", () => {
  it("treats formatting differences as the same claim", () => {
    expect(normalizeComplexity("O(N)")).toBe(normalizeComplexity("o( n )"));
    expect(complexityMismatch("O(n)", "O( N )")).toBe(false);
  });

  it("catches a real mismatch", () => {
    expect(complexityMismatch("O(1)", "O(n)")).toBe(true);
  });

  it("treats an absent claim as absence, not error", () => {
    expect(complexityMismatch(null, "O(n)")).toBe(false);
    expect(complexityMismatch("O(n)", null)).toBe(false);
  });
});
