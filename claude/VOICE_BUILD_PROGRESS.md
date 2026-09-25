# Voice build progress

Plan: `VOICE_BUILD_PLAN.txt` (2026-09-24). Branch: `voice/low-latency`.
The plan was recovered from repository commit `47b1e24` because it was absent
from this branch's checkout. Its baseline notes describe an earlier checkout;
the status below describes the current branch.

| Phase | State | Evidence and remaining work |
| --- | --- | --- |
| P0 | Done in prior commits | Branch starts from `main` at `ec8407a`. Existing unrelated `.gitignore` and `.claude/` changes remain untouched. |
| P1 | Code present (`af34aa6`); measurement open | Latency ledger, review, and transcription probe exist. Provider measurements Q1–Q4 have not been recorded; no latency target is claimed. |
| P2 | Code present (`1587669`) | D-1 through D-8 have implementations. Human voice acceptance remains open. |
| P3 | Code present (`77c4188`) with follow-up in this checkpoint | Authored audio is pre-rendered and sent only after authorization. This follow-up wires render transcription verification, refreshes the cache on voice-ready, and shortens playback lead on an active audio context. Persistent storage is optional and undecided; live fidelity is unverified. |
| P4 | Code implemented in this checkpoint | Predictor, VAD, transport, policy windows, runtime validation/checkpoints and privacy redaction are wired. Real-session interruption and latency measurements remain open. |
| P5–P9 | Open | Speculative classification, measured hangover choice, presence/barge-in, evaluation trajectories, and final records. |
| P10 | Human acceptance open | Three recorded microphone sessions and tuning against latency **and** interruption rate. |

Existing checks on this working tree: workspace typecheck passed after fixing
pre-existing P3 typing errors; API 786 passed / 16 database tests skipped; web
136 passed. The production build, existing evaluation gates, bundle check,
sorted-file check, and environment scan passed. No test files were added in
this pass, per owner request.

Provider transcription Q1–Q4, cached-speech word fidelity, microphone behavior,
and the plan's p50/p95 target remain unmeasured. `TURN_END_PROSODY=off` or
`NEXT_PUBLIC_TURN_PREDICTOR=off` restores the clock-only turn window.
