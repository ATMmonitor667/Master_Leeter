# Production iterations

Updated 2026-09-11. This is the current execution plan, superseding earlier
product/provider proposals in PRODUCTION_PLAN.md and VERCEL_DEPLOYMENT.md.
Their detailed hardening checklists remain useful. The owner handles deployment.
Each iteration gets a feature branch, verification and commit, then pauses for
owner review/merge into `production`. Do not push or merge for the owner.

## Agreed product

- Original LeetCode-style questions, not scraped/copied LeetCode content. Select
  from the private Supabase bank and pin the version at interview preparation.
- AI restates the scenario but preserves inputs, outputs, constraints, examples,
  edge cases and required algorithm: a 1:1 problem match, not a different problem.
- Resume Interview section: input a resume, consent to processing, review the
  extracted facts, and give the interviewer a bounded relevant summary. Initially
  include a short resume discussion within the coding round. A resume-only mode
  can follow feedback. Never invent achievements or assess sensitive traits.
- Exactly 45 minutes excluding setup/preparation; server-owned time and end state.
- Extra nice, Normal and Mean tones. Mean is blunt/demanding but professional,
  never abusive or discriminatory. Tone is separate from hints and grading.
- Focused codepad + side notes with compact voice/timer controls. No Run/Submit
  Code step required. The AI observes live code; consented speech transcription
  is automatic, not an optional display widget required for grading.
- Complete Interview seals final code/transcript. Separate AI calls grade code
  correctness (0-100) and spoken reasoning/communication (0-100), with evidence,
  uncertainty and improvements. AI predictions must not be called executed tests.

## Audit

Existing: Next.js editor/reports, five original versioned scenarios, Fastify
HTTP/WebSocket API, deterministic interview gate, Python observer, Gemini voice/
classifier adapters, predicted runner, reconnect leases and extensive tests.

Missing for production: live identity/ownership acceptance, durable sessions/events/jobs/
reports, reliable live-audio transcript capture, resilient voice lifetime and
server deadlines. Evaluation currently uses a baseline evaluator. Resume analysis,
validated AI rewrites and separate final AI graders are not implemented.

## I01 — Private question bank foundation

Implemented locally on `codex/production-01-question-bank`:

- Supabase migration: immutable versioned content, mutable publication status,
  RLS and explicit grants; no anon/authenticated access to private question data.
- Server-only REST adapter with validated identity/hash/provenance, bounded
  pagination, timeouts, safe key handling and sanitized errors.
- Dry-run-first importer for the five original questions; opt-in idempotent
  inserts, no overwrites or reactivation of retired versions.
- Session creation selects/fetches an ACTIVE question, pins content, and fails
  safely on outage/empty/retired content. User-scoped idempotency supports retries
  even if the bank goes offline after creation.
- Local file fixtures remain usable; production requires a nonempty Supabase
  bank and never silently falls back to files.
- Fixed pre-existing merged syntax and competing runtime stage implementations;
  retained one evidence-based stage driver and its session transition callback.

Local acceptance: 808 tests pass (38 contracts, 662 API, 108 web), typecheck and
production build pass; importer validates five sources without network access.
Cloud migration/grants/import verification is still pending. See
[SUPABASE_QUESTION_BANK.md](SUPABASE_QUESTION_BANK.md). No AI feature or public
readiness claim is implied by completion of this foundation.

## I02 — Identity, ownership and durable sessions

I02a is committed as dc5a1a7 on codex-production-02-auth-storage. Follow-up
hardening makes authentication secure by default in every environment, requires
explicit local bypass flags, logs the selected mode, and adds bounded reconnect
backoff with terminal authentication/session failures. See SUPABASE_AUTH.md.
This checkpoint does not implement durable storage. I02b still needs coordinated
session/event/report persistence, distributed tickets, replay and ownership.
Review CODE_REVIEW_2026-09-12.txt findings against the implementation before
closing them; that review was static and some findings require reproduction.

2026-09-12 hardening checkpoint: also restored push CI for the renamed
codex-production-* branches and removed internal session-creation error text
from responses. Verified 42 targeted API tests, 33 browser transport/client tests,
workspace typecheck and git diff --check. No live Supabase or deployment test
was performed. Review findings about distributed state remain open.

Delivery split: I02a implements email-code sign-in, verified API identity,
HTTP/voice/report ownership, single-use socket tickets, frame session binding,
token refresh, origin checks and private export filtering. See
[SUPABASE_AUTH.md](SUPABASE_AUTH.md). I02b remains open for durable repositories,
atomic lifecycle operations and restart/distributed recovery. This split makes
the access-control change independently reviewable before storage refactoring.

Tasks:

- Managed sign-in and verified JWTs, owner checks on every HTTP/WS/voice/report/
  deletion route, single-use socket tickets and token refresh. Never trust
  x-user-id. Supabase Auth is implemented alongside the existing Supabase bank.
- Migrations/repositories for users, sessions, pinned questions, ordered events,
  code revisions, notes and jobs; unique user/idempotency constraints, atomic
  event sequences and stage changes.
- Durable checkpoints/replay and fenced single-writer session ownership; stale
  socket expiry and safe worker/API restarts.
- Private-data retention/deletion, job cancellation and redacted logging.
- Typed environment validation and fail-closed production configuration.

