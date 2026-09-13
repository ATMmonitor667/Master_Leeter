# Master Leeter production plan

Update: [PRODUCTION_ITERATIONS.md](PRODUCTION_ITERATIONS.md) is the execution
authority. It incorporates the owner's later requirements: Supabase with original
questions, resume context, equivalent AI rewrites, three tones, a 45-minute codepad
without required run/submit, and separate final graders. Earlier Clerk/sandbox/
visible-run proposals below are not final provider or product decisions.

Prepared 2026-09-11 from `production` at `b4c25c4`. Status: proposed implementation backlog, not a deployment certification. No infrastructure was provisioned for this plan.

Start with [PRODUCTION_TODO.txt](../PRODUCTION_TODO.txt) for execution order and [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md) for the deployment runbook. The old personal-MVP checklist remains historical; its completed status does not mean this production backlog is complete.

## 1. Launch scope and decisions

Deliver a browser application where a new user can sign in, check their microphone, complete a realistic 35–45 minute Python interview, run code with trustworthy results, receive evidence-based feedback, and revisit or delete their history. A restart, expired credential, or network interruption must have a defined recovery path.

Recommended first release: English, desktop Chrome/Edge, original reviewed questions, invite-only access, and limited free interview credits. Test other browsers and make support limits visible before a session starts. A responsive layout alone does not establish mobile voice support. Keep all three existing modes; explain how assistance affects feedback.

Use the existing Next.js/Fastify modular architecture. Proposed provider choices are defaults for planning, not purchased services:

| Component | Proposed first-release home | Reason / decision gate |
|---|---|---|
| Web, landing pages, account UI | Vercel, `apps/web` | Existing Next.js app and Git previews |
| HTTP + application WebSocket API | Paid Render web service, `apps/api` | Persistent process fits the existing runtime; retain recovery across process replacement |
| Evaluation and run dispatch workers | Render background worker, same release image | Durable work outlives browser requests and API restarts |
| Durable records | Managed PostgreSQL in API region | Users, sessions, events, reports, jobs, usage, deletion requests |
| Coordination | Managed Redis-compatible service with queue-compatible TCP and persistence settings | Leases, delivery notifications, throttles; PostgreSQL remains the durable source |
| Identity | Clerk, separate development and production instances | Proposed managed authentication; API still verifies every request |
| Candidate execution | External sandbox behind existing `CodeRunner` interface | Select after P14 proves isolation and actual output; evaluate Vercel Sandbox and managed Judge0 |
| Speech and classification | Gemini, account-verified model versions | Preserve controlled speech and canonical tools; model availability and quota are acceptance checks |
| Diagnostics | Structured redacted logs + an error/trace service | Follow one session across web, API, workers, provider calls, and runs |

