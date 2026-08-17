# Master_Leeter

**A voice-first AI technical interview simulator.**

Practice coding interviews the way they actually happen: you hear the problem spoken aloud, think out loud, write code, and run tests — while an AI interviewer watches and **speaks only when it has something authorized to say**. Silence is a system action, not a prompt suggestion.

---

## Why this exists

Most mock interview tools are chatbots with a code editor attached. The candidate reads the problem, the model replies whenever it feels helpful, and the experience collapses back into text.

Master_Leeter is built around a different thesis:

| Typical mock interview | Master_Leeter |
|---|---|
| Problem shown as text | Problem delivered **orally only** |
| Model decides when to speak | **Application-controlled** response gate |
| Transcript drives the session | Append-only **event log** drives scoring |
| Live model grades you | Post-session **evaluator** over evidence |

The hard problem is not generating hints — it is knowing when **not** to interrupt.

---

## What works today

On the current `simplified` branch you can:

- Pick from **5 authored scenarios** (hashing, sliding window, two pointers, heaps, system design)
- Work in a **Monaco** Python editor with notes, timer, and test panel
- **Run** code (model-judged on this branch; Judge0 on `main`)
- Use **live captions** for speech-to-text accessibility
- End a session and receive an **evidence-backed report** with a 7-dimension rubric
- Run **751+ automated tests**, a **candidate-bot simulator**, and an **interruption eval harness** in CI

Voice infrastructure is largely built (Gemini Live credentials, client audio stack, response gate) but the full oral interview loop — hear the problem, speak, get authorized replies — is still being wired end to end.

---

## Architecture

Modular monolith: one TypeScript backend, one Next.js client, shared contracts, Postgres event log, Redis session leases.

```mermaid
flowchart LR
  subgraph Browser["Client · Next.js"]
    direction TB
    UI["Editor · Notes · Captions"]
    Voice["Voice · VAD · Live API"]
  end

  subgraph Brain["Interview Brain · Fastify"]
    direction TB
    GW["WebSocket Gateway"]
    ORCH["Orchestrator"]
    GATE["Response Gate"]
    GW --> ORCH --> GATE
  end

  subgraph Services["Domain Services"]
    direction TB
    SCEN["Scenario Engine"]
    OBS["Candidate Observer"]
    EVAL["Post-session Evaluator"]
  end

  subgraph Infra["Infrastructure"]
    direction TB
    PG[("Postgres<br/>Event Log")]
    RD[("Redis<br/>Session Lease")]
  end

  Voice <-->|live audio| GW
  UI <-->|session events| GW
  ORCH --> SCEN
  ORCH --> OBS
  ORCH --> PG
  EVAL --> PG
  GW --> RD

  classDef client fill:#4f46e5,stroke:#3730a3,color:#fff,stroke-width:2px
  classDef brain fill:#0ea5e9,stroke:#0369a1,color:#fff,stroke-width:2px
  classDef gate fill:#e11d48,stroke:#9f1239,color:#fff,stroke-width:3px
  classDef svc fill:#8b5cf6,stroke:#6d28d9,color:#fff,stroke-width:2px
  classDef infra fill:#059669,stroke:#047857,color:#fff,stroke-width:2px

  class UI,Voice client
  class GW,ORCH brain
  class GATE gate
  class SCEN,OBS,EVAL svc
  class PG,RD infra
```

**Four model roles**, each with a conflicting job:

| Role | Job | When |
|---|---|---|
| Realtime voice agent | Speech, oral delivery, short authorized replies | Live session |
| Turn classifier | Intent + turn-end confidence | Every finalized transcript |
| Candidate observer | Structured state from transcript + code | Async between turns |
| Evaluator | Rubric scores with evidence citations | After session ends |

---

## Quick start

### Prerequisites

- **Node.js 20+**
- **pnpm 9+**
- **Docker** (Postgres + Redis)

### 1. Clone and install

```bash
git clone <repo-url>
cd Master_Leeter
pnpm install
```

### 2. Start infrastructure

```bash
pnpm infra:up
```

Starts Postgres (`localhost:5432`) and Redis (`localhost:6379`).

### 3. Configure environment

Copy the example env and add your API keys:

```bash
cp .env.example apps/api/.env.local
```

Minimum for a working coding session:

```env
DATABASE_URL=postgresql://leeter:leeter@localhost:5432/leeter
REDIS_URL=redis://localhost:6379
JUDGE_MODEL=gemini-3.5-flash
REALTIME_API_KEY=...   # Google AI Studio key
```

Optional but recommended for smarter gate decisions:

```env
CLASSIFIER_MODEL=gemini-3.5-flash-lite
EVALUATOR_MODEL=gemini-3.5-flash
```

See [`.env.example`](.env.example) for every variable and what it controls.

### 4. Run the app

In two terminals:

