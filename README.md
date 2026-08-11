# Master_Leeter

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

## Code execution (Judge0)

Judge0 runs candidate code out of process (invariant 6). It is **optional at boot** — without
it the interview runs and only `POST /runs` fails, with a 503 that says why.

Judge0 needs cgroups and `isolate`, so on Windows it must run **inside WSL2**, from a Linux
filesystem path. A Windows path under `/mnt/c` fails in confusing ways.

```bash
# From WSL2. Adopts an existing release folder instead of re-downloading.
JUDGE0_DIR=~/judge0-v1.13.1 bash scripts/judge0-setup.sh
```

The script starts the stack (db and redis first — the workers come up permanently broken if
they race the database) and then runs six abuse cases against it: infinite loop, memory bomb,
fork bomb, network egress, and filesystem read. **The network case is the one that must
fail.** A sandbox nobody has attacked is a sandbox whose behaviour is unknown.

Then point the API at it:

```bash
echo 'JUDGE0_URL=http://localhost:2358' >> apps/api/.env.local
pnpm dev:api 2>&1 | grep -E 'environment loaded|runner|JUDGE0'
```

The boot log must show `runner: "judge0"`. If it shows `runner: "none"` the variable never
reached the process, and execution is silently disabled.
