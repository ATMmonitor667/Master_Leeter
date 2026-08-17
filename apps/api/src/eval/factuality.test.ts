import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fact, InterviewScenarioVersion } from "@master-leeter/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioLibrary } from "../modules/scenario/loader.js";
import { checkClarificationAnswers, checkNoHallucinatedAnswers, checkScenarioFactuality } from "./factuality.js";

/**
 * M4-4b, factuality half.
 *
 * Two kinds of coverage, same as the loader and probe tests this mirrors:
 * hand-built fixtures that isolate one failure mode each, and the real content
 * library, which must come back perfectly clean — a fixture proves the check
 * works, the library run proves the scenarios are actually honest.
 */

const fact = (overrides: Partial<Fact> = {}): Fact => ({
  key: "input_size",
  value: "Up to a few hundred thousand rows.",
  disclosure: "IF_ASKED",
  askedAs: ["how big is the input"],
  ...overrides,
});

function scenarioWith(facts: Fact[]): InterviewScenarioVersion {
  return {
    id: "fixture@1",
    scenarioId: "fixture",
    version: 1,
    status: "DRAFT",
    provenance: { type: "ORIGINAL", author: "test", reviewNotes: "" },
    target: { level: "MID", topics: ["t"], expectedMinutes: 40 },
    oralBrief: { openingScript: "brief", repeatVariants: ["brief again"] },
    facts,
    examples: [],
    visibleStarterTests: [],
    hiddenTests: [],
    solutionFamilies: [
      {
        id: "f1",
        name: "n",
        timeComplexity: "O(n)",
        spaceComplexity: "O(1)",
        recognitionSignals: [],
        invariants: [],
        failureModes: [],
        isOptimal: true,
      },
    ],
    probes: [],
    hintLadder: [
      { level: 1, text: "a", scoreImpact: 0.1 },
      { level: 2, text: "b", scoreImpact: 0.2 },
      { level: 3, text: "c", scoreImpact: 0.3 },
      { level: 4, text: "d", scoreImpact: 0.4 },
    ],
    followUps: [],
    rubricId: "r1",
  };
}

describe("checkClarificationAnswers — fixtures", () => {
  it("passes a correctly authored ALWAYS fact", () => {
    const scenario = scenarioWith([fact({ disclosure: "ALWAYS" })]);
    expect(checkClarificationAnswers(scenario)).toEqual([]);
  });

  it("passes a correctly authored IF_ASKED fact", () => {
    const scenario = scenarioWith([fact({ disclosure: "IF_ASKED" })]);
    expect(checkClarificationAnswers(scenario)).toEqual([]);
  });

  it("passes a correctly authored AFTER_PROBE fact", () => {
    const scenario = scenarioWith([fact({ disclosure: "AFTER_PROBE" })]);
    expect(checkClarificationAnswers(scenario)).toEqual([]);
  });

  it("flags an AFTER_PROBE fact leaked early through a colliding phrasing", () => {
    // A realistic authoring mistake: two facts share an askedAs phrase. The
    // matcher takes the first substring hit it finds, so if an ALWAYS fact
    // with the same phrasing is authored ahead of the AFTER_PROBE fact, the
    // AFTER_PROBE fact becomes reachable through the earlier fact's phrasing
    // before any probe has fired — a real leak a content review could miss.
    const scenario = scenarioWith([
      fact({ key: "always_one", disclosure: "ALWAYS", askedAs: ["can I sort it"], value: "sure, go ahead" }),
      fact({ key: "after_probe_one", disclosure: "AFTER_PROBE", askedAs: ["can I sort it"], value: "sorting loses order" }),
    ]);
    const violations = checkClarificationAnswers(scenario);
    expect(violations.some((v) => v.kind === "ANSWERABLE_TOO_EARLY" && v.factKey === "after_probe_one")).toBe(
      true,
    );
  });

  it("flags a fact whose askedAs phrasing does not resolve to itself", () => {
    // Two facts whose askedAs phrasings are identical: the matcher can only
    // pick one, so the other's canonical phrasing "resolves" to the wrong key.
    const scenario = scenarioWith([
      fact({ key: "a", askedAs: ["what happens with duplicates"], value: "value A" }),
      fact({ key: "b", askedAs: ["what happens with duplicates"], value: "value B" }),
    ]);
    const violations = checkClarificationAnswers(scenario);
    expect(violations.some((v) => v.kind === "WRONG_FACT_KEY")).toBe(true);
  });

  it("has no false positives on the ordering fact from the real scenario shape", () => {
    const scenario = scenarioWith([
      fact({
        key: "ordering",
        value: "The readings are in scan order. They are not sorted by identifier.",
        disclosure: "ALWAYS",
        askedAs: ["is the list sorted", "are they in order", "what order are the readings in"],
      }),
    ]);
    expect(checkClarificationAnswers(scenario)).toEqual([]);
  });
});

describe("checkNoHallucinatedAnswers", () => {
  it("never matches an off-topic utterance against an unrelated fact set", () => {
    const scenario = scenarioWith([fact()]);
    expect(checkNoHallucinatedAnswers(scenario)).toEqual([]);
  });
});

describe("factuality — the real scenario library", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const CONTENT_ROOT = join(here, "../../../../content/scenarios");

  let scenarios: InterviewScenarioVersion[];

  beforeAll(async () => {
    const library = await loadScenarioLibrary(CONTENT_ROOT);
    scenarios = [...library.values()].map((l) => l.version);
  });

  it("loaded more than one scenario", () => {
    expect(scenarios.length).toBeGreaterThan(1);
  });

  it("every authored fact resolves to itself, verbatim, at the right disclosure time", () => {
    for (const scenario of scenarios) {
      const violations = checkScenarioFactuality(scenario);
      expect(violations, `${scenario.id}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
    }
  });

  it("every scenario has at least one AFTER_PROBE fact worth guarding", () => {
    // Not a correctness assertion — a coverage one. If nobody authors an
    // AFTER_PROBE fact, the too-early check never has anything to catch.
    for (const scenario of scenarios) {
      const hasAfterProbe = scenario.facts.some((f) => f.disclosure === "AFTER_PROBE");
      expect(hasAfterProbe, `${scenario.id} has no AFTER_PROBE fact`).toBe(true);
    }
  });
});
