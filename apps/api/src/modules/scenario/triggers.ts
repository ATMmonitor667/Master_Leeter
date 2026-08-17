import type { CandidateState, InterviewScenarioVersion, InterviewState } from "@master-leeter/contracts";

/**
 * Trigger evaluation for probes and follow-ups (part of M1-5).
 *
 * Scenario authors write triggers as short expressions:
 *
 *   claimedTime.present && claimedTime != detectedFamily.timeComplexity
 *   milestone(BASE_TESTS_PASS) && state == TEST_AND_DEBUG
 *   solvedOptimally && remainingMinutes >= 8 && !usedFollowUp(fu-streaming-window)
 *
 * This is a conjunction of predicates, nothing more — no disjunction, no
 * parentheses, no arithmetic. That is a deliberate ceiling. A trigger language
 * rich enough to need a real parser is a trigger language rich enough to hide
 * bugs from content authors, and every probe that fires wrongly is a visible
 * product failure. Anything genuinely needing OR should be two probes.
 *
 * Unknown predicates throw at load time rather than silently evaluating false —
 * a typo'd trigger that never fires is the worst failure mode here, because it
 * looks exactly like a well-behaved quiet interviewer.
 */

export interface TriggerContext {
  scenario: InterviewScenarioVersion;
  candidateState: CandidateState;
  state: InterviewState;
  remainingMinutes: number;
  /** Follow-up ids already presented. */
  followUpsUsed: readonly string[];
  /** True when the detected family is marked optimal and base tests pass. */
  solvedOptimally: boolean;
}

export class UnknownPredicateError extends Error {
  constructor(readonly predicate: string) {
    super(`Unknown trigger predicate: "${predicate}"`);
    this.name = "UnknownPredicateError";
  }
}

const CALL = /^(\w+)\(([\w-]+)\)$/;
const COMPARISON = /^([\w.]+)\s*(==|!=|>=|<=)\s*([\w.-]+)$/;
const PRESENT = /^([\w]+)\.present$/;
const INCLUDES = /^([\w]+)\.includes\(([\w-]+)\)$/;

export function evaluateTrigger(expression: string, ctx: TriggerContext): boolean {
  const terms = expression
    .split("&&")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (terms.length === 0) return false;

  return terms.every((term) => {
    const negated = term.startsWith("!");
    const body = negated ? term.slice(1).trim() : term;
    const value = evaluateTerm(body, ctx);
    return negated ? !value : value;
  });
}

function evaluateTerm(term: string, ctx: TriggerContext): boolean {
  const { candidateState: cs } = ctx;

  if (term === "solvedOptimally") return ctx.solvedOptimally;

  const call = CALL.exec(term);
  if (call) {
    const [, fn, arg] = call;
    if (!fn || !arg) throw new UnknownPredicateError(term);

    switch (fn) {
      case "milestone":
        return (cs.milestonesReached as readonly string[]).includes(arg);
      case "usedFollowUp":
        return ctx.followUpsUsed.includes(arg);
      case "usedProbe":
        return cs.probeHistory.includes(arg);
      default:
        throw new UnknownPredicateError(term);
    }
  }

  const includes = INCLUDES.exec(term);
  if (includes) {
    const [, field, arg] = includes;
    if (!field || !arg) throw new UnknownPredicateError(term);
    switch (field) {
      case "understoodConstraints":
        return cs.understoodConstraints.includes(arg);
      case "alternativesMentioned":
        return cs.alternativesMentioned.includes(arg);
      case "probeHistory":
        return cs.probeHistory.includes(arg);
      default:
        throw new UnknownPredicateError(term);
    }
  }

  const present = PRESENT.exec(term);
  if (present) {
    const [, field] = present;
    switch (field) {
      case "claimedTime":
        return cs.claimedTime !== null;
      case "claimedSpace":
        return cs.claimedSpace !== null;
      case "currentApproach":
        return cs.currentApproach !== null;
      case "detectedFamily":
        return cs.detectedSolutionFamilyId !== null;
      default:
        throw new UnknownPredicateError(term);
    }
  }

  const comparison = COMPARISON.exec(term);
  if (comparison) {
    const [, left, op, right] = comparison;
    if (!left || !op || !right) throw new UnknownPredicateError(term);
    const l = resolve(left, ctx);
    const r = resolve(right, ctx);
    const comparable =
      left === "claimedTime" || left === "claimedSpace" || right.includes("Complexity")
        ? [normalizeComplexityValue(l), normalizeComplexityValue(r)]
        : [l, r];

    switch (op) {
      case "==":
        return comparable[0] === comparable[1];
      case "!=":
        // A null claim is not a mismatch — it's an absence. Requiring
        // `claimedTime.present` alongside is the author's job, but treating
        // "unknown" as "wrong" would fire complexity probes at candidates who
        // never made a claim.
        if (l === null || r === null) return false;
        return comparable[0] !== comparable[1];
      case ">=":
        return numeric(l) >= numeric(r);
      case "<=":
        return numeric(l) <= numeric(r);
      default:
        throw new UnknownPredicateError(term);
    }
  }

  throw new UnknownPredicateError(term);
}

function normalizeComplexityValue(value: string | number | null): string | number | null {
  return typeof value === "string"
    ? value.toLowerCase().replace(/\s+/g, "").replace(/\^/g, "")
    : value;
}

function resolve(token: string, ctx: TriggerContext): string | number | null {
  const { candidateState: cs } = ctx;

  switch (token) {
    case "state":
      return ctx.state;
    case "remainingMinutes":
      return ctx.remainingMinutes;
    case "claimedTime":
      return cs.claimedTime;
    case "claimedSpace":
      return cs.claimedSpace;
    case "detectedFamily":
      return cs.detectedSolutionFamilyId;
    case "stuckScore":
      return cs.stuckScore;
    case "implementationProgress":
      return cs.implementationProgress;
    case "detectedFamily.timeComplexity": {
      const fam = ctx.scenario.solutionFamilies.find((f) => f.id === cs.detectedSolutionFamilyId);
      return fam?.timeComplexity ?? null;
    }
    case "detectedFamily.spaceComplexity": {
      const fam = ctx.scenario.solutionFamilies.find((f) => f.id === cs.detectedSolutionFamilyId);
      return fam?.spaceComplexity ?? null;
    }
    default: {
      const asNumber = Number(token);
      if (!Number.isNaN(asNumber)) return asNumber;
      // Bare identifiers are literals: state names, family ids, complexity strings.
      return token;
    }
  }
}

function numeric(v: string | number | null): number {
  if (typeof v === "number") return v;
  if (v === null) return Number.NaN;
  const n = Number(v);
  return Number.isNaN(n) ? Number.NaN : n;
}

/**
 * Validates every trigger in a scenario against a representative context.
 *
 * Called at load time so a typo fails the build rather than producing an
 * interviewer that is quiet for the wrong reason.
 */
export function validateScenarioTriggers(
  scenario: InterviewScenarioVersion,
  sample: TriggerContext,
): string[] {
  const errors: string[] = [];

  for (const probe of scenario.probes) {
    try {
      evaluateTrigger(probe.trigger, sample);
    } catch (err) {
      errors.push(`probe "${probe.id}": ${(err as Error).message}`);
    }
  }
  for (const followUp of scenario.followUps) {
    try {
      evaluateTrigger(followUp.trigger, sample);
    } catch (err) {
      errors.push(`followUp "${followUp.id}": ${(err as Error).message}`);
    }
  }

  return errors;
}
