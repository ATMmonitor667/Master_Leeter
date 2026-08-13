import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InterviewScenarioVersion, Probe } from "@master-leeter/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioLibrary } from "../modules/scenario/loader.js";
import { POLICIES } from "../modules/orchestrator/policy.js";
import { nextAllowedHintLevel } from "../modules/scenario/probes.js";
import { checkHintCeiling, checkProbeWording, checkScenarioLeakage } from "./leakage.js";

/**
 * M4-4b, leakage half.
 *
 * `scenario.test.ts` already unit-tests `nextAllowedHintLevel` and
 * `selectProbeWording` in isolation with synthetic policy objects. This file
 * drives the same functions with the three real mode policies against real
 * scenario content, and adds the aggregate zero-tolerance assertion CI gates
 * on.
 */

const probe = (overrides: Partial<Probe> = {}): Probe => ({
  id: "p1",
  trigger: "always",
  questionIntent: "test intent",
  authoredVariants: ["variant one", "variant two"],
  maxUses: 2,
  priority: 0,
  ...overrides,
});

describe("checkProbeWording", () => {
  it("passes a probe whose selector only returns authored variants", () => {
    const scenario = { id: "fixture@1", probes: [probe()] } as InterviewScenarioVersion;
    expect(checkProbeWording(scenario)).toEqual([]);
  });

  it("flags a probe with no authored variants to select from", () => {
    // selectProbeWording throws rather than inventing wording when the
    // variants list is empty — a scenario-authoring mistake the schema
    // (`.min(1)`) should already prevent, but content eval treats it as a
    // hard failure rather than crashing the whole run.
    const scenario = { id: "fixture@1", probes: [probe({ authoredVariants: [] })] } as InterviewScenarioVersion;
    expect(() => checkProbeWording(scenario)).toThrow();
  });
});

describe("checkHintCeiling", () => {
  it("never exceeds Strict's L1 ceiling however long the candidate keeps asking", () => {
    const scenario = { id: "fixture@1" } as InterviewScenarioVersion;
    const violations = checkHintCeiling(scenario, POLICIES.STRICT);
    expect(violations).toEqual([]);
  });

  it("never exceeds Mock's L2 ceiling or its budget", () => {
    const scenario = { id: "fixture@1" } as InterviewScenarioVersion;
    const violations = checkHintCeiling(scenario, POLICIES.MOCK);
    expect(violations).toEqual([]);
  });

  it("never exceeds Learning's L4 ceiling or its budget", () => {
    const scenario = { id: "fixture@1" } as InterviewScenarioVersion;
    const violations = checkHintCeiling(scenario, POLICIES.LEARNING);
    expect(violations).toEqual([]);
  });

  it("respects a budget tighter than the ceiling would otherwise allow", () => {
    const scenario = { id: "fixture@1" } as InterviewScenarioVersion;
    const tightBudget = { ...POLICIES.LEARNING, hintBudget: 1 };
    const violations = checkHintCeiling(scenario, tightBudget);
    expect(violations).toEqual([]);
  });

  it("is sensitive to the ceiling — a sanity check on the check itself", () => {
    // Not a regression test on production code: if `nextAllowedHintLevel` ever
    // stopped reading `maxHintLevel`, every "passes" assertion above would
    // stay green for the wrong reason. This asserts the raw function's output
    // actually changes when the ceiling does, so those assertions mean
    // something.
    const highestUnderStrict = maxLevelDelivered(POLICIES.STRICT);
    const highestUnderWider = maxLevelDelivered({ ...POLICIES.STRICT, maxHintLevel: 3, hintBudget: 3 });
    expect(highestUnderWider).toBeGreaterThan(highestUnderStrict);
  });
});

function maxLevelDelivered(policy: (typeof POLICIES)["STRICT"]): number {
  let hintsUsed: number[] = [];
  let highest = 0;
  for (let i = 0; i < policy.hintBudget + 4; i++) {
    const level = nextAllowedHintLevel({ policy, hintsUsed });
    if (level === null) continue;
    highest = Math.max(highest, level);
    hintsUsed = [...hintsUsed, level];
  }
  return highest;
}

describe("leakage — the real scenario library", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const CONTENT_ROOT = join(here, "../../../../content/scenarios");

  let scenarios: InterviewScenarioVersion[];

  beforeAll(async () => {
    const library = await loadScenarioLibrary(CONTENT_ROOT);
    scenarios = [...library.values()].map((l) => l.version);
  });

  it("no probe in any scenario can produce wording outside its authored variants", () => {
    for (const scenario of scenarios) {
      const violations = checkProbeWording(scenario);
      expect(violations, `${scenario.id}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
    }
  });

  it("no mode, on any scenario, ever exceeds its hint ceiling or budget", () => {
    for (const scenario of scenarios) {
      const violations = checkScenarioLeakage(scenario);
      expect(violations, `${scenario.id}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
    }
  });
});
