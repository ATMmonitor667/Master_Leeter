import { createHash } from "node:crypto";
import type {
  InterviewFormat, InterviewMode, InterviewProblem, InterviewScenarioVersion, InterviewStyle, InterviewerTone,
} from "@master-leeter/contracts";
import type { LoadedScenario } from "../scenario/loader.js";

/**
 * What a session pins at creation and never re-reads: the reskinned problem,
 * the format and the style. It rides inside the session's immutable snapshot
 * (the `scenario_snapshot` JSON column), so no schema change is needed.
 */
export interface LivePin {
  format: InterviewFormat;
  style: InterviewStyle;
  minutes: number;
  problem: InterviewProblem;
  /** Confirmed resume claims for the optional warm-up question. */
  resumeFacts?: string[];
}

export const MODE_FOR_STYLE: Record<InterviewStyle, InterviewMode> = { SUPPORTIVE: "LEARNING", NEUTRAL: "MOCK", TOUGH: "STRICT" };
export const TONE_FOR_STYLE: Record<InterviewStyle, InterviewerTone> = { SUPPORTIVE: "EXTRA_NICE", NEUTRAL: "NORMAL", TOUGH: "MEAN" };

const LEVEL = { EASY: "JUNIOR", MEDIUM: "MID", HARD: "SENIOR" } as const;

/**
 * The session store, the evaluator and the privacy code are written against a
 * scenario version. This expresses the pinned problem in that shape so they
 * keep working unchanged: the brief, constraints as facts, tests, the intended
 * approach as the one solution family, hints and follow-ups.
 */
export function snapshotFor(pin: LivePin): LoadedScenario {
  const p = pin.problem;
  const version: InterviewScenarioVersion = {
    id: `${p.sourceId}@1`,
    scenarioId: p.sourceId,
    version: 1,
    status: "ACTIVE",
    provenance: { type: "ORIGINAL", author: "problem-bank", reviewNotes: "Pinned interview problem." },
    target: { level: LEVEL[p.difficulty], topics: p.topics, expectedMinutes: pin.minutes },
    oralBrief: { openingScript: p.spokenBrief, repeatVariants: [p.writtenBrief] },
    facts: p.constraints.map((value, i) => ({ key: `constraint_${i + 1}`, value, disclosure: "ALWAYS" as const, askedAs: [] })),
    examples: p.examples.map((e) => ({ input: e.input, output: e.output, ...(e.note ? { note: e.note } : {}) })),
    visibleStarterTests: p.tests.filter((t) => !t.hidden).map((t, i) => testCase(`v${i + 1}`, t.args, t.expected, false)),
    hiddenTests: p.tests.filter((t) => t.hidden).map((t, i) => testCase(`h${i + 1}`, t.args, t.expected, true)),
    solutionFamilies: [{
      id: "intended", name: p.privateNotes.approach, timeComplexity: p.privateNotes.complexity,
      spaceComplexity: p.privateNotes.complexity, recognitionSignals: [], invariants: [],
      failureModes: p.privateNotes.mistakes, isOptimal: true,
    }],
    probes: [],
    hintLadder: [1, 2, 3, 4].map((level) => ({
      level: level as 1 | 2 | 3 | 4, text: p.hints[Math.min(level, 3) - 1]!, scoreImpact: Math.min(0.5, level * 0.1),
    })),
    followUps: p.followUps.map((oralDelta, i) => ({
      id: `follow-up-${i + 1}`, trigger: "after base solution", oralDelta, rubricDelta: {},
      expectedAdaptation: "Adapts the approach to the changed requirement and states the new trade-offs.",
    })),
    rubricId: "rubric-coding-v1",
  };
  const contentHash = `sha256:${createHash("sha256").update(JSON.stringify({ version, pin })).digest("hex")}`;
  return { version, contentHash, sourcePath: `problem:${p.sourceId}`, live: pin };
}

function testCase(id: string, args: unknown[], expected: unknown, hidden: boolean) {
  return { id, input: JSON.stringify(args), expectedOutput: JSON.stringify(expected), hidden };
}
