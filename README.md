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
| [`docs/adr/README.md`](docs/adr/README.md) | Architecture decisions |
| [`docs/system-design-report.pdf`](docs/system-design-report.pdf) | Full product & architecture specification |

## Start here

`docs/ROADMAP.md` → **M0**. Two spikes gate everything else: realtime turn-detection control
(M0-1) and sandboxed execution (M0-2).
