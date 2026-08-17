import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { emptyCandidateState } from "@master-leeter/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioFile, type LoadedScenario } from "../scenario/loader.js";
import { emptyMilestoneState } from "./milestones.js";
import { extractComplexityClaims, observeTranscript } from "./transcript.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");
const NOW = "2026-08-17T12:00:00.000Z";
let loaded: LoadedScenario;

beforeAll(async () => {
  loaded = await loadScenarioFile(SCENARIO_PATH);
});

describe("transcript observer", () => {
  it("extracts explicit time and space claims", () => {
    expect(extractComplexityClaims("Time is O(n log n), and space is O(n)."))
      .toEqual({ time: "O(n log n)", space: "O(n)" });
    expect(extractComplexityClaims("This should be linear time and constant space."))
      .toEqual({ time: "O(n)", space: "O(1)" });
  });

  it("leaves unspoken claims absent", () => {
    const result = observeTranscript(
      emptyCandidateState(NOW),
      emptyMilestoneState(),
      loaded.version,
      { transcript: "I think this should work.", intent: "THINK_ALOUD", observedAt: NOW },
    );
    expect(result.state.claimedTime).toBeNull();
    expect(result.state.currentApproach).toBeNull();
  });

  it("records an explicit approach, alternatives, and recognized constraints", () => {
    const result = observeTranscript(
      emptyCandidateState(NOW),
      emptyMilestoneState(),
      loaded.version,
      {
        transcript: "My approach is to use a set. I could also sort it. Can the list be empty?",
        intent: "APPROACH_COMMITMENT",
        observedAt: NOW,
      },
    );
    expect(result.state.currentApproach).toContain("use a set");
    expect(result.state.alternativesMentioned).toContain("sort it");
    expect(result.state.understoodConstraints).toContain("empty_input");
  });

  it("emits the mismatch milestone when a claim conflicts with detected code", () => {
    const previous = {
      ...emptyCandidateState(NOW),
      detectedSolutionFamilyId: "sf-set-single-pass",
    };
    const result = observeTranscript(previous, emptyMilestoneState(), loaded.version, {
      transcript: "The time complexity is O(1).",
      intent: "COMPLEXITY_CLAIM",
      observedAt: NOW,
    });
    expect(result.emitted).toEqual(["COMPLEXITY_CLAIM_MISMATCH"]);
    expect(result.state.claimedTime).toBe("O(1)");
  });
});
