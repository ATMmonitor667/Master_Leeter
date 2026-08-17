import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SessionEvent } from "@master-leeter/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioFile, type LoadedScenario } from "../scenario/loader.js";
import { buildSessionReview, reviewAsTsv } from "./review.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");
const SESSION = "00000000-0000-4000-8000-000000000007";
let loaded: LoadedScenario;

beforeAll(async () => {
  loaded = await loadScenarioFile(SCENARIO_PATH);
});

function event(seq: number, type: SessionEvent["type"], payload: Record<string, unknown>): SessionEvent {
  return {
    sessionId: SESSION,
    seq,
    occurredAt: `2026-08-17T12:00:0${seq}.000Z`,
    type,
    actor: type === "SPEECH_FINAL" ? "CANDIDATE" : "INTERVIEWER",
    scenarioVersionId: loaded.version.id,
    payload,
    evidenceHash: `hash-${seq}`,
    traceId: "trace",
  };
}

describe("session review export", () => {
  it("pairs interviewer wording with the gate inputs and candidate turn", () => {
    const entries = buildSessionReview(
      [
        event(2, "SPEECH_FINAL", { transcript: "Is the input sorted?" }),
        event(3, "ACTION_DECIDED", {
          turnId: "turn-2",
          action: "ANSWER_CLARIFICATION",
          factKey: "ordering",
          reason: 'canonical fact "ordering"',
          classifierId: "gemini:test",
          semanticEndProbability: 0.94,
          textEndProbability: 0.9,
          silenceMs: 2500,
          turnEndReason: "settled",
        }),
      ],
      loaded.version,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      transcript: "Is the input sorted?",
      action: "ANSWER_CLARIFICATION",
      classifierId: "gemini:test",
      judgment: "",
    });
    expect(entries[0]?.utterance.length).toBeGreaterThan(0);
    expect(reviewAsTsv(entries)).toContain("judgment\tnotes");
  });
});
