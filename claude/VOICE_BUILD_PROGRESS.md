# Voice build progress

Plan: `VOICE_BUILD_PLAN.txt` (2026-09-24). Branch: `voice/low-latency`.
The plan was recovered from repository commit `47b1e24` because it was absent
from this branch's checkout. Its baseline notes describe an earlier checkout;
the status below describes the current branch.

| Phase | State | Evidence and remaining work |
| --- | --- | --- |
| P0 | Done in prior commits | Branch starts from `main` at `ec8407a`. Existing unrelated `.gitignore` and `.claude/` changes remain untouched. |
| P1 | Code present (`af34aa6`); provider probe run 2026-09-25 | Ledger and review exist. Replaced the tone-wave probe with spoken TTS samples and measured Q1–Q4 below. No human latency target is claimed. |
| P2 | Code present (`1587669`) | D-1 through D-8 have implementations. Human voice acceptance remains open. |
| P3 | Code present (`77c4188`) with browser completion in this checkpoint | Authored audio is pre-rendered and sent only after authorization. Browser now schedules the inline audio head, streams the tail, handles barge-in/reconnect, and reports completion. Render verification is wired. Persistent storage is optional and undecided; live fidelity is unverified. |
| P4 | Code implemented in this checkpoint | Predictor, VAD, transport, policy windows, runtime validation/checkpoints and privacy redaction are wired. Real-session interruption and latency measurements remain open. |
| P5 | Code implemented in this checkpoint | Interim text starts a bounded speculative classifier call. Only an exact finalized-text match reuses it; source is logged and exported. Rule fast path remains off. |
| P6 | Configurable; default 350 ms | TTS speech probe favors 350 ms from quiet onset; owner/human confirmation remains. |
| P7 | Code implemented in this checkpoint | Room tone and duck-then-cancel for cached speech, with immediate model barge-in. Human backchannel checks remain. |
| P8 | Partial | Review exposes classifier source and prosody fields. New timed trajectories/eval thresholds are left for the owner's separate testing pass. |
| P9 | Draft records present | ADR-008/009, tuning guide, production backlog, and result record. Acceptance data remains open. |
| P10 | Human acceptance open | Three recorded microphone sessions and tuning against latency **and** interruption rate. |

Existing checks on this working tree: workspace typecheck passed after fixing
pre-existing P3 typing errors; API 786 passed / 16 database tests skipped; web
136 passed. The production build, existing evaluation gates, bundle check,
sorted-file check, and environment scan passed. No test files were added in
this pass, per owner request.

P1 provider probe (six generic TTS utterances, both hangovers, one run):
- Q1: 7–22 final chunks per activity segment (mean 12.33 at 350 ms, 13.33 at 500 ms).
- Q2: last-final delay after activityEnd p50/p95: 140/220 ms at 350 ms; 118/175 ms at 500 ms. From quiet onset including hangover, the corresponding p50 is about 490 vs 618 ms.
- Q3: the first final arrived before activityEnd in all 12 runs.
- Q4: exact word match was 0/6 for both. Approximate word-sequence accuracy was 0.74 at 350 ms and 0.69 at 500 ms; this small synthetic sample does not show a benefit from the longer hangover. Keep 350 ms pending human confirmation. Raw transcripts and audio were not retained.

Cached-speech word fidelity, microphone behavior, and the plan's end-to-end
p50/p95 target remain unmeasured. `TURN_END_PROSODY=off` or
`NEXT_PUBLIC_TURN_PREDICTOR=off` restores the clock-only turn window.
