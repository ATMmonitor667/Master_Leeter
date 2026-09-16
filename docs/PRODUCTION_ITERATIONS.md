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

Browser processing-record checkpoint (2026-09-14): input references now commit
with browser events; completion markers commit with fenced runtime checkpoints.
Unresolved input discovery is durable and bounded. Automatic reconciliation and
owner-routed dispatch remain open. Ownership was recovered from the saved stash
and committed as befbc94 in an isolated production worktree.

Runtime ownership checkpoint (2026-09-14): private expiring ownership tokens now
fence runtime events, checkpoints, candidate-channel writes and stage transitions.
The injected bundle renews ownership and rejects non-owner commands explicitly;
takeover discards stale local runtime state. 733 API tests and workspace typecheck
pass; 15 real database tests remain pending. Durable command routing, connection
deadlines and startup activation still remain, so I02 is not yet complete.

2026-09-14 checkpoint: complete repository composition is available for explicit
integration injection, with schema/privilege readiness and pool cleanup. Injected
report stores recover queued/expired jobs in bounded background batches without
browser polling. Workspace typecheck and 729 API tests pass; 14 database tests
remain unexecuted locally. Production startup activation, fenced runtime ownership,
command routing and durable deadlines remain open. See NEXT_IMPLEMENTATION_PLAN.txt.

I02b.2 adds the pg driver, verified remote TLS configuration, an opt-in real
PostgreSQL test harness and a dedicated PostgreSQL 16 CI job. Local API result:
698 passed, six database tests skipped without a configured server; typecheck
passes. Explicit test:database fails if its URL is missing. No CI run or Supabase
deployment is claimed. See docs/DATABASE_TESTING.md and NEXT_IMPLEMENTATION_PLAN.txt.

I02b.1 repository foundation: PgSessionStore, migration 002_session_storage.sql,
and transaction-scoped parent locking in PgEventLog. All 689 API tests and
workspace typecheck pass; nine new tests verify adapter protocol using mocks.
Migration, PostgreSQL concurrency and RLS have NOT run against a real database.
The API still uses in-memory stores; this does not enable durable interviews.
See NEXT_IMPLEMENTATION_PLAN.txt at the repository root for full recovery,
integration, owner prerequisites and remaining product work.

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

Implementation checkpoint (branch `codex-production-03-preparation`):

- Added authenticated pasted-resume preparation routes, explicit consent,
  evidence-linked extraction, candidate fact confirmation, source erasure and
  account/session deletion coverage.
- Added a private Supabase migration and durable preparation repository with
  immutable question/session pins and leases that deduplicate model work across
  retries and API replicas.
- Added safe Gemini analysis and scenario restatement adapters. Restatements
  retain contract evidence, reject private-content matches, and persist the
  model/prompt/fallback reason; failures use the canonical reviewed wording.
- Added Extra nice, Normal and Mean voice personas as presentation-only settings,
  a bounded resume discussion prompt, and a fixed 2700-second session budget.
- Added the browser preparation/review/erase/start flow. Typechecks pass; tests
  were intentionally deferred to the separately assigned test pass. Live
  Supabase migration, model fixtures and conversational review remain acceptance
  gates before I03 can be marked complete.

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

Implementation checkpoint (branch `codex-production-04-live-experience`):

- Added the minimal codepad/notes interview surface, acknowledged revision saves,
  atomic final-cursor sealing, late-write rejection and server-owned deadline and
  abandoned-tab completion.
- Added provider-authoritative interim/final candidate transcription, playback
  drain before interviewer completion, explicit manual-VAD turn closure, and a
  bounded final transcript drain before completion seals evidence.
- Added fresh-token reconnect and proactive GoAway rotation with constrained
  session resumption and sliding-window context compression. Resumption handles
  are held server-side per interview and cleared when a session ends.
- Added microphone permission/input-level preflight, speaker check, live input and
  output selection, device-change detection and in-place microphone/default-output
  recovery without resetting the server-owned interview clock.
- Web/API typechecks and production builds pass. Tests remain intentionally
  deferred to the separately assigned test pass. The real 45-minute, hardware,
  Supabase and failure-race procedure in `docs/I04_ACCEPTANCE.md` remains I04's
  exit gate.

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

