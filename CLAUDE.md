# Master_Leeter — Live AI Technical Interview Simulator

Browser-based practice for software engineering interviews. The candidate talks to an AI
interviewer the way they would talk to a person (or types, in chat mode), writes code in
an editor the interviewer can see, runs it, and gets a report afterwards.

This file describes the product after the live-interview rebuild (branch `live-interview`,
November 2026). The reasoning for the rebuild is in `LIVE_INTERVIEW_REBUILD_PLAN.txt`, the
visual design in `Master_Leeter_Futuristic_3D_Master_Design.txt`, and the build log in
`REBUILD_PROGRESS.txt`. Files under `plans/` and most of `docs/` describe the earlier
gate-based design and are history, not instructions. `docs/system-design-report.pdf`
also predates the rebuild.

---

## The principle that defines this product

**The realtime model runs the conversation. Nothing sits between the microphone and the
model, and the server makes no decision during a spoken exchange.**

The earlier design routed every reply through a classifier, a Response Gate and tool
calls. That made replies take 2-5 seconds and sometimes never arrive. The owner chose
fluency (decision D1 in the rebuild plan): the provider's own turn detection decides when
the interviewer speaks, and one prompt controls how it behaves. The measured result on
the owner's machine was about 0.5 s from end of speech to first audio.

What this costs, knowingly: speak/silent decisions are no longer deterministic or
replayable, and the interviewer's words are generated, not authored. Do not rebuild a gate,
a classifier or tool calls on the speaking path to win those back without the owner asking.

---

## Invariants

Treat any change touching these as needing explicit review.

1. **Nothing on the speaking path but the provider connection.** No server round trip, no
   tool call, no classifier between the candidate's speech and the model's reply. Context
   reaches the model as pushed text (`[CODE]`, `[RUN]`, cues), never pulled.
2. **The prompt and the API key never reach the browser.** Voice: both are locked inside a
   short-lived, single-use credential minted by the server. Chat: the prompt is the system
   instruction on a server-side call.
3. **Sessions pin an immutable problem.** The reskinned problem is fixed at session
   creation and never re-read or regenerated.
4. **A reskin changes words only.** Types, bounds, example values and tests are copied from
   the source by code, not by the model. Model-written text is validated (V1-V4 in
   `interview/problem.ts`); two failures fall back to the source wording.
5. **The live interviewer never grades.** Evaluation is a separate post-session pipeline
   over the event log. The post-interview review may see the private notes; the live
   interviewer's prompt holds them as one line and is told never to reveal them.
6. **Candidate code never executes in the API process.** Runs are `EXECUTED` in a Judge0
   sandbox or `PREDICTED` by a model, and every result says which, everywhere it is shown.
7. **Candidate speech and pasted problems are data, not policy.** Prompt injection is an
   expected input. This is enforced by the prompt, so it is a strong default, not a guarantee.
8. **The session event log is append-only**, ordered by strictly increasing `seq`, and
   sealed when the session ends. It is the evidence for scoring and for restoring a room.
9. **No audio is stored.** Microphone audio goes from the browser to the voice provider.
   The server receives text transcripts only.
10. **Problems are original or user-supplied.** Bank problems are written in the owner's
    words with provenance. A pasted problem is used for that session only. Never bulk-import
    third-party problem statements; hiding or rewording text is not legal clearance.
11. **Every failure is visible.** If a reply is expected and no audio arrives, the room says
    so and offers Retry. No silent watchdogs.

---

## Architecture at a glance

```
Browser (Next.js + Monaco)
  ├── WebSocket, audio both ways ─► Gemini Live (prompt pinned in the credential)
  └── HTTPS, never on the speaking path
        │
      API (Fastify, one process)
        POST /v1/interview-sessions            create; reskin and pin the problem
        GET  /v1/interview-sessions/:id        room snapshot (restore on refresh)
        POST /v1/interview-sessions/:id/live   mint a voice credential
        POST /v1/interview-sessions/:id/events transcript / code / cue batches
        POST /v1/interview-sessions/:id/chat   one chat turn, streamed (SSE)
        POST /v1/interview-sessions/:id/runs   run code against the problem's tests
        POST /v1/interview-sessions/:id/end    seal the log, queue evaluation
        GET|POST .../review                    post-interview review conversation
        GET  .../report                        evaluator output
        │
      Postgres (sessions, event log, reports) · Judge0 (optional) · Gemini text models
```

**Deployment shape: modular monolith.** Without a usable `DATABASE_URL` the API runs in
memory and says so at startup. Admission limits, privacy/deletion, support diagnostics and
recovery scripts are frozen (decision D4): keep them working, do not extend them as part
of interview work.

---

## Where things live

**API, `apps/api/src/modules/interview/`**
- `prompt.ts` — the interviewer prompt. One text for voice and chat; only the MEDIUM block
  differs. Keep it short and stable: prompt length costs latency on every turn.
- `problem.ts` — the bank loader (`content/problems/*.yaml`), the reskin, validators, paste.
- `live.ts` — credential minting; model, voice and turn detection are fixed server-side.
- `pin.ts` — what a session pins at creation.
- `transcript.ts` — read models over the event log (transcript, latest code, latest run).
- `review.ts` — post-interview review.
- `routes.ts` — all routes above.

Other modules: `runner/` (Judge0 and predicted runners), `report/` (evaluator, evidence),
`session/` (stores, event log), `preparation/` (optional resume analysis), `auth/`,
`privacy/`, `support/`, `admission/`.

