import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { InterviewScenarioVersion } from "@master-leeter/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioFile } from "../modules/scenario/loader.js";
import { describeRun, runBot } from "./harness.js";
import {
  ALL_TRAJECTORIES,
  buggyImplementer,
  instantSolver,
  longThinker,
  promptInjector,
  rapidClarifier,
  wrongComplexityClaim,
} from "./trajectories.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../content/scenarios/conveyor-rescan/v1.yaml");

let scenario: InterviewScenarioVersion;

beforeAll(async () => {
  scenario = (await loadScenarioFile(SCENARIO_PATH)).version;
});

describe("trajectory 1 — long-thinking candidate", () => {
  it("never interrupts a candidate reasoning aloud", () => {
    const run = runBot(longThinker, scenario);
    expect(run.utterances, describeRun(run)).toHaveLength(0);
  });

  it("stays silent even on the highest-confidence fragment, because it is not finalized", () => {
    const run = runBot(longThinker, scenario);
    const last = run.results.at(-1);
    expect(last?.decision.action).toBe("STAY_SILENT");
    expect(last?.decision.reason).toMatch(/not finalized/);
  });
});

describe("trajectory 2 — rapid clarifications", () => {
  it("answers every direct question", () => {
    const run = runBot(rapidClarifier, scenario);
    for (const r of run.results) {
      expect(r.decision.action, `${r.step.label}: ${r.decision.reason}`).not.toBe("STAY_SILENT");
    }
  });

  it("answers from canonical facts, never inventing one", () => {
    const run = runBot(rapidClarifier, scenario);
    const answers = run.results.filter((r) => r.decision.action === "ANSWER_CLARIFICATION");
    expect(answers.length).toBeGreaterThanOrEqual(5);

    const factKeys = new Set(scenario.facts.map((f) => f.key));
    for (const a of answers) {
      expect(factKeys).toContain(a.decision.factKey);
    }
  });

  it("gives the same answer to the same question asked twice", () => {
    const run = runBot(rapidClarifier, scenario);
    const first = run.results[0]?.decision.factKey;
    const repeat = run.results.at(-1)?.decision.factKey;
    expect(first).toBe("ordering");
    expect(repeat).toBe(first);
  });

  it("pacing rules never suppress an answer", () => {
    // Questions arrive 5-6s apart, well inside minSecondsBetweenProbes (45s).
    // Probe cadence protects thinking time; it must not gag the interviewer.
    const run = runBot(rapidClarifier, scenario);
    expect(run.silenceCount, describeRun(run)).toBe(0);
  });
});

describe("trajectory 3 — prompt injection", () => {
  it("never gives a hint in response to an injection attempt", () => {
    const run = runBot(promptInjector, scenario);
    for (const r of run.results) {
      expect(r.decision.action, describeRun(run)).not.toMatch(/^GIVE_HINT/);
    }
  });

  it("never answers with anything but a canonical fact", () => {
    const run = runBot(promptInjector, scenario);
    const factKeys = new Set(scenario.facts.map((f) => f.key));
    for (const r of run.results) {
      if (r.decision.action === "ANSWER_CLARIFICATION") {
        expect(factKeys).toContain(r.decision.factKey);
      }
    }
  });

  it("does not leak hidden tests when asked for them directly", () => {
    const run = runBot(promptInjector, scenario);
    const leak = run.results.find((r) => r.step.label.includes("hidden test"));

    // There is no canonical fact for "what are the hidden tests", so the gate
    // reaches for ACKNOWLEDGE_BRIEFLY — which IMPLEMENTATION does not permit, so
    // it degrades to silence. Two independent mechanisms had to agree before
    // nothing leaked, which is the point of layering them.
    expect(["STAY_SILENT", "ACKNOWLEDGE_BRIEFLY"]).toContain(leak?.decision.action);
    expect(leak?.decision.factKey).toBeUndefined();
  });

  it("holds policy across every attempt, not just the first", () => {
    const run = runBot(promptInjector, scenario);
    const spoke = run.utterances.map((u) => u.decision.action);
    expect(new Set(spoke).size, describeRun(run)).toBeLessThanOrEqual(1);
  });
});

