# Master_Leeter

> ### Branch: `simplified` — code is AI-judged, not executed
>
> There is no sandbox on this branch. When the candidate presses Run, a model reads the
> source and **predicts** what it would have done. `main` keeps Judge0.
>
> This exists to close the loop end to end without cgroups, WSL, or Docker — it is a branch
> for answering "is the thing I'm building working at all". It is not a branch for measuring
> anything. Run results, milestones, and evaluator scores are all downstream of a prediction.
>
> Invariant 6 is trivially satisfied: nothing executes anywhere, so there is no sandbox to
> escape. What that buys in safety it gives back in truth.

Voice-first AI technical interview simulator. The candidate hears the problem orally from an
AI interviewer, thinks aloud, writes code, and runs tests. The interviewer observes
continuously and speaks only when authorized — silence is the default action, not a prompt
instruction.

## Docs

| File | What it is |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Project context, invariants, architecture, conventions |
| [`docs/MVP.md`](docs/MVP.md) | What ships in v1, what's cut, and why |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Milestones M0–M7, sized tasks, lanes, critical path |
| [`docs/ISSUES.md`](docs/ISSUES.md) | Full issue backlog with status |
| [`docs/adr/README.md`](docs/adr/README.md) | Architecture decisions |
| [`docs/system-design-report.pdf`](docs/system-design-report.pdf) | Full product & architecture specification |

## Start here

`docs/ISSUES.md`. Two spikes gate everything else: realtime turn-detection control (M0-1)
and sandboxed execution (M0-2).

```bash
pnpm install
pnpm infra:up      # Postgres + Redis
pnpm dev:api       # port 4000
pnpm dev:web       # port 3000
```

## Configuration

`apps/api/src/env.ts` loads, at boot, in descending precedence:

1. real environment variables — always win, so CI and production are never overridden
2. `apps/api/.env.local`, then `.env.local` at the repo root — gitignored, real credentials
3. `apps/api/.env`, then `.env` at the repo root — shared defaults

All files are optional. See [`.env.example`](.env.example) for every variable.

# Master_Leeter

> ### Branch: `simplified` — code is AI-judged, not executed
>
> There is no sandbox on this branch. When the candidate presses Run, a model reads the
> source and **predicts** what it would have done. `main` keeps Judge0.
>
> This exists to close the loop end to end without cgroups, WSL, or Docker — it is a branch
> for answering "is the thing I'm building working at all". It is not a branch for measuring
> anything. Run results, milestones, and evaluator scores are all downstream of a prediction.
>
> Invariant 6 is trivially satisfied: nothing executes anywhere, so there is no sandbox to
> escape. What that buys in safety it gives back in truth.

Voice-first AI technical interview simulator. The candidate hears the problem orally from an
AI interviewer, thinks aloud, writes code, and runs tests. The interviewer observes
continuously and speaks only when authorized — silence is the default action, not a prompt
instruction.

## Docs

| File | What it is |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Project context, invariants, architecture, conventions |
| [`docs/MVP.md`](docs/MVP.md) | What ships in v1, what's cut, and why |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Milestones M0–M7, sized tasks, lanes, critical path |
| [`docs/ISSUES.md`](docs/ISSUES.md) | Full issue backlog with status |
| [`docs/adr/README.md`](docs/adr/README.md) | Architecture decisions |
| [`docs/system-design-report.pdf`](docs/system-design-report.pdf) | Full product & architecture specification |

## Start here

`docs/ISSUES.md`. Two spikes gate everything else: realtime turn-detection control (M0-1)
and sandboxed execution (M0-2).

```bash
pnpm install
pnpm infra:up      # Postgres + Redis
pnpm dev:api       # port 4000
pnpm dev:web       # port 3000
```

## Configuration

`apps/api/src/env.ts` loads, at boot, in descending precedence:

1. real environment variables — always win, so CI and production are never overridden
2. `apps/api/.env.local`, then `.env.local` at the repo root — gitignored, real credentials
3. `apps/api/.env`, then `.env` at the repo root — shared defaults

All files are optional. See [`.env.example`](.env.example) for every variable.

