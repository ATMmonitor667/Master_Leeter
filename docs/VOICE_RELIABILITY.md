# Voice reliability improvements

The website uses Gemini Live over WebSocket with client-side voice activity detection (VAD), server-authorized interviewer turns, and cached authored speech where available. These changes repair the existing integration without changing providers or allowing the model to bypass interview policy.

## Research

Sources checked on October 11, 2026, before implementation:

- [Google Live API best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices): stream small chunks, resample microphone audio to 16 kHz, discard queued output on interruption, and resume sessions after provider disconnects.
- [Google Live API capabilities: manual VAD](https://ai.google.dev/gemini-api/docs/live-api/capabilities): manual VAD bypasses provider pre-speech buffering; client-side buffering preserves speech onset. Google recommends at least 500 ms of end-of-speech silence to avoid fragmenting natural speech.
- [Developer reports on the Google AI forum](https://discuss.ai.google.dev/t/gemini-3-1-flash-live-great-upgrade-from-2-5-two-model-behavior-observations-from-production-voice-app/136670/5): a developer reports disconnects when audio is sent between manual activity boundaries, and emphasizes echo cancellation and session resumption. This is experience reported by a developer, not a measured diagnosis of this website.
- [Community discussion of voice latency](https://www.reddit.com/r/AI_Agents/comments/1sihelm/is_it_just_me_or_does_the_lag_in_cloud_voice_ais/): users describe delays and false interruptions as disruptive to conversational flow. These anecdotes motivate testing turn-taking separately from time to first audio.

## Changes

- Microphone capture is connected to the output graph through zero gain, keeping the worklet active without monitoring the user's microphone.
- The context requests interactive latency and explicitly resumes during startup.
- Capture frames use the actual context sample rate to maintain 20 ms chunks at 44.1 and 48 kHz.
- Input audio is transmitted only inside manual activity boundaries. A bounded 160 ms pre-roll is flushed after activity start to preserve speech onset. Muting and disconnecting clear the buffer. Speech that begins during the handshake receives a provider activity boundary once ready.
- Browser VAD defaults to 500 ms of silence; overrides below 500 ms are ignored. The server still uses quiet-onset timestamps, so the increased detection window does not simply add 150 ms to every policy wait.
- The voice client tracks queued model playback separately from generation. Barge-in remains available until audible playback drains, including after provider turn completion.
- Provisional interruptions reduce gain to 25% rather than nearly muting output. Quiet gaps reset the sustained-speech confirmation window. Explicit interruption words are recognized in final as well as interim transcripts.
- WebSocket binary messages use ArrayBuffer delivery instead of asynchronous Blob conversion.

## Validation and limits

Regression tests exercise repeated activity boundaries, bounded pre-roll, natural pauses, speech during connection startup, explicit and provisional interruptions, queued model audio after generation completion, capture at both common sample rates, and resource cleanup. TypeScript validation checks the browser wiring.

These checks do not measure live provider latency, microphone echo, network jitter, or human-perceived voice quality. No live API call, credential change, provider migration, or deployment is required by these changes.

For live acceptance, compare the same short conversation before and after on the same browser, microphone, network, and policy. Include a 400 ms mid-sentence pause, a cough during cached playback, an explicit "stop", and interruption after provider generation has ended. Record time from quiet onset to first audible sample and time from interruption to output silence using the existing voice latency ledger and a recording. Run several minutes to cover reconnects. Report medians and tail latency rather than claiming an improvement from one turn.

Interview policy intentionally allows thinking time. These fixes preserve that behavior; low transport latency alone cannot make every policy-controlled response immediate. Cached audio tail failures and provider generation stalls remain separate possible causes of incomplete speech and need live evidence if they persist.

## Problem-delivery failure traced on October 11

The session ending in `7af5` recorded the question "So wha t is the problem that we'll be solving today?" as an explicit question, but chose `ACKNOWLEDGE_BRIEFLY` with `NO_SUCH_FACT`. A preceding session recorded a request for the problems and chose silence because that acknowledgement was forbidden during implementation. The pinned scenario was Parts Bin, with one authored task; it did not contain the reported generic introduction about two coding problems.

Three integration defects explained the missing task:

1. The constrained Gemini session did not register any function declarations. The persona named tools which the model could not actually invoke.
2. The runtime advanced from oral delivery to clarification before the model fetched the brief. The tool checked the old stage rather than the active delivery authorization and omitted the brief after that transition.
3. Requests such as "what is the problem?" were handled as unmatched canonical fact questions. Repeating the brief was also forbidden after the clarification stage.

The session now registers all six tools, supplies the exact authorized opening or repeat wording even after the stage changes, and recognizes narrowly defined requests to hear the problem. Reviewed repeats remain gate-controlled and are permitted during approach exploration, implementation, and testing. The voice persona explicitly exempts full problem delivery from its usual two-sentence limit. No scenario version or existing session record was changed.

Regression coverage checks the actual HTTP/WebSocket sequence through authorization, stage advancement, tool retrieval, repeat request, and authorization closure. `apps/api/scripts/verify-voice-delivery.ts` additionally creates an isolated in-memory interview and checks real constrained Gemini tool calls, PCM output, and output transcription without storing audio. On the successful live run, the opening yielded 25 seconds of PCM and the repeat yielded 8.84 seconds; expected-word coverage was 1.0 for both. First audio arrived in 2.085 and 2.944 seconds respectively. These are individual observations, not latency benchmarks or guarantees of exact acoustic fidelity.

An earlier live attempt passed the opening but timed out on the repeat. A browser watchdog now surfaces an authorized model turn with no audio after 15 seconds and reconnects; an empty provider turn is no longer reported as successful delivery. Microphone acoustics and cached audio tail failures still require separate live testing.

Restart the API and web dev servers, then establish a fresh voice session to receive the updated constrained credential. Existing provider connections retain their old tool configuration.

## Truthful delivery lifecycle (roadmap package A, October 11)

Implements priority 1 of `VOICE_NEXT_IMPLEMENTATION_ROADMAP.txt` plus the measurement and interruption pieces it depends on.

**One lifecycle per utterance.** `apps/web/lib/utterance-lifecycle.ts` replaces the voice shell's loose booleans with `AUTHORIZED → REQUESTED → FIRST_AUDIO → PLAYING → COMPLETED`, plus terminal `INTERRUPTED`, `FAILED` and `CANCELLED`. COMPLETED requires both an honest source ending (provider `turnComplete` with audio, or a cached stream whose byte count matches `totalBytes`) and local playback draining. Duplicate and late signals are ignored once terminal.

**Deadlines** (`SPEECH_DEADLINES` in `voice-session.ts`): 15 s with no first audio, 3 s grace after an empty provider turn, 5 s mid-stream stall measured only while the playback queue is empty (a spoken pause never empties it), queued audio + 3 s for playback to drain, and 20 s for speech authorized while the provider socket is down. Relayed tool calls have an 8 s deadline and answer `TOOL_TIMEOUT`.

**Honest failures.** A cached tail that errors or arrives short lets the queued prefix finish, then reports FAILED, not COMPLETED. An empty provider turn reports `EMPTY_RESPONSE`. The candidate sees a short notice whenever speech failed or was cut off. Partial playback is never replayed automatically; the notice tells them to ask for a repeat, which goes through the gate.

**Stale audio and tool results.** Model audio carries the utterance id it was requested for, and callbacks check the connection instance. Cancelling, replacing or reconnecting a turn bumps an epoch in `RealtimeVoice`, so late tool results are dropped instead of being sent to the model.

**Readiness and the opening.** `/voice-ready` is retried with backoff (4 attempts) and reports a visible error if it still fails. It now carries `activeUtteranceId`. If the server holds an authorization that the reconnecting client is not playing (for example after a page reload or a lost outcome report), the server closes it as `CANCELLED / CLIENT_LOST_UTTERANCE`. Every outcome is appended to the log as `UTTERANCE_OUTCOME`. If the opening brief ends with no audio played, the runtime sets `openingRedeliveryPending`, which is checkpointed. The gate then re-offers the same reviewed `openingScript` on the next readiness (rule 0b) or the next finished candidate turn (rule 3a), at most twice, under new utterance ids (`utt-opening-r1`, `-r2`). Stage progression is unchanged, so a crashed client still cannot strand a session in oral delivery.

**Interruptions.** Barge-in is now provisional for model speech too: output ducks to 25% and is confirmed only by 400 ms of sustained voice or an explicit word. While the provider is still generating, the `activityStart` boundary is held back, because under manual VAD it would cancel the provider's answer. The candidate's audio is buffered (up to 1.5 s) and sent after the boundary once the interruption is confirmed, or once the interviewer stops. A cough during the brief no longer cancels it. Speech starting before any audio, if confirmed, ends the turn as CANCELLED.

**Ledger.** The latency ledger now opens for every authorized utterance and closes at its terminal outcome. It records `outcome`, `outcomeReason`, underruns, received and played audio, and tool-call time. Failed and interrupted turns are reported instead of dropped. `voiceLatencyReport` adds authorization-to-audible latency by source and outcome counts. End-of-turn response latency still requires a quiet onset, so the opening brief stays out of that distribution.

### Validation and limits

Unit and HTTP tests cover the lifecycle fault matrix, empty provider turns, no-first-audio reconnects, duplicate ACTIONs, held boundaries during coughs, tool timeouts, late tool results, ledger outcomes, opening re-offer (bounded, survives restarts, never after partial playback), and `/voice-ready` reconciliation. No live provider session was run for this change. Thresholds (400 ms confirmation, 5 s stall, 1.5 s buffer) are engineering defaults and need tuning against the live checks above: headphones vs speakers, cough during model and cached speech, explicit "stop", and slow networks. Deferring `activityStart` assumes Gemini Live cancels generation on `activityStart` under manual VAD, which matches the current documented behavior but was not re-verified live. `VoiceSession.diagnostics` holds structured fault records but is not yet attached to the in-page support report.
