# Implementation Roadmap

Sized for **2–3 engineers**. Sequence is an engineering order, not a calendar commitment;
week markers are for relative sizing only.

Sizes: **S** ≤ 2 days · **M** 3–5 days · **L** 1.5–2 weeks.

---

## Parallelization lanes

Three lanes that can run concurrently once the shared contracts land in M0.

| Lane | Owns | Roughly |
|---|---|---|
| **A — Interview Brain** | Orchestrator, state machine, Response Gate, scenario engine, candidate observer, policy | Engineer 1 |
| **B — Workspace & Runtime** | Next.js client, Monaco, WS gateway, code event pipeline, Judge0 runner, reconnect | Engineer 2 |
| **C — Voice & Evidence** | Realtime voice agent, tool surface, event log, evaluator, reports, eval harness | Engineer 3 (or split A/B on a 2-person team) |

**The seam between lanes is two artifacts.** Land them first, freeze them early, change them
only by explicit agreement:

1. `SessionEvent` schema — every event type, payload shape, actor, ordering rules
2. `InterviewAction` enum + `InterviewContext` shape — what the gate consumes and emits

With those fixed, Lane A can develop against a fake client, Lane B against a fake
orchestrator, and Lane C against recorded event streams. Nobody blocks on anybody.

**On a 2-person team:** run A and B, fold Lane C's voice work into A (it's adjacent to the
gate) and Lane C's evaluator work into B (it's adjacent to the event log). Expect M3 and M6
to serialize.

---

## M0 — De-risk and lay the seam · ~1 week · all hands

The purpose of this milestone is to find out early whether the architecture's core assumption
is false. Nothing else starts until the spikes report back.

| ID | Task | Size | Lane | Blocks |
|---|---|---|---|---|
| M0-1 | **Realtime turn-detection spike.** Prove VAD can emit speech events with automatic response creation disabled, and that the app can create a response on demand. Measure end-of-turn → first-audio-byte latency. Write findings to `docs/adr/ADR-001-response-control.md`. | S | C | everything in M3/M4 |
| M0-2 | **Judge0 spike.** Stand up self-hosted or managed Judge0. Verify network disabled, memory/CPU/PID limits enforced, timeout returns deterministic result. Fork-bomb and OOM it deliberately. | S | B | M2-4 |
| M0-3 | **Define `SessionEvent` + `InterviewAction` contracts** as shared TypeScript types in a `packages/contracts` workspace. Include seq/idempotency/trace-ID rules. | S | A | all lanes |
| M0-4 | Repo skeleton: pnpm monorepo, Next.js app, Fastify backend with Session/Orchestrator/Scenario/Report module folders, Postgres + Redis via docker-compose, CI running typecheck + tests. | M | B | all |
| M0-5 | Author **scenario #1** by hand as a raw document — oral brief, facts with disclosure levels, 3 probes, 4-level hint ladder, one follow-up, hidden tests. Time it honestly; the number sets content strategy. | M | A | M1-1 |

**Exit:** M0-1 confirms application-controlled response creation is achievable, or the
architecture gets revised before code depends on it. Contracts are frozen. Scenario authoring
cost is a known number.

> If M0-1 fails, stop and redesign. Every downstream milestone assumes it.

---

## M1 — Deterministic core, no voice, no UI · ~2 weeks · Lane A

The interviewer's judgment, testable in milliseconds, thousands of times.

| ID | Task | Size | Deps |
|---|---|---|---|
| M1-1 | **Scenario schema + loader.** Zod-validated YAML/JSON, content-hash versioning, `status` lifecycle (draft/review/active/retired), provenance block. Scenarios live in `content/scenarios/`, reviewed by PR. | M | M0-3, M0-5 |
| M1-2 | **Interview state machine.** States, transitions, per-state allowed action sets, forbidden-transition errors. Pure function over `(state, event) → (state, allowedActions)`. | M | M0-3 |
| M1-3 | **Response Gate v1 — rules only.** Implement `decideAction(ctx)` exactly as specified: speaking+barge-in → silent; unfinalized turn → silent; low end-probability → silent; explicit question → answer or acknowledge; hint request → next allowed level; eligible probe + policy allows → probe; stall over threshold → L1; else silent. Intent arrives as an injected score, stubbed for now. | M | M1-2 |
| M1-4 | **Clarification map + fact disclosure.** `getClarificationFact(key, state)` honoring `ALWAYS \| IF_ASKED \| AFTER_PROBE`, returning `NOT_ANSWERABLE` rather than improvising. | S | M1-1 |
| M1-5 | **Probe eligibility + hint budget.** Trigger matching against `CandidateState`, `maxUses` enforcement, hint ladder accounting with score impact recorded. | M | M1-1, M1-3 |
| M1-6 | **Candidate-bot simulator.** Deterministic fixtures emitting scripted transcript + code event streams. Ship the six trajectories named in `CLAUDE.md` (long-thinker, rapid clarifications, prompt injection, wrong complexity over correct code, correct reasoning with buggy code, instant solve). | L | M1-3 |
| M1-7 | **Interview policy config.** Mock and Learning as data: hint levels available, stall thresholds, probe cadence, acknowledgement frequency. | S | M1-3 |