**Web, `apps/web/`**
- `lib/live/provider.ts` — the one seam to a realtime voice model.
- `lib/live/gemini-live.ts` — Gemini Live over WebSocket.
- `lib/live/audio-io.ts` — 20 ms capture frames in, gapless 24 kHz playback out.
- `lib/live/live-session.ts` — connects audio, pushes context, uploads transcript,
  reconnects. It makes no decision about whether the interviewer speaks.
- `app/interview/[sessionId]/` — one room for voice and chat.
- `app/start/` — one-screen setup. `app/dashboard/`, `app/history/`, `app/report/`.
- `components/signal/InterviewerSignal.tsx` — the presence orb.
- `components/landing/`, `lib/landing/` — the landing sculpture (three.js, lazy chunk).

**Contracts, `packages/contracts/src/interview.ts`** — problem spec, pinned problem, styles,
live events, chat turn, run report, room snapshot, `cueText`, `codeContext`.

---

## How the interviewer gets context and behaves

- The browser pushes short text items into the live session, each with a respond flag:
  `[CODE rev N]` (silent, capped), `[RUN]` (silent; the supportive style may react), and
  cues `[START]`, `[HINT n]`, `[REPEAT]`, `[DONE]`, `[TIME]`, `[QUIET]` (respond).
- Chat builds the same items on the server, so both formats share one prompt and one log.
- Styles: `SUPPORTIVE` (3 hints), `NEUTRAL` (2), `TOUGH` (1). The style changes the prompt
  and the hint budget, nothing else. Style is not a scoring dimension.
- Quiet while the candidate thinks aloud comes from the model's own addressed-speech
  detection plus the WHEN TO SPEAK block of the prompt. The microphone toggle
  ("Thinking quietly") is the only hard guarantee of silence.

## Gemini Live facts measured on this project (2026-11-14)

- `gemini-3.8-live`, automatic server VAD, `silenceDurationMs` 600: first audio 454-565 ms
  after end of speech (3 turns, synthetic speech; a small sample).
- Client content with `turnComplete: false` injects context without a reply.
- Connections last about 10 minutes. Resumption keeps context, but a second connection
  inside about one minute is refused (close 1011). Reconnects retry with backoff and the
  room shows "Reconnecting".
- Do not lower server silence below 500 ms; it fragments utterances.

---

## Quality metrics (acceptance criteria)

| Metric | Target |
|---|---|
| End of speech → first audio | p50 ≤ 1.2 s, p95 ≤ 2.0 s; `?debug=1` shows it per turn |
| Missing replies | zero turns where a direct question gets no reply |
| False replies | at most 1 per 5 minutes of think-aloud muttering |
| Clarification factuality | answers consistent with the pinned constraints and examples |
| Solution leakage | no algorithm, data structure or code beyond the hint asked for |
| Code freshness | replies about code refer to the latest pushed revision |
| Human grader agreement | report scores vs. independent interviewers |

Only the first has been measured, on a small sample. The others need real sessions.

---

## Conventions

- **TypeScript everywhere**, shared types in `packages/contracts`.
- Mutating requests carry a request or idempotency key; a duplicate yields one turn.
- **Colours come from tokens.** Edit `design/tokens/semantic.json`, run `pnpm tokens`.
  `pnpm check:ui` rejects colour literals in `apps/web/app` and `apps/web/components`.
- **Cards and motion are one shared system.** `apps/web/app/styles/surfaces.css` defines
  `data-card` (spotlight, signal edge, lift; `tilt`, `signal`, `quiet` variants), `data-enter`
  and `data-reveal`; `apps/web/lib/motion.ts` drives the pointer and scroll parts from a lazy
  chunk. Use those attributes instead of styling a new card. None of it is used in the room.
- **three.js is landing-only** and must stay out of the interview bundle.
- Presentation may read interview state; it may never change or delay it. The orb shows
  "Speaking" only while interviewer audio is audible.
- Dashboard numbers come from measured data. Unknown is shown as unknown, never as zero.

## Commands

```
pnpm dev:api          pnpm dev:web          # stop dev:web before building
pnpm typecheck        pnpm test
pnpm problems:verify  # reference solutions against each problem's tests
pnpm live:check       # real provider, no microphone; API must be running on :4000
pnpm --filter @master-leeter/web build
pnpm check:ui         pnpm check:ui-budget  pnpm tokens:check
```

## Testing

- **Unit:** problem validators and paste handling, prompt contents, route behaviour
  (pinning, public snapshot hides private fields, idempotent chat turns, sealed log),
  run-result normalisation, report evidence projection.
- **Live check:** `pnpm live:check` measures time to first audio, that a silent `[CODE]`
  injection stays silent, and that a question about that code is answered.
- **Human sessions:** the only way to judge interruption behaviour, leakage and
  naturalness. Nothing replaces a full spoken interview with a microphone.

---

## Things that look like good ideas and are not

- Putting a classifier, gate or tool call back on the speaking path "just for safety".
- Lowering server silence below 500 ms to buy latency.
- Having the live interviewer produce the score.
- Letting the model rewrite example values, bounds or tests during a reskin.
- Presenting a predicted run as an executed one.
- Scraping or bulk-importing third-party problem statements.
- A growing prompt. Every added paragraph is paid for on every turn.
- Initialising WebGL, or animating anything decorative, inside the interview room.
- A talking avatar, a face, or a live score or confidence meter.
- Fabricated dashboard metrics, streaks or trend lines.

## Legal posture

Bank problems record author, source type and creation notes. Pasted problems stay with
their session. Reports evaluate observable interview behaviour only: no personality,
medical, psychological or protected-class inference. This is practice software, not a
hiring assessment.
