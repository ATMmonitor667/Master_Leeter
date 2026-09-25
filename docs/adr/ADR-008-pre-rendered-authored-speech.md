# ADR-008: Pre-render authorized authored speech

Status: Implemented on `voice/low-latency`; live fidelity and latency acceptance pending.

The interviewer may speak only after the Response Gate authorizes an action. The wording for a probe, fact, hint, follow-up, or brief comes from the session's pinned scenario version. Rendering that finite vocabulary before it is needed removes the realtime model's tool round trip and audio generation from the speaking path.

The server renders Gemini TTS audio using the configured realtime voice and session tone. It trims silence and transcribes the render back to text. A word-sequence mismatch is rejected and uses the existing realtime model path. The cache key includes renderer identity, tone, and a hash of exact wording. Cache entries are held in process memory; a replacement server may need to render them again.

An authorized ACTION carries only a base64 PCM head, sample rate, and optional tail offset. The client schedules the head in the message handler, then fetches the remaining bytes through an owner-scoped endpoint that checks the active utterance authorization. No authored text crosses to the browser as text. A tail failure after playback begins ends the line early; it never restarts the sentence through the model. Barge-in aborts the fetch and cancels scheduled audio.

`TTS_PRERENDER=off` restores model speech. `TTS_VERIFY=off` is accepted only in local development. The tradeoff is prewarming cost and an in-memory cache miss after ownership moves. TTS word fidelity, voice consistency, and decision-to-audio latency have not yet been verified in recorded human sessions.
