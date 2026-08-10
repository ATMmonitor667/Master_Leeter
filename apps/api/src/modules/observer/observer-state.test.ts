import { emptyCandidateState } from "@master-leeter/contracts";
import { describe, expect, it } from "vitest";
import { buildSnapshot, emptyMilestoneState, observe, type ObserverInput } from "./index.js";

const NOW = "2026-08-10T00:00:00.000Z";

const OPTIMAL = `def first_rescan(readings):
    seen = set()
    for r in readings:
        if r in seen:
            return r
        seen.add(r)
    return None
`;

const STUB = `def first_rescan(readings):
    pass
`;

function input(overrides: Partial<ObserverInput> = {}): ObserverInput {
  return {
    previous: emptyCandidateState(NOW),
    milestones: emptyMilestoneState(),
    secondsSinceCodeActivity: 2,
    consecutiveFailures: 0,
    now: NOW,
    ...overrides,
  };
}

describe("observer — code-derived state", () => {
  it("detects the solution family from the snapshot", async () => {
    const snapshot = await buildSnapshot(OPTIMAL, 5);
    const { state } = observe(input({ snapshot }));
    expect(state.detectedSolutionFamilyId).toBe("sf-set-single-pass");
  });

  it("records the revision the state was derived from", async () => {
    // The gate's staleness guard compares this against the latest revision.
    // Commenting on code that has already changed is a visible failure.
    const snapshot = await buildSnapshot(OPTIMAL, 12);
    const { state } = observe(input({ snapshot }));
    expect(state.derivedFromRevision).toBe(12);
  });

  it("separates a stub from a real attempt", async () => {
    const stub = observe(input({ snapshot: await buildSnapshot(STUB, 1) })).state;
    const real = observe(input({ snapshot: await buildSnapshot(OPTIMAL, 2) })).state;
    expect(real.implementationProgress).toBeGreaterThan(stub.implementationProgress);
  });

  it("leaves transcript-derived fields null until the classifier lands", async () => {
    // A claim the candidate never made must not be invented. Null means
    // absence, and complexityMismatch already treats absence as "no probe".
    const { state } = observe(input({ snapshot: await buildSnapshot(OPTIMAL, 1) }));
    expect(state.claimedTime).toBeNull();
    expect(state.claimedSpace).toBeNull();
    expect(state.alternativesMentioned).toEqual([]);
  });

  it("grades activity by recency", () => {
    expect(observe(input({ secondsSinceCodeActivity: 2 })).state.recentCodeActivity).toBe("HIGH");
    expect(observe(input({ secondsSinceCodeActivity: 15 })).state.recentCodeActivity).toBe("MEDIUM");
    expect(observe(input({ secondsSinceCodeActivity: 45 })).state.recentCodeActivity).toBe("LOW");
    expect(observe(input({ secondsSinceCodeActivity: 200 })).state.recentCodeActivity).toBe("NONE");
  });
});

describe("observer — stuck score", () => {
  it("does not treat thinking time as being stuck", async () => {
    // The single most important property here. A stuck score that rose with
    // silence would turn the hint rule into an impatience rule, which is the
    // failure mode this whole product exists to avoid.
    const snapshot = await buildSnapshot(OPTIMAL, 3);
    const { state } = observe(input({ snapshot, secondsSinceCodeActivity: 240, consecutiveFailures: 0 }));
    expect(state.stuckScore).toBe(0);
  });

  it("rises with repeated identical failures", () => {
    expect(observe(input({ consecutiveFailures: 1 })).state.stuckScore).toBe(0);
    expect(observe(input({ consecutiveFailures: 2 })).state.stuckScore).toBeGreaterThan(0);
    expect(observe(input({ consecutiveFailures: 3 })).state.stuckScore).toBeGreaterThan(
      observe(input({ consecutiveFailures: 2 })).state.stuckScore,
    );
  });

  it("counts inactivity only when paired with little progress", async () => {
    const barelyStarted = await buildSnapshot(STUB, 1);
    const idleAndStuck = observe(
      input({ snapshot: barelyStarted, secondsSinceCodeActivity: 120 }),
    ).state.stuckScore;
    const idleButFar = observe(
      input({ snapshot: await buildSnapshot(OPTIMAL, 1), secondsSinceCodeActivity: 120 }),
    ).state.stuckScore;

    expect(idleAndStuck).toBeGreaterThan(0);
    expect(idleButFar).toBe(0);
  });

  it("drops to zero once the tests pass", () => {
    const milestones = { ...emptyMilestoneState(), reached: ["BASE_TESTS_PASS" as const] };
    const { state } = observe(input({ milestones, consecutiveFailures: 5 }));
    expect(state.stuckScore).toBe(0);
  });

  it("never exceeds one", () => {
    expect(observe(input({ consecutiveFailures: 99 })).state.stuckScore).toBeLessThanOrEqual(1);
  });
});

describe("observer — determinism", () => {
  it("produces the same state for the same input", async () => {
    const snapshot = await buildSnapshot(OPTIMAL, 4);
    const a = observe(input({ snapshot }));
    const b = observe(input({ snapshot }));
    expect(a.state).toEqual(b.state);
  });
});
