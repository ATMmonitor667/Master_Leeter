# Adaptive Technical Interviewer — feature breakdown

Source: the "AI Interviewer — Adaptive Technical Interview Simulator" product spec
(October 12, 2026). This file splits the spec into features, records what already existed,
what branch `feature/adaptive-interviewer` adds, and what remains, with the reasons.

Status key: **Existing** (already in the product) · **Added** (this branch) ·
**Partial** · **Deferred** · **Conflict** (needs a product decision against `CLAUDE.md`).

## 1. Interviewer behaviour and modes (spec §2–3)

| Feature | Status | Notes |
|---|---|---|
| Strict / Balanced / Guided modes | Existing | `STRICT`, `MOCK`, `LEARNING` policies (`orchestrator/policy.ts`). |
| Mode-specific conduct in text interviews | **Added** | `chat/interviewer.ts` `MODE_STYLE`: Strict never praises or confirms correctness; Guided may ask narrower diagnostic questions; none name the algorithm. |
| No unsolicited hints, no premature solutions | Existing | Hints only on request; hint text comes from the authored ladder. |
| 4-level hint ladder, recorded with score impact | Existing | `hintLadder` (exactly four levels) + `hintBudget`/`maxHintLevel` per mode. Guided reaches L4. |
| L4 "full explanation ends the scored interview" | Partial | L4 is recorded and lowers the score; the full explanation is delivered by the post-interview professor instead of mid-interview. |
| Never reveal the problem identity or tags | **Added** (prompt) / Existing (content) | Scenarios are original, and the interviewer prompt forbids naming known problems or tags. |
| Clarifications from canonical facts only | Existing | `getClarificationFact`; disclosure rules honoured; model can only pick a fact key. |
| Mode C — post-interview professor | **Added** | `chat/professor.ts`, `POST /chat/review`. Debrief: what went well, first misstep, missing observation, "the question to ask yourself", strong solution, reusable framework, what to practise next; then Q&A. Only after the session ends; never scores. |

## 2. Configuration (spec §4)

| Setting | Status | Notes |
|---|---|---|
| Behaviour (Strict/Balanced/Guided) | Existing | Setup page "mode". |
| Communication: text or voice | Existing | Chat format (`feature/text-interview`). Hybrid is deferred. |
| Interview length 30/45/60/90 | **Added** (chat) | `durationMinutes`; server clock enforces it. Voice keeps its tuned default. |
| Base difficulty / level and topics | Existing | Chosen per scenario (level + topics shown, problem hidden). |
| Problem identity hidden by default | Existing | Only level and topics are shown before Start. |
| Interview type (System Design, CP, Quant/HFT) | Deferred | Needs new scenario families and rubrics; content work, not code. |
| Follow-up difficulty, target style, company presets | Deferred | Needs authored metadata per follow-up; presets need non-endorsement review. |
| Languages beyond Python | Deferred | Runner and starter tests are Python-only today. |
| Multi-problem ladder (e.g. four rounds) | Deferred | Needs a session-of-sessions model; each round should still pin its own scenario version. |

## 3. Lifecycle (spec §5, §13)

| Feature | Status | Notes |
|---|---|---|
| Clock starts only when the candidate presses Start | **Added** (chat) | Chat opens on a Ready screen; `POST /chat/start` delivers the problem and starts the clock. |
| Problem preview before the timer | Not built | Deliberately: a free preview gives reading time outside the clock. Easy to add as an opt-in if wanted. |
| Pause / resume | Deferred | `TIMER_PAUSED/RESUMED` events exist; needs mode rules (Strict should not allow it). |
| Phases: clarification → design → coding → testing → follow-up → debrief | Existing (voice) / **Added** display (chat) | Voice has the authoritative state machine. Chat shows the stage derived from its durable turn log. |
| Application-owned timer, persisted code/transcript | Existing | Server clock; append-only event log; refresh restores submitted code and turns. |

## 4. Adaptive follow-up engine (spec §6)

