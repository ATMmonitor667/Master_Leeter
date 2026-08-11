# MVP Scope — the cut line

> ## Rescoped for personal use — 2026-08-11
>
> This document was written for a 2–3 engineer team shipping a product. The project is now
> **a personal tool for one user**, which invalidates a specific class of work: anything whose
> only justification was *other people*.
>
> **Cut:** auth (M2-8), the human review round (M4-5), the calibration gold set (M6-5),
> OpenTelemetry observability (M7-2), the eval dashboard (M7-5), the accessibility pass
> (M7-6), and legal review. ~26 of the ~88 remaining engineering days.
>
> **Explicitly not cut:** the Response Gate, oral-only delivery, the intent classifier, turn
> completion, the automated eval harnesses (M4-4, M4-4b), and the code-aware interviewer.
> These are what make it an interview rather than a chatbot, and they matter *more* when the
> only user is the one whose time is being wasted by a bad interruption.
>
> **What replaces the human quality loop.** M4-5 depended on ≥ 20 sessions rated by multiple
> experienced engineers. With one user that becomes a lightweight self-review: after each of
> your own sessions, log every interviewer utterance you found unwanted, and tune thresholds
> against that list. Weaker evidence than inter-rater agreement, and honest about being so —
> but a log of ten annoying interruptions from real sessions still beats intuition.
>
> **What this changes about the invariants: nothing.** Silence control, no-problem-text,
> canonical clarifications, sandbox isolation, and the append-only log are all load-bearing
> for a single user too. Invariant 10 (no raw audio) and the provenance rules stay — they cost
> nothing and they're what makes the thing reversible if it ever becomes a product.
>
> **Further, on `simplified` only: no sandbox.** Candidate code is not executed; a model
> predicts the result (`ModelJudgeRunner`). Invariant 6 becomes trivially true — nothing runs
> anywhere. The cost is that run results are predictions, so `BASE_TESTS_PASS` and
> `REPEATED_SAME_FAILURE` derive from an opinion, and **evaluator scores are not measurements
> on that branch.** M4-4 is unaffected: it scores the gate, which never touches run results.
> Deliberately a branch-level divergence, not a scope cut — `main` keeps Judge0.
>
> **To reverse this:** the cut items are marked `[-]` in `ISSUES.md` with the condition that
> brings each one back. Nothing in the architecture forecloses them; auth and observability
> are additive, and the grader loops need a corpus that doesn't exist yet either way.

---


**Target:** a candidate completes one 35–45 minute oral-only coding interview, in one
language, and receives an evidence-backed report. Team of 2–3 engineers.

**The thesis being tested:** *"That felt like a person interviewing me."*
Not "the AI can do mock interviews" — that's already validated by the market. Everything in
scope below exists to test interviewer *fidelity*. Everything cut is breadth, and breadth is
what you add after fidelity is proven, because breadth without fidelity is trivially copied.

---

## In scope

| # | Capability | Why it can't be cut |
|---|---|---|
| 1 | Scenario DSL + immutable versioning | Everything downstream pins to a scenario version. Cutting this makes evaluation unreproducible. |
| 2 | Interview state machine with per-state allowed actions | The structural guarantee that the AI can't skip ahead or teach the solution. |
| 3 | Response Gate (rules-first, `STAY_SILENT` default) | This *is* the product. |
| 4 | Offline candidate-bot simulator | The only way to iterate on silence quality without burning voice minutes and human hours. |
| 5 | Oral-only delivery over realtime voice + barge-in | The differentiator. Text delivery is a different product. |
| 6 | Canonical clarification facts with disclosure rules | Without it, two candidates get incompatible problems and scoring is meaningless. |
| 7 | Monaco editor, notepad, timer, run/output panel | Minimum credible workspace. |
| 8 | Debounced code deltas + semantic snapshots + milestones | Probes must be grounded in observed evidence, or they're improvisation. |
| 9 | Judge0-backed execution, no network/credentials | Untrusted code. Non-negotiable, but *bought* not built. |
| 10 | Append-only session event log | Evidence for scoring, replay for debugging, regeneration after rubric changes. |
| 11 | Post-session evaluator, queue-consumed, evidence-cited | The output the user actually keeps. |
| 12 | 5 excellent original scenarios, authored in-repo | Content is the moat; five is enough to test the thesis. |
| 13 | Reconnect handling (browser refresh, voice drop) | A 40-minute session *will* drop. Losing one is unrecoverable UX. |
| 14 | Eval harness for the quality metrics in `CLAUDE.md` | You cannot tune interruption rate you don't measure. |

