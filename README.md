# Master_Leeter

**A live AI technical interview simulator.**

Practice coding interviews the way they happen: an interviewer presents a problem out
loud, you think aloud and ask questions, you write and run code, and afterwards you get a
report tied to what was said and written. You can also do the whole interview as a chat.

You talk to the interviewer like a person. It is a realtime voice model with one prompt:
it answers when you ask something, stays quiet while you think, can see your code, and
you can interrupt it.

> This branch (`live-interview`) is a rebuild. The earlier design routed every reply
> through an application-controlled gate; it was slow and sometimes silent. The reasons
> and the trade-offs are in [`LIVE_INTERVIEW_REBUILD_PLAN.txt`](LIVE_INTERVIEW_REBUILD_PLAN.txt).
> Files under `plans/` and most of `docs/` describe the earlier design.

---

## What works today

- **Voice interview** in the browser over Gemini Live: spoken brief, clarifications,
  interruption, captions for both speakers, reconnect when the provider rotates the
  connection.
- **Chat interview** with the same interviewer prompt, streamed replies, one composer.
- **One room** for both: editor, problem card (with an oral-only switch), run panel,
  Hint / Repeat / Done buttons, timer.
- **Problems**: a bank of five original problems, each reworded into a new story per
  session, or paste your own problem for one session.
- **Three interviewer styles**: supportive, neutral, tough. **30, 45 or 60 minutes.**
- **Running code** against the problem's tests: executed in a Judge0 sandbox when one is
  reachable, otherwise predicted by a model and labelled as a prediction.
- **After the interview**: an evaluator report with evidence, the transcript, and a review
  conversation that may explain the intended solution.
- **Dashboard and history**, with export and deletion.

### What has and has not been verified

| Check | Result |
|---|---|
| Typecheck, unit tests, web build, UI colour and bundle budgets | Pass |
| Reference solutions against every bank problem's tests (`pnpm problems:verify`) | 5 of 5 pass |
| Voice path against the real provider, no microphone (`pnpm live:check`) | Pass; first audio about 0.7-0.8 s after a typed cue |
| End of speech to first audio, spoken input | 454-565 ms over 3 turns with synthetic speech (small sample) |
| Chat interview driven through the API end to end | Pass |
| A full spoken interview with a real microphone in the room UI | **Not done** |
| Quiet during long think-aloud, hint leakage, report quality | **Not measured** |
| OpenAI realtime A/B (plan step 5) | **Not done**; needs a paid OpenAI key |
| Judge0 execution | **Not exercised**; runs so far were model predictions |

---

## Architecture

```
Browser (Next.js + Monaco)
  ├── WebSocket, audio both ways ─► Gemini Live (prompt pinned in a server-minted credential)
  └── HTTPS, never on the speaking path
        │
      API (Fastify): create session + pin problem · mint live credential ·
                     accept transcript/code/cue events · streamed chat turn ·
                     run code · end · review · report
        │
      Postgres (sessions, append-only event log, reports) · Judge0 (optional) · Gemini text models
```

The server makes no decision during a spoken exchange. If the API is slow, the
conversation continues and only the transcript upload retries.
[`CLAUDE.md`](CLAUDE.md) has the invariants, the file map and the conventions.

---

## Quick start

Requirements: **Node.js 22+**, **pnpm 9**, and a Google AI Studio API key. Docker is not
needed.

```bash
pnpm install
cp .env.example apps/api/.env.local
```

Minimum `apps/api/.env.local` for a local interview:

```env
NODE_ENV=development
AUTH_MODE=development
ALLOW_INSECURE_DEV=1
WEB_ORIGIN=http://localhost:3000
GEMINI_API_KEY=...          # one key serves voice and text
LIVE_MODEL=gemini-3.8-live
LIVE_VOICE=Charon
```

`apps/web/.env.local`:

```env
NEXT_PUBLIC_AUTH_MODE=development
NEXT_PUBLIC_API_URL=http://localhost:4000
```

Then, in two terminals:

```bash
pnpm dev:api    # http://localhost:4000
pnpm dev:web    # http://localhost:3000
```

Open the web URL and press **Enter practice room**. Use Chrome or Edge.

Without a usable `DATABASE_URL` the API keeps sessions in memory and says so at startup;
restarting it loses them. For durable sessions see
[`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md). To execute code instead of
predicting results, run Judge0 and set `JUDGE0_URL`. [`.env.example`](.env.example) lists
every variable.

---

## Commands

| Command | Description |
|---|---|
| `pnpm dev:api` / `pnpm dev:web` | Development servers. Stop `dev:web` before building. |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm test` | Unit tests |
| `pnpm problems:verify` | Run each bank problem's reference solution against its tests (needs Python) |
| `pnpm live:check` | Voice check against the real provider; the API must be running |
| `pnpm --filter @master-leeter/web build` | Production web build |
| `pnpm check:ui` / `pnpm check:ui-budget` | Colour-token guard and bundle budgets (after a build) |
| `pnpm tokens` / `pnpm tokens:check` | Generate and verify design tokens |

Add `?debug=1` to an interview URL to see per-turn voice latency.

## Repository layout

```
apps/api/           Fastify backend
  src/modules/interview/   prompt, problem reskin, live credential, routes
  src/modules/runner/      Judge0 and predicted runners
  src/modules/report/      post-session evaluator
apps/web/           Next.js client
  lib/live/                voice provider seam, Gemini Live adapter, audio, session
  app/interview/           the room (voice and chat)
  app/start, dashboard, history, report
packages/contracts/ Shared Zod schemas and types
content/problems/   The problem bank (YAML, original, with reference solutions)
design/tokens/      Colour and shape tokens (source of truth)
plans/, docs/       Earlier plans and production notes (mostly pre-rebuild)
```

## Adding a problem

Write a spec in `content/problems/` in your own words, with a signature, constraints,
examples, tests, three hints, two follow-ups and a reference solution, then run
`pnpm problems:verify`. Do not copy third-party problem statements.

## Tech stack

TypeScript · Next.js 15 · React 19 · Fastify 5 · Postgres · Monaco · Gemini Live
(WebSocket) · Gemini text models · three.js (landing page only) · Vitest · pnpm

## License

Private project. All rights reserved.
