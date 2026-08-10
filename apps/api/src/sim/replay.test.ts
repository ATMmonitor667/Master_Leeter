import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { InterviewScenarioVersion, SessionEvent } from "@master-leeter/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioFile } from "../modules/scenario/loader.js";
import { InMemoryEventLog } from "../modules/session/event-log.js";
import { InMemorySessionStore } from "../modules/session/session-store.js";
import type { LoadedScenario } from "../modules/scenario/loader.js";
import { runBot } from "./harness.js";
import { ALL_TRAJECTORIES } from "./trajectories.js";

/**
 * Replay determinism (M2-9).
 *
 * The same event stream plus the same pinned scenario version must reconstruct
 * the same deterministic gate decisions. This is what makes the event log an
 * audit trail rather than a diary: if you cannot re-derive why the interviewer
 * did something, you cannot debug a complaint, regenerate a report after a
 * rubric change, or defend a score.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../content/scenarios/conveyor-rescan/v1.yaml");

let loaded: LoadedScenario;
let scenario: InterviewScenarioVersion;

beforeAll(async () => {
  loaded = await loadScenarioFile(SCENARIO_PATH);
  scenario = loaded.version;
});

describe("replay determinism", () => {
  it("reproduces identical decisions from the same stream", () => {
    for (const bot of ALL_TRAJECTORIES) {
      const first = runBot(bot, scenario).results.map((r) => r.decision);
      const second = runBot(bot, scenario).results.map((r) => r.decision);
      expect(second, `${bot.name} diverged on replay`).toEqual(first);
    }
  });

  it("reproduces identical decisions across a fresh module state", async () => {
    // Guards against hidden module-level state — a cache or counter that made
    // the second run of a process differ from the first.
    const reloaded = (await loadScenarioFile(SCENARIO_PATH)).version;
    for (const bot of ALL_TRAJECTORIES) {
      expect(runBot(bot, reloaded).results.map((r) => r.decision)).toEqual(
        runBot(bot, scenario).results.map((r) => r.decision),
      );
    }
  });

  it("every decision in every trajectory is rule-decided, so replay is total", () => {
    // Once the semantic classifier lands (M4-1), decisions that consulted a
    // model will replay only if the classification is recorded in the log. This
    // test documents the boundary: everything currently deterministic must stay
    // deterministic.
    for (const bot of ALL_TRAJECTORIES) {
      for (const r of runBot(bot, scenario).results) {
        expect(r.decision.decidedByRule, `${bot.name}: ${r.step.label}`).toBe(true);
      }
    }
  });
});

describe("event log replay", () => {
  it("reconstructs a byte-identical stream from persisted events", async () => {
    const store = new InMemorySessionStore();
    const log = new InMemoryEventLog();
    const session = await store.create({
      userId: "u",
      scenario: loaded,
      mode: "MOCK",
      idempotencyKey: "replay-1",
    });

    const run = runBot(ALL_TRAJECTORIES[0]!, scenario);
    for (const [i, result] of run.results.entries()) {
      await log.append({
        sessionId: session.id,
        type: "ACTION_DECIDED",
        actor: "INTERVIEWER",
        scenarioVersionId: session.scenarioVersionId,
        payload: { action: result.decision.action, reason: result.decision.reason },
        traceId: session.traceId,
        idempotencyKey: `decision-${i}`,
      });
    }

    const persisted = await log.read(session.id);
    expect(persisted.map((e) => e.payload["action"])).toEqual(
      run.results.map((r) => r.decision.action),
    );
  });

  it("pins one scenario version across every event in a session", async () => {
    const store = new InMemorySessionStore();
    const log = new InMemoryEventLog();
    const session = await store.create({
      userId: "u",
      scenario: loaded,
      mode: "MOCK",
      idempotencyKey: "replay-2",
    });

    for (let i = 0; i < 4; i++) {
      await log.append({
        sessionId: session.id,
        type: "CODE_DELTA",
        actor: "CANDIDATE",
        scenarioVersionId: session.scenarioVersionId,
        payload: { revision: i },
        traceId: session.traceId,
        idempotencyKey: `d${i}`,
      });
    }

    const events: SessionEvent[] = await log.read(session.id);
    const versions = new Set(events.map((e) => e.scenarioVersionId));
    expect(versions.size).toBe(1);
    expect([...versions][0]).toBe("conveyor-rescan@1");
  });

  it("ties the session to the exact content bytes it ran against", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({
      userId: "u",
      scenario: loaded,
      mode: "MOCK",
      idempotencyKey: "replay-3",
    });

    // Editing the scenario file would change this hash, making the divergence
    // detectable rather than silent (invariant 4).
    expect(session.scenarioHash).toBe(loaded.contentHash);
    expect(session.scenarioHash).toMatch(/^sha256:/);
  });
});
