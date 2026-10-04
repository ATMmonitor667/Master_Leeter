# ADR-009: Turn integrity and endpointing

Status: Implemented on `voice/low-latency`; provider measurements and human acceptance pending.

The gate remains the only authority to speak. Final transcript fragments are assembled into one open candidate turn. A deterministic speaking-now rule keeps the interviewer silent while the candidate is actively talking, and a turn held before speech stops is re-evaluated after the stop. Re-evaluation logs the silence used for its decision.

Browser timestamps are compared only with browser timestamps. The server adds elapsed time from its own clock to that client delta; it does not subtract a browser timestamp from a server timestamp. Older SILENCE_ELAPSED records without the logged delta retain their old replay calculation. Re-holds are bounded to three evaluations.

The browser estimates end-of-turn prosody from the last voiced frames. Validated probability and confidence move the policy's silence window toward a shorter confident window or longer patient window. Missing prosody retains the pinned policy's original timing. `NEXT_PUBLIC_TURN_PREDICTOR=off` and `TURN_END_PROSODY=off` disable the new input.

The client includes capped interim text on SPEECH_STOPPED so the server can start a classifier call. The result is used only when the finalized transcript matches exactly; otherwise the final transcript is classified normally. Speculation cannot authorize speech on an interim transcript. Review records the classifier source and prosody measurements.

VAD hangover is configurable from 250–800 ms. The 2026-09-25 probe used six generic TTS utterances at both 350 and 500 ms. Final transcript chunks numbered 7–22 per utterance; the first chunk arrived before `activityEnd` in all 12 runs. Last-final delay p50/p95 was 140/220 ms at 350 and 118/175 ms at 500. Including the hangover, p50 from quiet onset was approximately 490 versus 618 ms. Approximate word-sequence accuracy was 0.74 versus 0.69; exact matches were zero for both. The small synthetic sample does not support increasing the default, so it remains 350 ms pending human confirmation. The client coalesces chunks into a final turn after the stop and a short quiet period, saving classifier calls.

During cached speech, a candidate vocalization ducks playback; sustained voiced audio or an explicit yield word confirms barge-in, while a short continuer restores volume. Model-generated speech still stops immediately.

This gives up some classifier quota for speculative calls, extra browser CPU for prosody, and a small amount of early endpointing risk. Recorded microphone sessions have not established the interruption rate, missed-response rate, latency percentiles, or backchannel false-stop rate. Those results decide whether the shorter windows should remain enabled.
