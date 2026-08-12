import type { ClientEventType } from "@master-leeter/contracts";

/**
 * What happens to each event a client is allowed to send.
 *
 * This exists because of a defect the codebase has now produced three times:
 * something is built, unit-tested, and never connected. `RUN_REQUESTED` was the
 * clearest case — the client emitted it over the socket for weeks while the only
 * code that could start a run was an HTTP route nothing called. Both halves were
 * green, because each was tested against a fake of the other.
 *
 * The type below is the fix, and the enforcement is the type rather than the
 * test: `Record<ClientEventType, …>` is exhaustive, so widening
 * `CLIENT_EVENT_TYPES` fails to compile until the new type's disposition is
 * written down here. The question "who consumes this?" gets asked at the moment
 * the capability is granted, which is the only moment anyone knows the answer.
 *
 * `EVIDENCE_ONLY` is a first-class answer, not an escape hatch. `NOTE_DELTA` has
 * no live consumer by design — notes are session evidence and a stall signal,
 * not an input to any decision (M2-5). Saying so explicitly is worth more than a
 * handler that exists to satisfy a rule.
 */

export type ClientEventDisposition =
  | { kind: "CONSUMED"; by: string }
  | { kind: "EVIDENCE_ONLY"; why: string };

export const CLIENT_EVENT_DISPOSITIONS: Record<ClientEventType, ClientEventDisposition> = {
  CODE_DELTA: {
    kind: "CONSUMED",
    by: "InterviewRuntime.ingest — advances latest revision, schedules an observation pass",
  },
  NOTE_DELTA: {
    kind: "EVIDENCE_ONLY",
    why: "notes are evidence and a stall signal, never an input to a gate decision (M2-5)",
  },
  RUN_REQUESTED: {
    kind: "CONSUMED",
    by: "session/runs.ts handleRunRequestedEvent — resolves the revision and enqueues execution",
  },
  SPEECH_STARTED: {
    kind: "CONSUMED",
    by: "InterviewRuntime.ingest — marks candidate speaking, invalidates the last quiet period",
  },
  SPEECH_STOPPED: {
    kind: "CONSUMED",
    by: "InterviewRuntime.ingest — records when quiet began, the timing half of M4-2",
  },
  SPEECH_FINAL: {
    kind: "CONSUMED",
    by: "InterviewRuntime.ingest — the only event type that can reach the Response Gate",
  },
  BARGE_IN: {
    kind: "CONSUMED",
    by: "InterviewRuntime.ingest — yields the floor; gate rule 1 reads the resulting flags",
  },
};