```bash
pnpm dev:api    # http://localhost:4000
pnpm dev:web    # http://localhost:3000 (or 3001 if 3000 is busy)
```

Open the web URL, choose a scenario, and start interviewing.

---

## Branch: `simplified`

> **On this branch, code is AI-judged — not executed.**

When you press **Run**, a model reads your source and *predicts* the outcome. There is no sandbox. This closes the development loop without Docker cgroups or Judge0, but run results and evaluator scores are predictions, not measurements.

| Branch | Code execution | Use case |
|---|---|---|
| `simplified` | Model judge | Fast iteration, full loop testing |
| `main` | Judge0 sandbox | Trustworthy run results |

Invariant 6 (untrusted code isolation) is trivially satisfied here because nothing executes anywhere.

---

## Development

### Commands

| Command | Description |
|---|---|
| `pnpm dev:api` | Start API with hot reload |
| `pnpm dev:web` | Start Next.js dev server |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm test` | Run unit tests (751+) |
| `pnpm sim` | Candidate-bot simulator — gate behavior |
| `pnpm eval` | Interruption + missed-response metrics |
| `pnpm infra:up` / `infra:down` | Docker Compose lifecycle |

### Verify voice credentials (optional)

```bash
pnpm --filter @master-leeter/api verify:token
```

Confirms ephemeral Gemini credentials enforce silence control (ADR-001).

### Repository layout

```
Master_Leeter/
├── apps/
│   ├── api/          Fastify backend — orchestrator, gate, runner, reports
│   └── web/          Next.js client — workspace, voice, session client
├── packages/
│   └── contracts/    Shared Zod schemas — SessionEvent, InterviewAction, etc.
├── content/
│   └── scenarios/    Versioned interview scenarios (YAML)
├── docs/             MVP scope, roadmap, ADRs, system design report
└── scripts/          CI guards, bundle checks
```

---

## Quality and testing

Silence quality is the product metric. The codebase enforces it mechanically:

- **`pnpm sim`** — seven deterministic candidate bots (long thinker, rapid clarifications, prompt injection, complexity mismatch, and more)
- **`pnpm eval`** — unwanted-interruption and missed-response rates; fails CI on regression
- **Replay determinism** — same event stream + pinned scenario version → same gate decisions

Target from the product spec: **fewer than 1 material unwanted interruption per 30-minute mock**, measured against real sessions — not just bots.

---

## Documentation

| Document | Contents |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Invariants, architecture, conventions |
| [`docs/MVP.md`](docs/MVP.md) | Scope, cuts, definition of done |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Milestones M0–M7 |
| [`docs/ISSUES.md`](docs/ISSUES.md) | Issue backlog with status |
| [`docs/adr/`](docs/adr/) | Architecture decision records |
| [`docs/system-design-report.pdf`](docs/system-design-report.pdf) | Full product specification |

---

## Progress snapshot

| Area | Status |
|---|---|
| Response gate + state machine | Done |
| Workspace UI + event log | Done |
| Post-session reports | Done |
| Intent classifier + turn completion | Done (bot-tested) |
| Voice client + credentials | Built, needs real-device acceptance |
| Oral delivery + gate → speech | Implemented, needs full oral-session acceptance |
| Code-aware probes + observer | Implemented on `codex` |

The remaining in-scope engineering has been completed on the `codex` branch.
Real-device microphone acceptance, one full oral session, and interruption
labelling still require a human run; see
[`docs/CODEX-COMPLETION.md`](docs/CODEX-COMPLETION.md) for the exact handoff.

Roughly **~73%** of the engineering backlog and **~88%** of a usable coding mock without voice. The remaining work is the oral interview thesis itself.

---

## Core invariants

These are load-bearing design rules — not suggestions:

1. **Application-controlled responses** — turn detection ≠ permission to speak
2. **No problem text in the DOM** — oral delivery only
3. **Canonical clarifications** — facts from scenario content, never invented
4. **Immutable scenario versions** — sessions pin a version; content is retired, not edited
5. **Live interviewer never grades** — evaluation is a separate post-session pipeline
6. **Untrusted code never runs in the API process** (Judge0 on `main`; model judge on `simplified`)
7. **Append-only event log** — the evidence substrate for scoring and replay

Full list in [`CLAUDE.md`](CLAUDE.md).

---

## Tech stack

- **TypeScript** throughout — shared types via `packages/contracts`
- **Next.js 15** + **React 19** — candidate workspace
- **Fastify 5** — API and WebSocket gateway
- **Postgres** — append-only session event log
- **Redis** — session leases
- **Monaco Editor** — in-browser Python editing
- **Gemini Live** — realtime voice (WebSocket, not WebRTC)
- **Tree-sitter** — semantic code snapshots
- **Vitest** — unit and integration tests
- **pnpm** — monorepo workspace

---

## License

Private project. All rights reserved.
