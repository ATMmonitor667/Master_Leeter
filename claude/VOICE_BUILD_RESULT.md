# Voice build result (code checkpoint)

Branch: `voice/low-latency` from `main` `ec8407a`.

Implemented: latency ledger and review, turn integrity, verified pre-rendered authored speech, synchronous cached audio head and streamed tail, prosodic turn-end windows, bounded speculative classification, configurable VAD hangover, room tone, and provisional cached-speech barge-in. The Response Gate remains the only speech authority. Cached audio is attached only to an authorized ACTION; authored text is not sent to the browser as text.

The 2026-09-25 six-utterance TTS probe found 7–22 final transcript chunks per segment. Last-final delay after activityEnd was p50/p95 140/220 ms at 350 ms hangover and 118/175 ms at 500 ms. Including the hangover, 350 ms was faster from quiet onset. Word accuracy did not improve at 500 ms, so the 350 ms default remains.

Automated checks on this checkpoint: workspace typecheck; existing API and web suites; existing evaluation thresholds; production build; environment, bundle and sorted-file scans. The owner requested no new test files, so new targeted regression and timed simulation cases remain for the separate testing pass.

Open before release: three recorded human sessions (normal headset, noisy laptop, and alternate tone), review of latency p50/p95 alongside interruption and missed-response rates, cached TTS fidelity listening, five backchannel attempts, and tuning/go-no-go. Optional persistent render storage for multi-instance deployments is not enabled. Current in-process cache falls back to realtime speech after a miss. The six-utterance probe is synthetic and does not establish human performance.