Render documents WebSocket support without a fixed connection-duration cap, but reconnects may reach a different instance. This favors the current API shape; it does not remove the need for shared state. [Render WebSockets](https://render.com/docs/websocket)

Vercel also supports WebSockets in beta with Fluid compute. Hosting the API there is a viable alternative after P09 and P10 externalize state and prove instance changes; see the runbook for its duration constraints. [Vercel WebSockets](https://vercel.com/docs/functions/websockets)

Owner decisions to record at P01: domain, initial region, monthly budget, initial concurrent-session cap, paid versus free beta, identity provider, and sandbox provider after its spike. Suggested starting cap: 10 active interviews, reduced if load tests or provider quotas require it. These are configuration choices, not prerequisites for writing the implementation.

## 2. What the repository actually contains

The September 4 record reports 761 passing tests, a successful build, and browser checks. Those checks were not rerun for this documentation-only planning pass and do not establish hosted reliability.

| Finding from source inspection | Consequence | Tasks |
|---|---|---|
| `apps/api/src/index.ts` creates `InMemorySessionStore`, `InMemoryEventLog`, and an in-memory evaluation queue | Restart loses authoritative sessions/evidence/reports | P07–P10, P17 |
| `modules/session/index.ts` options explicitly reference in-memory classes and keep runtimes, leases, pushers, and run contexts in maps | Database wiring requires interface refactoring and runtime reconstruction, not a constructor-only swap | P07–P10 |
| Session/privacy routes accept `x-user-id` or `anonymous`; report and socket paths need ownership enforcement | Public callers can impersonate users or access session resources | P04–P06 |
| `pg-event-log.ts` assigns sequence with `MAX(seq) + 1` in an insert | Concurrent writers can race; uniqueness rejects one but does not make both appends succeed | P08 |
| `index.ts` selects `ModelJudgeRunner`; `runner/runner.ts` defines interfaces but no live Judge0 adapter is present | “Run” predicts output; actual sandbox adapter and harness are required | P14–P16 |
| Interview page sends `speechFinal()` from `SpeechCaption.onFinal`; Live voice handles audio/tool messages but does not forward input transcription | Optional captions currently carry a core reasoning input | P11 |
| Live client does not handle `GoAway`, resumption handles, or context compression | A 45-minute uninterrupted logical interview is not yet demonstrated | P12 |
| Provider `turnComplete` immediately posts utterance-complete while playback can remain queued | Brief timer/speech state may advance before audible output ends | P11 |
| Stage driver checks low time only on selected candidate events; no durable deadline scheduler is evident | A silent candidate or closed tab can leave sessions active beyond their intended end | P13 |
| `EvaluationQueue` defaults to `BaselineEvaluator`; configured `EVALUATOR_MODEL` is not connected there; `OBSERVER_MODEL` is not evidence of an active model observer | Product copy and quality claims must match the implemented evaluator | P03, P18 |
| Existing deletion helpers redact data, while SQL migration blocks event UPDATE/DELETE | Production deletion needs an intentional schema/privilege design | P19 |
| Browser API/WS URLs fall back to localhost; CORS includes local origins | A frontend deployment can look healthy while calling a user's own machine | P03, P06, P25 |
| API has no production start script; contracts export TS source; API content path is relative to its source/compiled location | A green TypeScript build does not prove a runnable Linux release artifact | P02 |
| CI push trigger names only `main`; package manager declaration/CI pin pnpm 9 while workspace settings include newer pnpm options | `production` needs explicit CI and consistent build tooling | P02, P24 |
| README/backlog still describe old branches and outdated completeness percentages | User onboarding and developer decisions would inherit misleading assumptions | P01, P30 |

## 3. Release gates

| Gate | Who can use it | Required evidence |
|---|---|---|
| G0: protected staging | Owner/test accounts | Runnable Linux artifacts, real storage/auth, private staging, a full hosted vertical slice; no public promotion |
| G1: invite-only beta | 5–10 invited users | P01–P27 complete; all five scenarios run for real; 10 full-length human sessions; cost controls, recovery, deletion, and support work |
| G2: public beta | Self-service signup under capacity limits | G1 plus P28–P31; 20 observed full sessions across at least 10 people; reliability/cost thresholds met; enough content for repeat use |
| G3: paid public service | Paying users | G2 plus P32; payment lifecycle/entitlement tests, refund/support process, operational ownership |

“Complete” on a task means its acceptance evidence is linked to a commit, CI run, staging check, or recorded human test. Tests with fake providers cannot close live-provider acceptance. Baseline gates below are proposed launch targets, not current measurements or contractual SLAs.

## 4. Ordered work packages

### Foundation and access

**P01 — Production specification and decisions.** Owner: product owner + engineer. Depends: none.

- Record deployment topology, initial region/cap/budget, supported browsers, retention proposal, and beta offer.
- Reconcile README/ISSUES with source findings; preserve the historical personal-MVP audit. Add a route/role inventory and a release evidence template.
- Define G0–G3 and select a small original scenario set; avoid advertising broad company coverage or validated hiring predictions.
- Acceptance: one agreed production backlog, provider decision record, and measurable definition of a successful interview.

**P02 — Reproducible production artifacts.** Owner: engineer. Depends: P01.

- Pin a supported Node version and one pnpm version across packageManager, CI, developer instructions, and hosts. Remove or translate version-specific workspace settings that the chosen pnpm does not honor.
- Make contracts resolvable by the compiled API, either via built JS exports or a tested bundle; preserve Next transpilation and browser-safe boundaries.
- Add API/worker start scripts and a multi-stage Linux Docker image using the repository root as context. Include scenario YAML, rubric assets, and required Tree-sitter WASM/native assets. Exclude local env files and test secrets.
- Honor host `PORT` with `API_PORT` for local compatibility, bind `0.0.0.0`, handle SIGTERM, run as non-root, and validate the actual content path after compilation.
- Acceptance: clean Linux build starts the compiled service without `tsx watch`, reports five active scenarios, parses Python, and runs a protected HTTP/WS smoke test.

**P03 — Validated config and readiness.** Owner: engineer. Depends: P02.

- Add a typed environment schema and distinguish production requirements from local test fallbacks. Production refuses in-memory stores, fake execution, missing identity, and missing required voice configuration.
- Centralize browser API/WS configuration and authenticated requests; reject localhost/insecure schemes in production builds.
- Split liveness from readiness. Readiness verifies DB/coordination/config/assets without paying for an AI request on every probe. Cache separate provider capability checks and expose only safe public status.
- Remove unused model-variable claims or wire them explicitly; publish a complete web/API/worker env inventory.
- Acceptance: missing required configuration prevents session admission with a useful operator error; no secrets appear in errors or browser bundles.

**P04 — Authentication and accounts.** Owner: engineer. Depends: P01, P03.

- Implement sign-up, sign-in/out, verified identity, profile/settings, account recovery, and a persistent internal user mapped to provider subject. Add idempotent verified webhooks if used.
- Use short-lived bearer tokens for browser-to-API calls; verify signature, issuer, expiry, appropriate audience, and allowed parties. Use the provider's supported SDK and rotation behavior. Clerk's backend supports explicit authorized-party validation. [Clerk request verification](https://clerk.com/docs/reference/backend/authenticate-request)
- Do not persist raw bearer tokens in localStorage. Refresh authentication during long interviews without losing drafts or emitting duplicate events.
- Acceptance: expired/tampered credentials are rejected; login/logout and mid-interview refresh work on deployed domains.

**P05 — Resource ownership and socket authentication.** Owner: engineer. Depends: P04, P07.

- Enforce owner/admin roles on session read/resume/end, runs, token minting, voice-ready/completion/tool relay, reports/regeneration, review, exports, and deletion. Remove `x-user-id` as a production identity source.
- Browser WebSocket cannot simply add an arbitrary Authorization header. Mint a short-lived, single-use socket ticket over authenticated HTTPS, bound to user, session, origin, and expiry. Redeem atomically; scrub tickets from proxy/application logs. Never use the long-lived auth token as a query string.
- Bind each socket to its authorized session and reject frames naming another session. Revalidate ended/deleted/disabled state during long connections and reject expired speech authorizations.
- Acceptance: Alice cannot read, mutate, listen to, export, or pay for Bob's interview using either HTTP or WS; ticket replay fails and logout/revocation behavior is defined and tested.

**P06 — Exposure and abuse limits.** Owner: engineer. Depends: P03–P05.

- Explicit HTTPS/WSS origin lists per environment; validate WS Origin separately from CORS. Remove production localhost exceptions and avoid allowing every `*.vercel.app` deployment.
- Add per-IP/user/session rate limits, source/transcript/note/frame/body limits, backpressure, output caps, one-active-session admission, and bounded retries. Enforce these at the external API as well as the web edge.
- Harden browser headers with a tested CSP for Monaco workers, AudioWorklet and required provider/auth endpoints; microphone permissions policy, no camera requirement, and no unsafe HTML output rendering.
- Acceptance: oversized/flooded frames and token-mint/run floods cannot exhaust memory or trigger unbounded provider calls; approved web origins work and unapproved origins fail.

### Persistence, orchestration, and recovery

**P07 — Database repositories and migrations.** Owner: engineer. Depends: P02.

- Refactor injected store types to interfaces; add real Postgres repositories and a migration command. Use distinct migration and application roles, TLS, bounded pools, and region-local connections.
- Extend schema for identities, session creation idempotency scoped by user, drafts/revisions, scenario/policy/runtime version pins, deadlines, reports, jobs, usage reservations, consent, and deletion state.
- Acceptance: session/history/draft/report survive an API restart; two users stay isolated; clean install and migration from existing schema both succeed against real PostgreSQL in CI.

**P08 — Transactional events and idempotency.** Owner: engineer. Depends: P07.

- Replace `MAX(seq) + 1` allocation with a transactional per-session counter/row lock (or another proven serialized allocator), retaining unique event and idempotency constraints.
- Atomically commit state transitions with their evidence and durable work/outbox records; acknowledge client events only after commit.
- Make retries return the original result, scope keys correctly, and test identical-key conflicts versus independent concurrent events. Keep personal payload deletion compatible with the P19 design.
- Acceptance: concurrent event writers yield an ordered stream without losing independent appends; crash between commit and dispatch recovers without duplicate grading or stage advancement.

**P09 — Runtime recovery.** Owner: engineer. Depends: P08.

- Persist/rebuild authoritative state: stage, deadlines/pause credits, revisions, run links, hint/probe/follow-up use, delivery state, processed sequence, and observer summaries. Version snapshots and replay committed events after the checkpoint.
- Define at-least-once processing explicitly. Never rerun nondeterministic classification during recovery when a recorded classification exists; never replay previously spoken audio merely because it is in the log.
- Distinguish speech authorization issued, delivery started, audible completion, and interrupted/unknown delivery. Reconcile uncertain delivery after reconnect.
- Acceptance: kill/restart API at each interview phase and restore on another process without losing acknowledged code or repeating the opening/hints; partially delivered speech has a clear recovery action.

**P10 — Session ownership, routing, and durable jobs.** Owner: engineer. Depends: P08, P09.

- Establish one authoritative runtime owner per active session using expiring leases plus fencing tokens. Route HTTP-originated commands and worker completions to that owner; HTTP and WS requests may land on different instances.
- Use a durable outbox/queue for commands and jobs; pub/sub only announces new durable records. Recover missed notifications. Bound per-session mailboxes and clean up idle maps.
- Define multi-tab takeover, heartbeat loss, auth revocation, worker retries/dead letters, and deployment draining. Old/new instances can overlap even if configured replica count is one.
- Acceptance: two-process test sends HTTP to A and WS to B; events/actions arrive once logically; stale lease holder cannot write after takeover; no in-memory map is the only copy of required work.

### Complete the interview experience

**P11 — Reliable speech input and playback completion.** Owner: engineer. Depends: P03, P05, P09.

- Make candidate transcription part of voice startup, independent of the captions display. Prefer provider input transcription if it works with constrained credentials; otherwise select a tested transcription adapter. Avoid two competing transcription sources.
- Preserve turn identifiers, timestamps, interim/final boundaries and deduplication. Transcripts remain untrusted candidate data. Mute stops both capture and transcription; captions-off only hides text.
- Notify server of audible completion when playback drains, not merely when provider generation completes. Correlate utterance IDs and make completion retryable; interruptions do not masquerade as completed brief delivery.
- Add a preflight with permission handling, input meter, speaker test, device selection, browser check and recovery instructions.
- Acceptance: captions OFF still produces finalized turns and correct clarifications; queued brief audio finishes before the timer starts; headphones/speakers/mute/device removal all have tested behavior.

**P12 — Full-length provider sessions.** Owner: engineer + human tester. Depends: P10, P11.

- Implement provider GoAway handling, resumption state, credential renewal, context compression and reconnect backoff. Verify all of these with the actual constrained ephemeral-token configuration, not only an unrestricted API example.
- Google documents limits around 10 minutes per connection and 15 minutes for audio-only sessions without compression; use its resumption and compression mechanisms as supported by the chosen model. [Gemini Live session management](https://ai.google.dev/gemini-api/docs/live-api/session-management)
- Recover the application WS and voice WS independently, then reconcile authorization and playback before resuming. Test token mint caps under normal renewal plus failed retries.
- Keep response creation controlled and tools canonical through reconnection; do not silently enable provider auto-response as a fallback. Confirm actual model availability, quotas, and failure codes for the deployment account.
- Acceptance: 45 minutes of real audio, provider rotation and application reconnect complete without starting a new logical interview, losing confirmed events, or repeating unauthorized speech.

**P13 — Server deadlines and terminal states.** Owner: engineer. Depends: P09, P10, P12.

- Define whether time includes brief, pauses, outages and wrap-up; current plan starts after audible brief and preserves the existing bounded pause-credit policy.
- Persist deadline jobs; enforce low-time/wrap-up/end even when candidate sends no events, stays in implementation, or closes the tab. Recheck wall-clock deadline on every admission/run/token request.
- End/report scheduling is idempotent; stop microphone/provider/runner work at termination. Define abandonment and failed-interview credit recovery.
- Acceptance: a silent candidate expires on the server; reconnect cannot extend the budget indefinitely; end/retry/timeout races create one finalization job and a report or an explicit insufficient-evidence result.

**P14 — Sandbox selection and isolation spike.** Owner: engineer. Depends: P01, P02.

- Evaluate managed Judge0 and Vercel Sandbox against the existing `ResourceLimits` contract, latency, quotas, regional availability and cost. Vercel offers isolated microVMs; actual execution policy still needs verification. [Vercel Sandbox](https://vercel.com/docs/sandbox)
- Choose only after proving network denial, no platform credentials inside candidate processes, independent per-run files, process/CPU/memory/wall/output limits, termination and cleanup. Do not equate an SDK timeout with enforced CPU/PID limits.
- Test fork bomb, infinite loop, memory/output flood, outbound HTTP/DNS, filesystem traversal and concurrent-user leakage. Trusted result comparison stays outside candidate control; never embed provider keys or expected hidden outputs beside submitted code.
- Acceptance: recorded adversarial cases terminate within limits; runner failure is distinct from wrong answer. If an adapter cannot enforce a required invariant, reject it or redesign before admitting public code.

**P15 — Execution adapter and scenario harness.** Owner: engineer. Depends: P14, P08.

- Implement the selected `CodeRunner` adapter and external dispatch path. Remove `ModelJudgeRunner` from production selection; test doubles stay available for offline tests.
- Define a consistent Python submission/I/O contract for each scenario; provide a minimal starter signature if necessary without leaking the full prompt. Verify user custom input, visible cases, hidden cases, type normalization, exceptions and comparison rules.
- Ensure run results reference immutable code revision and scenario version; distinguish user stdout from trusted pass/fail facts. Passing custom input alone cannot establish base-tests-pass.
- Acceptance: reference solutions pass every case for all five scenarios; known wrong solutions fail; malicious stdout cannot forge success and delayed results cannot be attached to the latest revision accidentally.

**P16 — Runner admission and recovery.** Owner: engineer. Depends: P06, P10, P15.

- Queue requests with per-user fairness, one bounded active run per interview, total concurrency cap, bounded waiting, idempotency and cancellation. Persist backend job IDs.
- Handle timeout, unavailable provider, late callback, API/worker crash and completed/deleted session. Close or destroy execution environments after each run.
- Acceptance: repeated clicks/retries do not multiply chargeable runs; queued work recovers after restart, orphaned sandboxes are reclaimed, and runner failures never hang the interview loop.

**P17 — Durable report pipeline.** Owner: engineer. Depends: P10, P13, P16.

- Replace in-memory queue/report maps with durable jobs and stored report versions; use bounded retries/backoff and an operator-visible dead-letter queue.
- Read only finalized, authorized evidence. Persist rubric/evaluator/content versions and hashes; enforce owner reads and restricted regeneration. Do not serialize raw exception text to users.
- Prevent jobs from recreating deleted data; use deletion tombstones and transaction/version checks at commit, not only at enqueue.
- Acceptance: kill the worker halfway through a report; restart produces one accessible report version; failure/retry UI works and deletion wins any race.

**P18 — Feedback quality and model wiring.** Owner: engineer + reviewer. Depends: P11, P15, P17.

- Inventory which observer/evaluator roles actually use models. Keep a clearly labeled deterministic baseline or implement a schema-validated model evaluator with grounded evidence and bounded retries; an env variable alone is not an integration.
- Represent “not observed” separately from failure; assess correctness, reasoning, testing and communication from their own evidence. Disclose assistance and avoid claiming employment suitability or calibrated hiring predictions.
- Review at least ten diverse completed sessions with independent human ratings before public launch; investigate major score disagreements and misleading claims. Store evaluator/model version in reports and compare after changes.
- Acceptance: every scored statement resolves to evidence; hallucinated citations and prompt injection are rejected; incomplete sessions do not receive invented confidence.

### Privacy, product and operations

**P19 — Retention, consent and deletion.** Owner: engineer + product owner. Depends: P07, P17.

- Resolve the SQL append-only/privacy conflict explicitly: proposed design keeps immutable event envelopes and places sensitive content in separately deletable payload storage; use opaque references and integrity metadata that do not enable easy reconstruction of sensitive text.
- Keep raw audio retention off. Persist consent/policy version, explain provider processing, define default code/transcript/report retention, implement automated expiry and user export/delete. Proposed initial retention: 90 days, subject to the owner's policy review.
- Cover derived reports, cached state, queues, exports, provider/session handles and logs. Keep an erasure ledger and replay it after backup restore; document backup expiry and any provider retention outside application control.
- Acceptance: deleting a session/account removes retrievable personal content and prevents regeneration; receipt reflects pending/unreachable systems honestly. Publish reviewed terms/privacy/acceptable-use text reflecting the implementation.

**P20 — User journey and history.** Owner: engineer. Depends: P04, P13, P17.

- Build dashboard/history, onboarding/preflight, catalog, loading/saving indicators, recoverable sessions, quota messages, queued/failed reports, settings and deletion UX.
- Keep editor and drafts usable during provider outages; make refresh navigation and unsaved work explicit. Add a retry path that preserves evidence and credit.
- Keyboard/focus/screen-reader pass for Monaco controls, dialogs, timers, captions and status announcements; reduced motion and contrast checks. Define a future accommodation path if oral-only design cannot meet a user's needs.
- Acceptance: a new invited user can reach a report and revisit it without instructions from the developer; browser back/refresh/re-login do not destroy acknowledged work.

**P21 — Admission, usage and cost controls.** Owner: engineer + product owner. Depends: P05, P10, P12, P16.

- Atomically reserve interview credit and capacity before issuing provider credentials. Meter server-observed sessions, voice, tokens, runs and reports; deduplicate retries and track failed-session credits.
- Audit the direct browser-to-provider trust boundary: client timers and stopping token minting do not necessarily stop an already-open provider session. Prove provider-enforced lifetime/usage limits or route voice through a controlled server relay before claiming hard per-user spending caps. Revocation and capacity reclamation must cover that case.
- Persist global/account caps and a kill switch that stops new admission while handling existing sessions intentionally. Alert at staged budget thresholds and cap retry/regeneration loops.
- Acceptance: simultaneous requests cannot overspend credits, bypass one-active-session limits or keep indefinitely billable sessions alive by modifying the client.

**P22 — Monitoring and support.** Owner: engineer + product owner. Depends: P10, P12, P17, P21.

- Join logs/traces with opaque session/turn/run/job IDs; redact tokens, text, source and tool payloads from routine diagnostics. Define log retention and role-restricted support access.
- Track admissions, healthy voice starts, provider renewals, fallback rate, time-to-audible-response, run/report failures, completion rate, recovery, queue depth and cost.
- Add alerts for failed readiness, stuck jobs, quota exhaustion, session error spikes and budget thresholds; a status/support contact; and an in-session “report a problem” action with consented diagnostic context.
- Acceptance: forced provider/worker failure pages the configured owner; the owner can identify the cause without reading unrelated users' transcripts.

**P23 — Reliability and live acceptance suite.** Owner: engineer + testers. Depends: P05–P22.

- Add real PostgreSQL/coordination CI tests, two-instance ownership tests, sandbox contract tests, and browser end-to-end tests for signup-to-history using deterministic provider fixtures.
- Run separate opt-in live-provider checks using isolated test credentials; record real devices/browser versions and test denied mic, mute, tab sleep, 30-second offline interval, expired auth, provider renewal, deployment replacement, and concurrent end/run.
- Load-test 10 concurrent 45-minute session equivalents initially, including full event volume, report bursts and a restart. Use bounded live audio samples to validate provider capacity and cost; do not accidentally generate unlimited paid load.
- Acceptance: G1 evidence is recorded, with human voice tests distinct from synthetic tests; no unresolved data-access, data-loss, unauthorized-speech or unbounded-cost defect.

**P24 — CI and release controls.** Owner: engineer. Depends: P02, P07, P23.

- Run CI for pushes/PRs to `production` and future staging/feature branches. Require typecheck, tests, sim/eval, build, bundle-secret checks, DB/queue integration, and release artifact smoke tests.
- Protect `production`; production deployment must wait for the tested commit's successful checks. Configure the deployment hosts explicitly; a Vercel Git import alone does not implement this gate.
- Version the API/event protocol and support old frontend clients during live interviews. Use additive migrations and a separate migration job; avoid schema migrations in Vercel builds.
- Acceptance: a failing required check cannot promote code; test a release while an older browser is mid-interview and verify recovery.

**P25 — Hosted staging and Vercel integration.** Owner: engineer + account owner. Depends: P02–P10, P14–P17, P24's release plumbing.

- Execute the runbook with separate staging resources/keys, exact origins, protected web previews, authenticated API and a stable staging URL for full voice tests.
- Configure Vercel monorepo root, public URLs, production branch, domains, environment separation and build commands. Add API/worker Docker and deployment manifests, health checks and explicit runtime configuration.
- Acceptance: test two accounts end to end over HTTPS/WSS; inspect actual network hosts; no production data or credentials available to preview/fork builds. P23's full acceptance can then run on this environment.

**P26 — Backup, rollback and incident rehearsal.** Owner: engineer + operator. Depends: P19, P22, P25.

- Configure backups/PITR and restore into an isolated database; replay erasure ledger before exposing restored records. Prove queue/outbox reconciliation.
- Rehearse API/worker rollback and Vercel rollback independently, including frontend/API version compatibility, open sockets, migrations and pinned scenario content.
- Suggested targets: backup recovery point <=15 minutes and service restoration <=60 minutes, only if purchased infrastructure supports them and the rehearsal proves them.
- Acceptance: timed restore and rollback evidence with a named operator; no claim that frontend rollback reverses database changes.

**P27 — Invite-only release.** Owner: product owner + testers. Depends: P01–P26.

- Invite 5–10 testers, issue bounded credits, observe onboarding and collect consented feedback. Start with five verified scenarios and explain the limited library.
- Conduct ten full interviews, including 45-minute sessions and forced recovery. Fix recurring onboarding, timing, run correctness and report issues before widening access.
- Acceptance: G1 signed off, support route exercised, cost per completed interview measured and launch cap configured to tested capacity.

**P28 — Repeat-use content.** Owner: content author + reviewer. Depends: P15, P18, P27.

- Expand to a proposed 12–20 reviewed original/licensed scenarios across core patterns, with oral briefs, canonical facts, tested reference solutions, hidden cases, probes, hints and follow-ups.
- Provide reviewed technical contracts consistent with the runner; preserve version pins and retire old versions without breaking reports.
- Acceptance: each added scenario passes correctness/disclosure evals and a human oral dry run; content quantity never substitutes for those checks.

**P29 — Public-beta reliability gate.** Owner: engineer + operator. Depends: P23, P26–P28.

- Complete the public gate measurements below and resolve high-severity issues. Repeat load tests at the desired admission cap (proposed next cap: 25), then set the cap no higher than verified capacity and provider quota.
- Acceptance: documented release decision, budget headroom, support coverage and no unresolved launch blockers; a queue/full message handles excess demand.

**P30 — Acquisition and activation.** Owner: product owner + engineer. Depends: P20, P21, P27; public promotion after P29.

- Publish a clear landing page, truthful short demo, pricing/free-credit explanation, supported devices, FAQ, privacy and support links. Add metadata, social preview, canonical URLs, sitemap and noindex on private/staging pages.
- Add minimal consent-appropriate funnel events with opaque IDs: visit, signup, preflight pass, voice start, interview completed, report viewed, second interview. Exclude code/audio/transcripts from analytics; use shared server definitions for completion.
- Week 1 of beta: direct invitations to 5–10 people preparing for interviews. Week 2: fix observed activation failures and invite a second cohort. After public gate: publish the demo and original interview tips in relevant communities where promotion is allowed; attribute signups without invasive tracking.
- Acceptance: owner can distinguish traffic, successful first interview, report engagement and return use; two cohorts can activate without developer assistance. Public launch metrics are hypotheses, not promised conversion rates.

**P31 — Public launch operations.** Owner: product owner + operator. Depends: P29, P30.

- Open signup gradually, keep capacity/usage caps, monitor the first 48 hours, triage feedback daily for the first two weeks, and review cost/retention weekly.
- Publish service limits, degraded-service behavior and how failed interviews receive credits. Keep a tested way to pause new admissions without deleting user work.
- Acceptance: G2 release evidence, rollout owner and incident contact exist; continued growth is tied to reliability and unit cost.

**P32 — Paid launch (conditional).** Owner: engineer + product owner. Depends: P21, P29–P31.

- If charging, implement hosted checkout/customer portal, server-side entitlements, signed idempotent webhooks, failed-payment handling, cancellation, plan changes and refund/credit rules. Never grant access solely from a client redirect.
- Test delayed, duplicate and out-of-order webhook delivery; reconcile with provider records. Publish the actual offer and obtain an appropriate hosting plan.
- Acceptance: sandbox payment lifecycle tests and controlled live purchase/refund succeed; support and bookkeeping procedures are documented. Free capped beta does not depend on this task.

## 5. Dependencies, milestones and estimates

Recommended implementation order is the numbered backlog, with these practical overlaps: P07 can begin alongside auth; P14 can begin alongside storage; release plumbing in P24 and P25 begins early so P23 runs against staging. P24 is only fully closed after P23 passes. This breaks the apparent deployment/testing cycle: create protected staging first, then qualify its release.

Critical path: runnable artifact → secure accounts/storage → transactional events and ownership → speech/voice recovery and real execution → durable reports/privacy/cost controls → hosted acceptance → invite cohort → public gate.

| Work stream | Planning effort, focused engineer-days |
|---|---:|
| P01–P06: foundation/auth/security | 8–13 |
| P07–P10: persistence/recovery/coordination | 10–16 |
| P11–P13: speech and full-length sessions | 8–14 |
| P14–P18: real execution/reports/quality | 10–16 |
| P19–P22: privacy/product/cost/operations | 8–13 |
| P23–P27: acceptance/deployment/beta fixes | 8–14 |
| P28–P31: content and public-launch iteration | 8–15 plus content authoring |
| P32: billing if needed | 3–6 |

These are estimates after source inspection, not a delivery commitment. Invite beta is approximately 52–86 focused engineer-days before contingency; public preparation adds 8–15 plus content work. Budget another 20–30% for live-provider integration and tester feedback. Calendar time depends on available hours and external access. Re-estimate after the P12 voice and P14 sandbox spikes; the earlier informal 6–10 week estimate should not be treated as a verified schedule.

First five reviewable PRs: (1) P02/P03 release artifact/config, (2) P07/P08 persistence, (3) P04–P06 identity/ownership, (4) P09/P10 recovery/coordination, (5) P11/P12 real speech/full-length session. Split each further if needed to keep security and persistence reviews understandable.

## 6. Proposed measurable public-launch thresholds

| Check | Target and measurement |
|---|---|
| Privacy / authorization | Zero cross-user access in HTTP/WS/export/delete tests; deletion verified after restart |
| Execution | All reference solutions correct, adversarial sandbox tests contained; no AI-predicted verdicts in production |
| Persistence | Zero lost acknowledged events across restart/duplicate/two-instance test suite |
| Voice longevity | Complete 45-minute session with at least one provider renewal and one app reconnect |
| Human trial | At least 20 full sessions across 10 people, including quiet/noisy environments and supported browsers |
| Completion | >=95% of admitted test sessions reach usable report absent intentional user abandonment; always show numerator and sample size |
| Interruptions | <1 material unwanted interruption per 30 interview minutes in annotated human sessions; track missed responses separately |
| Factuality/leakage | Zero material incorrect canonical facts or disallowed solution disclosures in reviewed launch set |
| Response latency | Proposed p95 <=4 seconds from finalized candidate turn to audible response when speech is authorized; exclude intentional silence and report sample size |
| Recovery | Proposed app recovery <=15 seconds after connectivity returns, without duplicate brief or hint |
| Reports | Proposed p95 <=60 seconds from session end under tested load; explicit queued/failed state for the rest |
| Cost | Measured per completed/failed session, reserved credits and tested daily/global admission cap; owner-approved spending ceiling |
| Release | Required CI green, Linux artifact/staging smoke passed, backup restore and rollback rehearsed |

Do not turn small-sample beta measurements into public guarantees. If a threshold fails, retain invite-only access and record the remediation task.

## 7. Cost planning and launch economics

Do a pricing check when selecting accounts; no vendor quotes or fixed monthly bill are asserted here. Hosting must budget for web, persistent API, worker, DB/backups, coordination, auth, diagnostics, domain/email, sandbox and AI. Production and staging need separate usage allowances. Vercel's Hobby plan is restricted to personal non-commercial use; budget an appropriate commercial plan for this user-facing business. [Vercel Hobby policy](https://vercel.com/docs/plans/hobby)

Use measured values from P21/P27:

`monthly cost = fixed platform costs + attempted interviews × mean variable cost per attempt + retained storage/egress + operational headroom`

Variable cost includes voice input/output, classifier calls, any observer/evaluator model, sandbox runs, retries, and failed sessions. Estimate from attempts as well as completions. Before a price is advertised, compute contribution per paid interview after trial credits, retries, payment fees and support; record model/provider/version assumptions. A hosting spend alert does not cap a separate Gemini or execution-service account.

## 8. Explicitly later

Native mobile apps, video, many programming languages, enterprise teams, public report sharing, employer dashboards, fully generated question banks, advanced adaptive recommendations, and large paid acquisition campaigns are outside the first public beta. These can follow measured demand. Baseline authentication, truthful execution, privacy, cost control and full voice acceptance cannot be deferred from an external-user launch.