describe("trajectory 4 — wrong complexity claim over optimal code", () => {
  it("probes the claim", () => {
    const run = runBot(wrongComplexityClaim, scenario);
    const probe = run.utterances.find((u) => u.decision.action === "ASK_PROBE");
    expect(probe?.decision.probeId, describeRun(run)).toBe("complexity_claim");
  });

  it("grounds the probe in a known code revision", () => {
    const run = runBot(wrongComplexityClaim, scenario);
    const probe = run.utterances.find((u) => u.decision.action === "ASK_PROBE");
    expect(probe?.decision.groundedInRevision).toBe(12);
  });

  it("says nothing about the implementation itself", () => {
    const run = runBot(wrongComplexityClaim, scenario);
    for (const u of run.utterances) {
      expect(u.decision.action).not.toMatch(/^GIVE_HINT/);
    }
  });

  it("goes quiet again once the candidate resumes coding", () => {
    const run = runBot(wrongComplexityClaim, scenario);
    expect(run.results.at(-1)?.decision.action).toBe("STAY_SILENT");
  });
});

describe("trajectory 5 — correct reasoning, buggy implementation", () => {
  it("stays silent through the first two failures", () => {
    const run = runBot(buggyImplementer, scenario);
    expect(run.results[0]?.decision.action, describeRun(run)).toBe("STAY_SILENT");
    expect(run.results[1]?.decision.action).toBe("STAY_SILENT");
  });

  it("redirects to diagnosis on the third identical failure", () => {
    const run = runBot(buggyImplementer, scenario);
    const last = run.results.at(-1);
    expect(last?.decision.action, describeRun(run)).toBe("ASK_PROBE");
    expect(last?.decision.probeId).toBe("repeated_failure_trace");
  });

  it("does not hand over a hint instead of a probe", () => {
    const run = runBot(buggyImplementer, scenario);
    for (const u of run.utterances) {
      expect(u.decision.action).not.toMatch(/^GIVE_HINT/);
    }
  });
});

describe("trajectory 6 — instant solve", () => {
  it("tests correctness before moving on", () => {
    const run = runBot(instantSolver, scenario);
    const first = run.utterances[0];
    expect(first?.decision.action, describeRun(run)).toBe("ASK_PROBE");
    expect(["invariant_proof", "edge_empty"]).toContain(first?.decision.probeId);
  });

  it("presents an authored follow-up, not an invented one", () => {
    const run = runBot(instantSolver, scenario);
    const followUp = run.utterances.find((u) => u.decision.action === "PRESENT_FOLLOW_UP");
    const authoredIds = scenario.followUps.map((f) => f.id);
    expect(followUp?.decision.followUpId, describeRun(run)).toBeDefined();
    expect(authoredIds).toContain(followUp?.decision.followUpId);
  });
});

describe("across all trajectories", () => {
  it("every decision explains itself", () => {
    for (const bot of ALL_TRAJECTORIES) {
      const run = runBot(bot, scenario);
      for (const r of run.results) {
        expect(r.decision.reason.length, `${bot.name}: ${r.step.label}`).toBeGreaterThan(0);
      }
    }
  });

  it("every decision is made by a deterministic rule", () => {
    // Until the semantic classifier lands (M4-1), nothing here should require a
    // model call. If this starts failing, reasoning has crept onto the hot path.
    for (const bot of ALL_TRAJECTORIES) {
      const run = runBot(bot, scenario);
      for (const r of run.results) {
        expect(r.decision.decidedByRule, `${bot.name}: ${r.step.label}`).toBe(true);
      }
    }
  });

  it("replays deterministically — same script, same decisions", () => {
    for (const bot of ALL_TRAJECTORIES) {
      const a = runBot(bot, scenario).results.map((r) => r.decision);
      const b = runBot(bot, scenario).results.map((r) => r.decision);
      expect(a).toEqual(b);
    }
  });

  it("silence is the majority outcome overall", () => {
    const total = ALL_TRAJECTORIES.reduce(
      (acc, bot) => {
        const run = runBot(bot, scenario);
        return { steps: acc.steps + run.results.length, silent: acc.silent + run.silenceCount };
      },
      { steps: 0, silent: 0 },
    );
    expect(total.silent / total.steps).toBeGreaterThan(0.5);
  });
});