**Modes:** Mock (default) and Learning. Both are policy config over the same gate — the
marginal cost is a hint budget parameter, so having two proves the policy layer is real.

**Language:** Python only. One runner config, one Tree-sitter grammar, one set of
run-result normalizations.

---

## Cut from v1 — and why

| Cut | Reasoning | When it comes back |
|---|---|---|
| Content authoring / admin UI | Scenarios live as reviewed files in the repo. 2–3 engineers authoring 5 scenarios do not need a CMS. Building one now optimizes a workflow you haven't run yet. | Once a non-engineer needs to author, ~scenario #15 |
| Company packs | Cosmetic differentiation. The value is scenario mix and rubric behavior, both of which need to work first. Also carries trademark review cost. | Post-fidelity, with legal review |
| Behavioral interview module | Reuses the same architecture with a different scenario engine — genuinely additive, genuinely not needed to test the thesis. | After coding round is excellent |
| Strict mode | Third policy config with no new architecture. Pure config once Mock/Learning prove the layer. | Trivially, any time |
| Longitudinal skill model | Needs a corpus of sessions that doesn't exist yet. | After real usage |
| Multi-language support | Each language multiplies runner config, semantic parsing, and result normalization. Linear cost, zero thesis value. | Right after MVP validation |
| Firecracker / custom sandbox | ADR-006. Judge0 buys correctness here; isolation is a solved problem you'd be re-solving. | Scale or enterprise security requirement |
| Kubernetes, Kafka, microservices | Modular monolith with clean module boundaries. Operational complexity you'd pay for daily with no user-visible benefit. | When a module's load profile actually diverges |
| Raw audio retention / recordings | Privacy risk + storage cost. Transcripts are sufficient for scoring. | Opt-in feature, if users request replay |
| Avatar / video interviewer | Cosmetic. Status indicator (Listening/Waiting/Speaking) is enough. | Never, possibly |
| Native captions beyond basic | Accessibility matters, but full caption UX risks re-introducing the reading path. Ship a minimal toggle. | Accessibility pass pre-launch |
| Custom auth | Use a hosted provider. | — |

---

## Explicit non-goals (from the report, restated because they shape design)

- Live assistance during a real employer interview.
- Impersonating or claiming affiliation with a named company.
- Breadth of interview formats before the coding round is excellent.
- Letting the realtime voice model decide on its own when to speak.
- A custom low-level sandbox before product-market fit.

---

## Definition of done for the MVP

Not a feature checklist — a behavior checklist:

1. A candidate completes an oral-only 40-minute session end to end without seeing the problem text.
2. **< 1 material unwanted interruption per 30 minutes**, human-reviewed across ≥ 20 sessions.
3. Zero clarification answers that contradict canonical scenario facts, across the eval suite.
4. Zero solution leakage beyond the mode's permitted hint level, across the leakage eval set.
5. Prompt-injection attempts in the eval suite do not change interviewer policy.
6. No interviewer response references a code revision more than N seconds stale (pick N, measure it).
7. Two human reviewers can independently audit a report and agree on why each score was assigned.
8. The same event stream + pinned versions replays to the same deterministic gate decisions.
9. A browser refresh mid-session restores editor revision, timer, and interview state.

If (2) fails, nothing else matters. It's the metric the product lives or dies on.

---

## The three risks worth front-loading

1. **Conversational timing.** Can a rules-first gate produce human-feeling silence? Unknown
   until tested with real speech. Front-load: offline simulator in week 1, real voice by week 3.
2. **Realtime API turn-detection control.** The whole architecture assumes VAD can emit speech
   events without auto-creating responses. Verify this against the live API before anything
   else is built on top of it. *This is a day-one spike, not a week-six discovery.*
3. **Scenario authoring cost.** If one excellent scenario takes three engineer-days, content
   is the bottleneck, not code. Author scenario #1 early and time it honestly.