Implementation checkpoint (branch `codex-production-05-independent-graders`):

- Added two structurally separate Gemini calls. The solution grader receives the
  sealed final code, contract, private reference evidence and reported runs but no
  transcript. The transcript grader receives attributed candidate turns and only
  disclosed question context, with no code, run result or solution-grade output.
- Both produce bounded 0–100 model estimates, confidence, rubric dimensions,
  actionable feedback and event-sequence citations. Transcript quotes must match
  the cited candidate turn exactly; solution citations can resolve only to the
  sealed code or reported-run events. Missing code/transcript is insufficient
  evidence and never an invented zero.
- Migration 011 adds fenced per-grader progress. A successful first grader is
  stored under the report lease; provider failure retries only the missing half,
  with three bounded attempts and a lease long enough for both model timeouts.
  Failed durable jobs become claimable after exponential backoff, including
  after an API restart; report polling exposes this state as retrying.
- The candidate report shows the two grades separately and explicitly refuses to
  combine them. The deterministic 1–4 behavior index remains as an auditable
  event-derived signal and no longer describes predicted run results as execution.
- API/web typechecks pass. Tests remain assigned to the separate test pass.
  Development migration, live Gemini runs, adversarial calibration fixtures and
  human reviewer calibration remain I05 acceptance gates.

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

Implementation checkpoint (branch `codex-production-06-launch-hardening`):

- Added a Node 22 multi-stage API image that runs as a non-root user, resolves
  compiled shared contracts and includes scenario/parser assets. The API now has
  an explicit compiled production start command and honors host `PORT`.
- Added typed production admission config. Hosted API boot rejects memory/auth,
  file-question, insecure-origin, missing voice/classifier/evaluator and invalid
  Supabase/database fallbacks before listening, while local development remains
  explicit and supported.
- Split liveness/readiness, added live storage readiness, safe release identity,
  request support IDs, redacted production errors and a bounded SIGTERM drain
  that refuses new interviews before closing sockets and durable stores.
- Centralized browser HTTP/WS endpoints. Hosted Vercel builds reject localhost,
  insecure origins, missing Supabase auth or secret browser keys and emit CSP,
  microphone, framing, MIME, referrer, HSTS and private-page cache headers.
- Migration 012 and the durable admission path serialize new-session decisions
  across replicas. They enforce one active interview per account, a global
  active cap, monthly account allowance and an operator kill switch before the
  session/start event commit. Account create/preparation/voice/run bursts use
  atomic Supabase rate buckets; voice credentials retain a session-lifetime cap.
- Added shared voice/grader provider breakers with single-probe recovery, safe
  `/health/status` capability state, request support IDs, redacted failure logs,
  throttled recovery errors and an exhausted-report alert signal. The operations
  runbook names the host alerts that still require staging configuration/drills.
- Added a CI artifact gate that builds and boots the exact Linux API image,
  verifies its non-root runtime, health endpoints, packaged scenario catalogue
  and Docker-stop shutdown. The image now supplies its own readiness health
  check and includes the contracts package runtime dependency links.
- Added a Render staging blueprint with manual deployment, owner-supplied
  secrets and admission disabled until migration 012 and hosted acceptance pass.
  Render commit identity feeds the API's safe release status automatically.
- Automatic question selection now reads account history from either session
  store and prefers an unseen question family. Explicit choices are preserved,
  deleted-session history is not retained for rotation, and reuse resumes only
  after every active family has been assigned.
- Added bounded HTTPS delivery for a closed redacted alert schema. Final report
  failure, report-recovery outages and realtime circuit openings carry safe
  release/incident fields; redirect refusal, retry limits and shutdown draining
  prevent silent loss or secret forwarding. Hosted paging drills remain open.
- Root production build and API/web/contracts typechecks pass. The compiled API
  started locally, exposed five scenarios and passed live/ready smoke requests.
  The Docker daemon was unavailable, so migration 012 execution, a successful
  CI image run, hosted signal/socket, configured-cap concurrency and cloud
  readiness checks remain external acceptance.

## Handoff after every iteration

Update checklist, run scoped tests and affected regressions, record unverified
external checks, commit only intended changes, give owner branch/commit and
required actions, then pause for their review/merge. Deployment is a separate step.
