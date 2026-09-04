# Codex completion audit

Updated: 2026-09-04
Branch: current workspace

## Implemented on this branch

- **M1-2b — automatic stage advancement.** A deterministic, forward-only stage
  driver now advances a live interview from brief delivery through clarification,
  approach, implementation, testing, follow-up, and wrap-up. Every transition is
  server-authored, persisted, synchronized with the runtime, and pushed to clients.
- **Candidate-neutral workspace.** The editor no longer leaks assumptions from the
  conveyor-rescan scenario. Reconnect restores the server-authoritative stage.
- **2026 cockpit refresh.** The setup page, interview workspace, and evidence report
  now share an editorial developer-tool visual system with selectable scenario cards,
  a live stage rail, purposeful voice/run feedback, confirmation flows, responsive
  panel stacking, reduced-motion behavior, and an accessible hydration-safe captions
  control.

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
- **UI foundation.** Preserved oral-only delivery and kept the interviewer transcript
  and full problem statement out of the DOM and client bundle.

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
pnpm sim
pnpm eval
pnpm build
pnpm check:bundle
pnpm check:sorted
pnpm check:env
```

Verified 2026-09-04: typecheck passed; 761 unit/integration tests passed
(615 API, 108 web, 38 contracts); 32 simulator tests passed; interruption and
content evals passed with zero threshold violations; production build and all
three repository checks passed; desktop and 390 px browser smoke tests passed.