Acceptance: two accounts cannot access each other's records through any route;
restart preserves code/state/time; concurrent starts dedupe; deletion removes
private content and stops outstanding work. No public rollout yet.

Owner needs: development Supabase project, auth choice/callback URLs, staging and
production separation. Put credentials in ignored env files, never messages.

## I03 — Resume context, equivalent rewrites and interview preparation

Tasks:

- Resume input, consent and deletion controls. Start with pasted text; add
  bounded PDF/DOCX extraction if needed, validate type/size, never execute active
  document content, keep raw files private and short-lived.
- Structured analysis: skills/projects/experience with source evidence and
  candidate-reviewed summary. Treat resume text as data, not instructions; omit
  irrelevant personal details and unsupported claims.
- Prepare session: pin DB version, generate structured restatement, validate
  preserved signature/facts/constraints/examples and adversarial edge cases.
  Never reveal private reference solutions/tests. Invalid/timeout rewrites fall
  back to reviewed canonical framing; persist wording/model/prompt version.
- Store Extra nice / Normal / Mean independently of assistance policy. Natural,
  concise speech and relevant resume follow-ups; no tone-based score penalty.
- Fixed 2700-second budget; preparation excluded from timer; retries must not
  duplicate sessions or expensive model work.

Acceptance: resume claims trace to source; injection fixtures fail; rewrites
preserve the contract and don't leak solutions; all tones pass conversational
review; generation failure has an honest, tested fallback.

Owner needs: Gemini key and account-available model/quotas, resume retention
approval, synthetic or non-sensitive sample resumes. No OpenAI switch is required.

## I04 — Live 45-minute codepad experience

Tasks:

- Simplify UI to codepad + notes, unobtrusive voice/transcript status, clock and
  Complete Interview. Remove dependency on visible Run/Submit. Keyboard access,
  responsive layout, contrast, reduced motion and useful connection/error states.
- Debounced revisions, acknowledged saves and durable notes; interviewer sees
  latest acknowledged code and cannot give stale-code feedback. Never execute
  candidate code inside the API process.
- Capture finalized candidate speech from live audio, stable segment IDs,
  timestamps and speaker attribution; avoid duplicates/interviewer echo.
- Natural pacing, resume follow-ups, interruption support and code-aware probes.
- Server deadline, reconnect/session lifetime rotation, microphone recovery,
  grace policy and automatic completion even if the tab disappears.
- Completion handshake flushes final code/notes/transcript, atomically seals the
  session and rejects or quarantines late writes.

Acceptance: real 45-minute round; refresh/offline/microphone failures preserve
budget/code; final keystroke and spoken answer included; no submit/run required.

Owner needs: supported-browser device tests, consent copy review and confirmation
of acceptable voice spend. A mock provider test is not full voice acceptance.

## I05 — Independent final graders and reports

Tasks:

- Durable idempotent solution/transcript jobs with timeout, retries/backoff,
  partial failure recovery and no duplicate refresh-triggered charges.
- Solution grader receives sealed code, canonical/restated contract and private
  reference evidence. Validate 0-100 correctness, code-revision grounding,
  confidence and actionable feedback. Clearly label model-estimated correctness;
  any later sandbox execution is separate evidence, never fabricated.
- Separate transcript grader receives sealed attributed turns, question context
  and versioned rubric: understanding, approach, complexity, testing/debugging
  and communication. Cite turn IDs; do not grade accent or resume prestige.
- Graders cannot see each other's scores; candidate text/code cannot override
  instructions. Assistance is evidence, tone is not a scoring penalty.
- Display both scores separately, supporting evidence, uncertainty and next
  steps. Missing evidence/provider failure is pending or insufficient evidence,
  not invented scores or zero-by-default.
- Calibration fixtures: correct/incorrect/partial solutions, strong/weak/noisy
  transcripts, contradictory reasoning, assisted answers and prompt injections.
  Version rubrics/prompts and record acceptable grading variation.

Acceptance: retries use identical sealed inputs; valid bounded scores; independent
graders distinguish solution quality from explanation quality; failures recover
after restart; human reviewers confirm evidence and appropriately cautious claims.

Owner needs: grading preferences, review of sample reports, funded inference quota
and spending caps. Do not promise that scores predict hiring outcomes.

## I06 — Launch hardening and release candidate

Tasks:

- Reproducible Linux artifacts, readiness, graceful drain, CI on production/PRs,
  dependency/security checks and deployment smoke tests.
- Per-user quotas, concurrency credits, rate limits, provider breakers and cost
  caps before exposing expensive AI/voice endpoints.
- Redacted error monitoring, support IDs, durable-job alerts, backup/restore and
  deletion/retention verification.
- Accessibility/browser/visual regressions; more reviewed original questions
  across topics/difficulties and per-user repetition avoidance.
- Owner deploys frontend/API/worker/storage; verify origins, authentication,
  socket recovery, full interview completion and grading on the deployment.
- Invite-only pilot, measured cost/quality, load/soak testing, rollback drill and
  operational signoff before public launch.

Acceptance: cloud/provider gates closed, real failure drills pass, no cross-user
access, score quality approved and cost limits verified. Only then describe the
application as production-ready.

## Handoff after every iteration

Update checklist, run scoped tests and affected regressions, record unverified
external checks, commit only intended changes, give owner branch/commit and
required actions, then pause for their review/merge. Deployment is a separate step.
