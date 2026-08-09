# @master-leeter/contracts

The seam between the three engineering lanes. **Freeze early, change by agreement.**

Lane A develops against a fake client, Lane B against a fake orchestrator, and Lane C against
recorded event streams. That only holds while these types are stable.

## Ordering rules

- `seq` is **strictly increasing within a session**, assigned server-side. Never client-side.
- Gaps mean lost events — the server responds `REPLAY_FROM`. Duplicates are dropped silently.
- Events are **append-only**. No code path updates or deletes a persisted event.
- A session's events never span two scenario versions. `scenarioVersionId` is pinned at
  session creation and copied onto every event.

## Idempotency rules

- Every client → server event carries `idempotencyKey` (client-generated, stable across
  retries) and `clientSeq`.
- Reconnects **will** replay events. Duplicate `idempotencyKey` for a session is a no-op that
  returns the original `ACK`.
- Every mutating HTTP operation carries the same key in an `Idempotency-Key` header.

## Trace rules

- One `traceId` per session, propagated to every event, orchestrator decision, model call,
  code run, and report job.
- Per-turn spans hang off it, so "why did the interviewer speak at 14:32?" is answerable from
  traces alone.

## Invariants encoded here

| Invariant | Where |
|---|---|
| Silence is a first-class action | `InterviewAction.STAY_SILENT`, `SILENT()` helper |
| Turn detection ≠ permission to speak | `SPEECH_STOPPED` is an event, not a trigger; `GateDecision` is the only path to speech |
| Per-state action limits | `ALLOWED_ACTIONS`, `isActionAllowed` |
| Evaluator can't speak live | `ALLOWED_ACTIONS.EVALUATION === []` |
| Clarifications come from facts | `ClarificationResult` has no free-text branch |
| Scenario versions are immutable | `InterviewScenarioVersion.status` lifecycle; retire, don't edit |
| Content provenance is mandatory | `ProvenanceSchema` is required, not optional |
| Every decision is explainable | `GateDecision.reason` is required, including for silence |
| Code staleness is trackable | `groundedInRevision`, `derivedFromRevision` |

## Deliberately loose

`SessionEvent.payload` is `Record<string, unknown>` at this boundary. Each module narrows it
with its own schema. What is *not* loose: seq, ordering, actor, version pin, evidence hash,
trace ID — the fields that make the log replayable and auditable.
