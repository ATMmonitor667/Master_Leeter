# Codex completion audit

Updated: 2026-08-17  
Branch: `codex` (based on `m3-voice-completion`)

## Implemented on this branch

- **M4-5b — self-review export.** `pnpm review -- <session-id>` writes an
  annotation-ready TSV containing every authorized interviewer turn, the
  candidate transcript, resolved authored wording, classifier, timing inputs,
  gate reason, and code-freshness metrics. The endpoint is available only after
  a session ends.
- **M5-1 — transcript-aware observer.** Explicit approach commitments,
  alternatives, complexity claims, and recognized constraints now fold into
  `CandidateState` asynchronously. Missing claims remain null.
- **M5-2 — complexity mismatch.** Claimed time/space is normalized and compared
  with the detected solution family. A mismatch emits the replayable
  `COMPLEXITY_CLAIM_MISMATCH` milestone.
- **M5-3 — speech-time freshness.** Code observations carry timestamps. The
  gate and voice authorization both fail closed when a revision is behind or
  older than the mode's freshness ceiling. Revision lag and observation age are
  persisted with decisions.
- **M5-4 — bounded probe reranking.** The planner ranks only deterministically
  eligible, authored probes using the strength and relevance of recorded
  evidence. It cannot invent a probe or override pacing/silence policy.
- **M5-5 — follow-up selection.** Used branches cannot repeat. Among eligible
  authored branches, selection accounts for candidate approach, alternatives,
  completion, hints, stuck state, and branch challenge weight.
- **UI overhaul.** Reworked the setup, live workspace, and report into a shared
  responsive visual system while preserving oral-only delivery and keeping the
  interviewer transcript out of the interface. Production builds now pin the
  monorepo tracing root, and caption feature detection is safe under SSR.

## Acceptance work that still requires a person or external service

These are requirements, but they cannot be honestly completed by source code
alone:

1. **Real microphone acceptance (M3-2).** Run a session with an actual input and
   output device. Verify speech boundaries, device selection, mute, audible
   gated replies, and barge-in audio cancellation.
2. **One full 20–40 minute oral interview.** Hear the prompt, clarify, code, run,
   end, and inspect the report. This is the product-thesis acceptance test.
3. **Collect and label real interruption evidence.** Export the completed
   session with `pnpm review -- <session-id> --out review.tsv`, label roughly ten
   annoying or missed interventions, tune thresholds, then rerun `pnpm eval`.
4. **Provider quota verification.** Confirm the configured Gemini classifier and
   realtime models have enough requests/minute for a full session and check that
   `classifierId` does not unexpectedly show fallback during the run.

## Explicitly cut / optional productization

The existing MVP plan excludes these from personal-tool completion. They remain
necessary before a hosted multi-user production launch:

- hosted authentication and authorization;
- a live Judge0 sandbox instead of model-judged runs;
- wiring and operational verification of the Postgres event log;
- evaluator calibration against a human-scored gold set;
- OpenTelemetry, an eval dashboard, and a full accessibility audit.

## Verification commands

```bash
pnpm typecheck
pnpm test
pnpm eval
pnpm build
pnpm check:sorted
pnpm check:env
```