| Feature | Status | Notes |
|---|---|---|
| Authored follow-ups with triggers | Existing | `followUps[]` with `trigger`, `oralDelta`, `expectedAdaptation`, `rubricDelta`. |
| Follow-ups in text interviews | **Added** | Candidate presses "I'm done with this part"; `chat/follow-ups.ts` decides by rule. Requires submitted code **and** a passing run of exactly that code (source hash on `RUN_REQUESTED`), then picks the first authored follow-up whose trigger holds. The model never invents or presents follow-ups. |
| Current requirements panel | **Added** | Presented follow-ups are listed and passed to the interviewer as context. |
| Selection based on the candidate's approach | Partial | Triggers can express it, but chat has no solution-family observer yet, so `solvedOptimally` means "submitted code passed". Wiring the candidate observer into chat is the next step. |
| Extensions that force a redesign vs preserve it | Deferred | Needs an authored `forcesRedesign` flag per follow-up. |

## 5. Evaluation and diagnosis (spec §7–8)

| Feature | Status | Notes |
|---|---|---|
| Rubric scorecard grounded in evidence | Existing (voice) / **Added** (chat) | Chat coding and combined sessions now get a scorecard. `report/chat-evidence.ts` projects chat turns into the evaluator's evidence types for grading only; seq and evidence hash are kept, so citations stay verifiable. |
| Hints, follow-ups and clarifications count toward the score | **Added** (chat) | They arrive in the projection as `HINT_GIVEN`, `FOLLOW_UP_PRESENTED`, `CLARIFICATION_ANSWERED`. |
| Resume answers are not scored | Existing | Resume-only sessions get a transcript, not a score; resume turns are excluded from grading. |
| The spec's exact 100-point weighting | Deferred | The current rubric (`rubric-coding-v1`) has different dimensions; changing weights is a rubric-version decision. |
| Reasoning diagnosis (first wrong step, missing observation) | **Added** (as teaching) | Done by the professor after the session. It is not used for scoring. |
| Recurring weaknesses across sessions / candidate profile | Deferred | Needs a durable per-user profile with consent and deletion rules; nothing exists yet. |

## 6. Practice system (spec §10)

| Feature | Status | Notes |
|---|---|---|
| Daily ladder, CF-equivalent ratings, recalibration | Deferred | Needs a calibrated question bank (difficulty labels from real solve data) and the candidate profile above. A CF estimate has to be labelled as an estimate. |

## 7. Workspace (spec §11–12)

| Feature | Status | Notes |
|---|---|---|
| Conversation + editor + controls | Existing / **Added** | Chat page: Start, Run (model-estimated), Hint, "I'm done with this part", Finish, status panel, scorecard link, professor review. |
| No scores or coaching during the live round | Existing | The scorecard and review appear only after Finish. |
| Successive code revisions | Partial | Every submitted snapshot is preserved; unsubmitted edits are not. |
| Voice "interrupts naturally" | Conflict | `CLAUDE.md` makes silence a system action; voice speaks only through the Response Gate. Kept as is. |

## Conflicts with `CLAUDE.md` that need an owner decision

1. **"Canonical problems, rewritten prompts" / hiding a LeetCode identity.** The legal posture
   requires scenarios to be original or licensed, with provenance. Rewriting known problems so they
   look unfamiliar is still paraphrasing third-party content. The bank stays original.
2. **"The AI prepares a problem and its follow-up tree."** Generating scenarios per session is
   listed as an anti-pattern (leakage, unreproducible evaluation). Scenarios stay pre-authored and
   version-pinned; generation could only feed the authoring/review pipeline.
3. **Natural interruption in voice.** See above; the Response Gate stays authoritative.

## Known limits of this branch

- Not validated against a live Gemini model: reply quality, Strict-mode tone and professor-debrief
  quality are untested beyond schema/contract tests with scripted models.
- No browser pass yet over the Ready screen, follow-up flow and professor review.
- "Run" in chat is a model-estimated run unless a real runner is configured, so a "passing run"
  that unlocks a follow-up is only as trustworthy as the runner behind it.
