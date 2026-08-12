# ADR-001: Application-controlled response creation

**Status:** Accepted (M0-1 spike passed, 2026-08-11)  
**Issue:** M0-1  
**Spike script:** `apps/api/scripts/m0-1-realtime-spike.ts` (`pnpm --filter @master-leeter/api spike:realtime`)

---

## Context

The product's core invariant: **`STAY_SILENT` is a first-class system action**, not a prompt
instruction. Turn detection must not equal permission to speak. The Response Gate decides; the
realtime API executes only when authorized.

M0-1 must prove this is achievable on a live provider before M3/M4 proceed.

---

## Decision

**Adopt application-controlled response creation** as a hard architectural requirement. The
orchestrator (via the Response Gate) is the only component permitted to trigger interviewer
speech. VAD / activity detection may run continuously, but it must not auto-create responses.

**Provider for `simplified` branch:** Gemini Live API (`gemini-2.5-flash-native-audio-latest`).

OpenAI Realtime remains documented in the spike for comparison and as the likely `main` path
when that branch resumes voice work against OpenAI.

---

## Provider comparison (M0-1 spike)

| Capability | OpenAI Realtime (`server_vad`) | Gemini Live (tested) |
|---|---|---|
| Silence-by-default mechanism | `turn_detection.create_response: false` on session | `realtime_input_config.automatic_activity_detection.disabled: true` |
| Turn boundary signals | Server emits `speech_started` / `speech_stopped` | **Client sends** `activity_start` / `activity_end` |
| App-triggered speech | `response.create` after gate authorizes | `client_content` with `turn_complete: true` |
| Unprompted audio in spike | Must be 0 | **0** (verified) |
| Who owns VAD in production | Server (OpenAI) | **Client** (Master_Leeter must build or wrap) |

### Design consequence for M3-2

OpenAI's path gives server-side VAD that fires events **without** answering — the app gets turn
boundaries for free and only speaks when it calls `response.create`.

Gemini has **no equivalent** of "VAD fires but doesn't answer." Disabling automatic activity
detection means **we send `activity_start` / `activity_end` ourselves** — we own voice-activity
detection client-side. That is strictly more control than the invariant demands, but it is real
engineering work M3-2 must plan for: a client-side VAD layer (or a hybrid using Gemini's
automatic detection only for observation while gating `turn_complete` separately — to be
prototyped in M3-2, not assumed here).

---

## M0-1 spike results (2026-08-11)

Run on Windows, native Node 22, `apps/api/.env.local` with Gemini API key.

```
provider:              gemini
model:                 gemini-2.5-flash-native-audio-latest
voice:                 Puck
silence_ok:            true
vad_no_auto_response:  true
manual_response_ok:    true
unprompted_audio:      0
speech_started:        1
speech_stopped:        1
latency_samples:       20
latency_p50_ms:        1044.5
latency_p95_ms:        1638.4
latency_min_ms:        644.4
latency_max_ms:        1958.0
```

**Phases:**

| Phase | Test | Result |
|---|---|---|
| A | Silence only — no activity signals, no model audio | PASS |
| B | Manual `activity_start` + audio + `activity_end` — boundaries sent, no auto audio | PASS |
| C | App `client_content` + `turn_complete: true` × 20 — first audio byte latency | PASS (20/20 samples) |

Individual latencies (ms): 1958, 1236, 1351, 1621, 1638, 1084, 1044, 811, 817, 1242, 1078,
1286, 779, 1457, 867, 644, 805, 1015, 966, 866.

**Verdict:** SPIKE PASSED. Application-controlled silence is achievable on Gemini Live with
manual activity detection. Proceed to M3 with the M3-2 client-VAD caveat above.

---

## Task 0 verification (same session, pre-spike)

Compiled and tested on Windows after three previously uncompiled commits (`0bb6167`, `1ba6103`,
`635aab2`):

```
pnpm typecheck   PASS
pnpm test        PASS  (383/383)
pnpm sim         PASS  (29/29)
pnpm eval        PASS  (all thresholds met)
```

No red output. Runtime wiring, `env.ts`, and M4-4 eval harness compile and test green.

---

## Amendment — M3-1 moves the invariant into the credential (2026-08-11)

The decision above says the orchestrator is the only component permitted to trigger speech.
Until M3-1 that was enforced by a line of client setup code
(`realtime_input_config.automatic_activity_detection.disabled: true`), which meant the
invariant was one refactor away from silently disappearing — and its absence would only
surface as an interviewer talking over people.

Ephemeral tokens accept `liveConnectConstraints`: a model and connect config the resulting
session is locked to, regardless of what the client's own `setup` message asks for. M3-1 pins
`automaticActivityDetection.disabled: true` into every minted credential
(`modules/realtime/token.ts`, `liveConnectConstraints()`).

**Consequence:** a client that forgets the flag, or a tampered client that deliberately omits
it, still cannot obtain a connection that answers on its own. Invariant 1 is now a property of
the credential rather than of the caller. This is strictly stronger than the ADR originally
required, and it is the reason the constraint block is not optional.

### Two facts M3-2 needs and will not find in the M0-1 spike

1. **Ephemeral tokens connect to `BidiGenerateContentConstrained`**, not the
   `BidiGenerateContent` endpoint the spike used with a raw key. The unconstrained endpoint
   rejects a token with an auth error that reads like a bad token, so the obvious next move —
   mint another one — never helps. Build the URL with `realtimeWsUrl()`.
2. **Tokens are single-use** (`uses: 1`) and carry two independent deadlines: `expireTime`
   bounds how long a session may live, `newSessionExpireTime` (60s) bounds the window to open
   one at all. A reconnect mints a fresh credential; it must not reuse the old one.

Verify both against the live API with `pnpm --filter @master-leeter/api verify:token` before
starting M3-2, so that a failure there is known to belong to M3-2.

---

## Consequences

- **M3-1 / M3-5:** Wire Gemini Live WebSocket; mint ephemeral tokens server-side; never expose
  `REALTIME_API_KEY` to the browser. *(M3-1 done — see the amendment above.)*
- **M3-2:** Build client-side VAD (or equivalent activity-boundary layer) for Gemini — cannot
  rely on OpenAI-style server VAD + `create_response: false`.
- **M4-2 / M4-5:** Latency budget: p50 ≈ 1.0 s, p95 ≈ 1.6 s end-of-turn → first audio byte on
  this hardware/network; re-measure on target deployment before setting production SLOs.
- **ADR-001 on `main`:** Re-run spike against OpenAI Realtime if/when that branch selects OpenAI;
  do not assume Gemini numbers transfer.

---

## References

- `CLAUDE.md` — invariant 1 (application-controlled response creation)
- `docs/ISSUES.md` — M0-1 acceptance criteria
- [Gemini Live API — VAD capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [OpenAI Realtime — turn detection](https://platform.openai.com/docs/guides/realtime)
