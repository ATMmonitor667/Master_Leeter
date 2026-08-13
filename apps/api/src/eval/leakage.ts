import type { InterviewPolicy, InterviewScenarioVersion } from "@master-leeter/contracts";
import { POLICIES } from "../modules/orchestrator/policy.js";
import { nextAllowedHintLevel, selectProbeWording } from "../modules/scenario/probes.js";

/**
 * Leakage eval (M4-4b, half two).
 *
 * CLAUDE.md's quality table names "solution leakage rate: probes/hints
 * revealing more than the mode permits" as an acceptance criterion. Two
 * separate guarantees make that true today, both structural rather than
 * content-dependent, and both are exactly the kind of thing that quietly stops
 * being true after an unrelated refactor:
 *
 *   1. `selectProbeWording` only ever returns text an author wrote
 *      (`probe.authoredVariants`) — the model cannot phrase its own probe.
 *   2. `nextAllowedHintLevel` never returns a level above the mode's
 *      `maxHintLevel`, and never returns a hint once `hintBudget` is spent —
 *      Strict mode's candidate never hears an L2 hint no matter how stuck.
 *
 * `scenario.test.ts` unit-tests `nextAllowedHintLevel` against synthetic
 * policy objects. This file instead drives it with the three REAL mode
 * policies from `policy.ts` against every REAL scenario's probes and hint
 * ladder, so a leak shows up as "Strict mode delivered an L2 hint on
 * conveyor-rescan", not as an abstract counterexample.
 */

export type LeakageViolationKind =
  /** A probe's delivered wording is not one of its authored variants. */
  | "INVENTED_PROBE_WORDING"
  /** A hint level above what the mode's maxHintLevel permits was delivered. */
  | "HINT_EXCEEDS_MODE_CEILING"
  /** More hints were delivered than the mode's hintBudget allows. */
  | "HINT_BUDGET_EXCEEDED"
  /** A hint became available again after budget or ceiling was exhausted. */
  | "HINT_RESURRECTED_AFTER_EXHAUSTION";

export interface LeakageViolation {
  scenarioId: string;
  mode?: string;
  kind: LeakageViolationKind;
  detail: string;
}

/**
 * Every wording a probe could ever be asked to deliver — one call per use
 * count from 0 up to a margin past `maxUses` — must come from the author.
 */
export function checkProbeWording(scenario: InterviewScenarioVersion): LeakageViolation[] {
  const violations: LeakageViolation[] = [];

  for (const probe of scenario.probes) {
    const attempts = Math.max(probe.maxUses, probe.authoredVariants.length) + 1;
    for (let used = 0; used < attempts; used++) {
      const wording = selectProbeWording(probe, used);
      if (!probe.authoredVariants.includes(wording)) {
        violations.push({
          scenarioId: scenario.id,
          kind: "INVENTED_PROBE_WORDING",
          detail: `probe "${probe.id}" at use count ${used} produced wording outside authoredVariants`,
        });
      }
    }
  }

  return violations;
}

/**
 * Drives `nextAllowedHintLevel` well past a mode's budget, simulating a
 * candidate who keeps asking for help. Every level handed out must respect
 * the ceiling, the running total must never exceed budget, and once the gate
 * goes quiet it must stay quiet — no resurrection.
 */
export function checkHintCeiling(scenario: InterviewScenarioVersion, policy: InterviewPolicy): LeakageViolation[] {
  const violations: LeakageViolation[] = [];
  const hintsUsed: number[] = [];
  let sawExhaustion = false;

  for (let i = 0; i < policy.hintBudget + 4; i++) {
    const level = nextAllowedHintLevel({ policy, hintsUsed });

    if (level === null) {
      sawExhaustion = true;
      continue;
    }

    if (sawExhaustion) {
      violations.push({
        scenarioId: scenario.id,
        mode: policy.mode,
        kind: "HINT_RESURRECTED_AFTER_EXHAUSTION",
        detail: `level ${level} became available again after the hint gate had already gone quiet`,
      });
    }

    if (level > policy.maxHintLevel) {
      violations.push({
        scenarioId: scenario.id,
        mode: policy.mode,
        kind: "HINT_EXCEEDS_MODE_CEILING",
        detail: `level ${level} exceeds ${policy.mode}'s maxHintLevel of ${policy.maxHintLevel}`,
      });
    }

    hintsUsed.push(level);
  }

  if (hintsUsed.length > policy.hintBudget) {
    violations.push({
      scenarioId: scenario.id,
      mode: policy.mode,
      kind: "HINT_BUDGET_EXCEEDED",
      detail: `${hintsUsed.length} hints delivered against a budget of ${policy.hintBudget}`,
    });
  }

  return violations;
}

export function checkScenarioLeakage(scenario: InterviewScenarioVersion): LeakageViolation[] {
  const violations = [...checkProbeWording(scenario)];
  for (const policy of Object.values(POLICIES)) {
    violations.push(...checkHintCeiling(scenario, policy));
  }
  return violations;
}