**Exit:** a scripted candidate event stream produces deterministic, appropriate actions.
Silence is the default and it's provable in CI. `pnpm sim` runs the whole suite in seconds.

---

## M2 — Workspace and execution · ~2 weeks · Lane B (parallel with M1)

| ID | Task | Size | Deps |
|---|---|---|---|
| M2-1 | **Session lifecycle API.** `POST /v1/interview-sessions`, `/end`, session record pinning scenario version + policy. Idempotency keys throughout. | M | M0-4 |
| M2-2 | **App WebSocket channel.** `WS /v1/interview-sessions/{id}/events` — auth, session lease in Redis, monotonic seq, duplicate-safe on reconnect, trace ID propagation. | M | M0-3, M2-1 |
| M2-3 | **Candidate workspace UI.** Monaco (Python), notepad with no AI autocomplete, timer, custom test input, stdout/stderr panel, interviewer status indicator (Listening/Waiting/Speaking). **No problem text anywhere in the DOM.** | L | M0-4 |
| M2-4 | **Runner service.** Queue-backed: enqueue → Judge0 → normalized result event appended → pushed to client → observer notified. Async from the API thread; a runaway run must never pin the session. | M | M0-2, M2-2 |
| M2-5 | **Code event pipeline.** Client-side debounced diffing with monotonic revision numbers; server-side Tree-sitter semantic snapshot (functions, data structures, loops, recursion, changed regions). Also emits **note activity** events (debounced, content + timestamp) — notes are session evidence and a stall signal, though not graded unless rubric-relevant. | M | M2-2 |
| M2-6 | **Milestone detection.** Derive `FIRST_COMPILES`, `BASE_TESTS_PASS`, `REPEATED_SAME_FAILURE`, `LARGE_REWRITE` from the run + delta streams. (`COMPLEXITY_CLAIM_MISMATCH` needs the observer — lands in M5.) | M | M2-4, M2-5 |
| M2-7 | **Session event log.** Append-only Postgres table, strictly increasing seq per session, evidence hashes, replay reader. | M | M0-3, M2-1 |
| M2-8 | **Auth.** Hosted provider (email/OAuth), short-lived session tokens, separate author/admin role. Small, but every endpoint above assumes it exists. | S | M0-4 |
| M2-9 | **Replay determinism test.** Feed a recorded event stream + pinned scenario version back through the orchestrator; assert identical deterministic gate decisions. Runs in CI. | S | M2-7, M1-3 |

**Exit:** a candidate can write and run Python against a scenario's tests, every action lands
in the event log in order, and the log replays cleanly.

---

## M3 — Voice and oral delivery · ~2 weeks · Lane C

First point where the two halves meet. Integration milestone — budget slack.

| ID | Task | Size | Deps |
|---|---|---|---|
| M3-1 | **Ephemeral realtime credentials.** `POST /realtime-token`, short-lived, server-minted. Provider key never reaches the browser. | S | M2-1 |
| M3-2 | **WebRTC voice connection** in the client, with mute, barge-in (stop output audio and listen), and device selection. | M | M3-1, M2-3 |
| M3-3 | **Voice agent tool surface.** Exactly five tools: `get_interview_context`, `get_clarification_fact`, `get_probe_wording`, `get_follow_up`, `record_delivery`. Backend validates current state + action permission before executing any of them. | M | M1-2, M1-4 |
| M3-4 | **Oral brief delivery.** Deliver authored `openingScript`, support repeat via reviewed `repeatVariants`, bounded paraphrase that preserves canonical facts. | M | M3-3, M1-1 |
| M3-5 | **Wire orchestrator → response creation.** Manual response creation only; the gate's authorized action is what triggers speech. Never automatic. | M | M0-1, M1-3, M3-2 |
| M3-6 | **Realtime persona prompt.** Neutral interviewer: brevity, speech style, allowed tools, prohibition on unsolicited teaching, obedience to orchestrator actions. | S | M3-3 |
| M3-7 | **Prompt-injection containment test.** Candidate speech is data. Run the injection fixtures from M1-6 against the live voice path. | S | M3-5 |

**Exit:** a candidate completes one oral-only problem end to end, by voice, with barge-in
working and no problem text rendered.

---

## M4 — Silence quality · ~1.5 weeks · Lanes A + C

The milestone that decides whether the product is real.

| ID | Task | Size | Deps |
|---|---|---|---|
| M4-1 | **Semantic intent classifier.** `THINK_ALOUD`, `EXPLICIT_QUESTION`, `CLARIFICATION_REQUEST`, `HINT_REQUEST`, `COMPLEXITY_CLAIM`, `APPROACH_COMMITMENT`, `TEST_PLAN`, `CONFUSION`, `DONE_SIGNAL`, `SOCIAL_SMALL_TALK`. Returns probabilities; the deterministic gate decides consequences. Cache obvious cases. | M | M1-3 |
| M4-2 | **Turn-completion confidence.** Semantic end-of-turn probability feeding `END_THRESHOLD`. A 1.5s mid-explanation pause must not read as turn end. | M | M4-1 |
| M4-3 | **Activity-aware policy.** Code activity in last N seconds, stall duration, `stuckScore` — all feeding gate inputs. | M | M2-5, M1-3 |
| M4-4 | **Interruption eval harness.** Automated scoring of unwanted-interruption rate and missed-response rate over the bot suite, reported per commit. | M | M1-6, M4-1 |
| M4-4b | **Leakage + factuality eval sets.** Automated checks that every clarification answer matches a canonical fact, and that no probe or hint exceeds the mode's permitted disclosure level. Fails the build on regression. | M | M1-4, M1-5 |
| M4-5 | **Human review round.** ≥ 20 real sessions, experienced engineers rating interruption appropriateness and probe relevance. Tune thresholds against the results, not intuition. | M | M4-4, M3-* |

**Exit:** unwanted interruption rate under the threshold, human-reviewed. If it isn't, this
milestone repeats — do not proceed to breadth.

---

## M5 — Code-aware interviewer · ~1.5 weeks · Lane A

| ID | Task | Size | Deps |
|---|---|---|---|
| M5-1 | **Candidate Observer.** Maintain `CandidateState` from transcript + code events. Async between turns, never on the critical path. | L | M4-1, M2-5 |
| M5-2 | **`COMPLEXITY_CLAIM_MISMATCH`** — compare claimed complexity against the semantic snapshot and solution families. | M | M5-1 |
| M5-3 | **Code-state freshness guard.** Every interviewer response carries the revision ID it was grounded in; refuse or refresh if stale. Emit the freshness metric. | S | M5-1, M3-3 |
| M5-4 | **Probe planner.** Deterministic eligibility filter plus a reasoning reranker over eligible authored probes. | M | M1-5, M5-1 |
| M5-5 | **Follow-up branch selection** from candidate approach + performance; `PRESENT_FOLLOW_UP` wired through the gate. | M | M5-4, M3-3 |

**Exit:** the interviewer asks evidence-relevant probes and never comments on stale code.

---

## M6 — Evidence-backed reports · ~1.5 weeks · Lane C

| ID | Task | Size | Deps |
|---|---|---|---|
| M6-1 | **Rubric definition** as versioned config — 7 dimensions with starting weights (15/25/25/10/10/10/5). | S | — |
| M6-2 | **Evaluator pipeline.** Queue consumer over the immutable event log. Structured output: dimension score + confidence + 2–4 evidence moments each. Cannot block or touch the live session. | L | M2-7, M6-1 |
| M6-3 | **Report UI.** Scores, evidence clips, probe intents, hint usage and strength, missed opportunities, code timeline, three targeted drills. | M | M6-2 |
| M6-4 | **`GET /report` with job status** — in-progress, ready, failed-and-retryable. Regenerable from events after rubric changes. | S | M6-2 |
| M6-5 | **Calibration gold set.** Synthetic + consenting human sessions graded by multiple experienced interviewers. Measure weighted per-dimension agreement and rerun stability. | L | M6-2 |

**Exit:** two human reviewers can independently audit why each score was assigned.

---

## M7 — Hardening · ~1 week · all hands

| ID | Task | Size |
|---|---|---|
| M7-1 | **Reconnect and failure paths.** Voice disconnect pauses timer after grace, browser refresh restores editor revision + timer + state via session lease and last-acked seq, runner-unavailable keeps the interview alive, delayed transcript prefers silence over guessing. | M |
| M7-2 | **Observability.** OpenTelemetry traces joining audio turns → gate decisions → model calls → code runs → report generation. | M |
| M7-3 | **Privacy controls.** No raw audio by default, session and account deletion propagating to transcripts/derived reports/analytics, consent surface. | M |
| M7-4 | **Scenarios #2–5** authored, reviewed, provenance recorded. | L |
| M7-5 | **Eval dashboard** for the metric table in `CLAUDE.md`, tracked over time. | M |
| M7-6 | **Accessibility pass.** Captions toggle, keyboard operation, volume, repeat-request behavior — without changing core scoring. | M |

---

## Critical path

```
M0-1 (VAD spike) ─► M3-5 ─► M4-2 ─► M4-5 ─► ship decision
M0-3 (contracts) ─► everything
M0-5 (scenario #1) ─► M1-1 ─► M1-3 ─► M1-6 ─► M4-4
```

Everything else has slack. The two things that will actually hurt if they slip are the
turn-detection spike and the contracts.

## Sequencing rules

1. **Never build the next milestone's breadth while the current milestone's quality metric
   is failing.** Especially M4.
2. **Lane A develops against the simulator, not the UI.** If Lane A ever needs the browser to
   test a gate decision, the seam has leaked.
3. **Scenario authoring runs continuously in the background** from M0-5 onward, not as a
   crunch in M7. Content velocity is a separate constraint from code velocity.
4. **The evaluator never touches live session code.** If a change requires it to, the
   separation has broken (ADR-004).
