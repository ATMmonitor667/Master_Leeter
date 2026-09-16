# Master Leeter: Vercel deployment runbook

Update: the owner handles deployment. Follow [PRODUCTION_ITERATIONS.md](PRODUCTION_ITERATIONS.md)
for current scope and [SUPABASE_QUESTION_BANK.md](SUPABASE_QUESTION_BANK.md) for
implemented database setup. Earlier authentication/sandbox choices below remain
proposals. Iteration 1 is not a public-launch signoff; never expose Supabase
elevated keys in the frontend or NEXT_PUBLIC configuration.

Prepared 2026-09-11 for `production` at `b4c25c4`. This is an implementation and deployment plan. Future files, commands, endpoints and variables are marked as proposed; creating this document did not make the current application safe to expose publicly.

Complete the release prerequisites in [PRODUCTION_PLAN.md](PRODUCTION_PLAN.md). Track completion in [PRODUCTION_TODO.txt](../PRODUCTION_TODO.txt). Domain names below use `example.com` as placeholders; no domain purchase or account setup has occurred.

## 1. Where each part runs

Recommended topology:

| Connection / workload | Destination |
|---|---|
| Browser downloads pages and assets | Vercel Next.js project (`apps/web`) |
| Browser sends authenticated HTTP and application events | `https://api.example.com` and `wss://api.example.com` on persistent Render API |
| Browser sends/receives interview audio | Gemini Live using a server-minted constrained ephemeral credential |
| API stores sessions/evidence; workers store jobs/results/reports | Managed PostgreSQL |
| API instances coordinate ownership and receive job notifications | Redis-compatible coordination service |
| Workers dispatch untrusted Python | Separate validated sandbox |

Audio goes directly to the provider only if P21 validates lifetime/revocation/cost enforcement for public users. If those controls cannot be enforced, deploy a metered voice relay on the persistent API tier. The Vercel web app and database layout stay the same.

Do not proxy the whole 45-minute interview through a Next.js HTTP request. Web pages, application events, audio, execution and report jobs have separate lifecycles. The browser's event socket connects directly to the API host in this design.

### Alternative: web and API on Vercel

This is now possible in principle. Vercel WebSockets are in beta and require Fluid compute; reconnects may reach a new instance. That means the runtime's in-memory maps cannot be authoritative. [WebSocket documentation](https://vercel.com/docs/functions/websockets)

Current documented Function limits with Fluid compute are 300 seconds on Hobby, generally available 800 seconds on Pro/Enterprise, and an extended 1,800 seconds in beta on supported configurations. Even the extended duration is shorter than a 45-minute interview. [Function limits](https://vercel.com/docs/functions/limitations)

If selecting this alternative, add a deployment spike after P09/P10: adapt/export the Fastify server for the supported Vercel runtime; package content/Tree-sitter assets; verify socket upgrades, timers and ordered dispatch; externalize background jobs; test forced connection turnover at the chosen limit and across two deployments; measure billed connection time. Use distinct API/web projects with environment-matched endpoints. Choose this only after the full-length/recovery/cost tests pass. The recommended persistent API route avoids making that beta integration part of the first launch's critical path.

## 2. Required code changes before hosting users

| Repository target | Required change | Readiness task |
|---|---|---|
| `package.json`, `pnpm-workspace.yaml`, CI | One Node/pnpm policy; production build/start/migration scripts | P02, P24 |
| `packages/contracts/package.json` | Compiled API can resolve workspace runtime exports | P02 |
| `apps/api/src/index.ts`, `env.ts` | Real store/job injection, validated config, `PORT`, liveness/readiness, shutdown | P02, P03, P07 |
| `apps/api/src/modules/session/*` | Ownership checks, transactional writes, reconstruction, leases, cross-instance dispatch | P05, P08–P10 |
| `apps/api/src/modules/realtime/*`, web voice code | Full transcript path, constrained credential renewal, provider resumption, playback completion | P11, P12 |
| `apps/api/src/modules/runner/*` | Verified execution backend and trusted test harness | P14–P16 |
| `apps/api/src/modules/report/*` | Durable worker, reports and deletion-aware writes | P17–P19 |
| Browser API calls / WS constructor | Central authenticated client, socket-ticket exchange, HTTPS/WSS config | P03–P06 |
| `.github/workflows/ci.yml` | `production` checks, Linux image smoke, real DB integration and deployment gate | P24 |
| Proposed `apps/api/Dockerfile`, root `.dockerignore` | Multi-stage API/worker release image with repository-root build context | P02 |
| Proposed worker entrypoint and `render.yaml` | Repeatable API/worker/coordination deployment configuration | P10, P25 |
| Proposed `apps/web/vercel.json` | Only necessary versioned web settings/headers; prefer Next preset defaults | P25 |
| Proposed web env example and deployment smoke script | Repeatable setup without copying secrets into source | P03, P25 |

No API start, migration, worker, health-readiness or socket-ticket command is assumed to exist until its corresponding task lands. In particular, `node apps/api/dist/index.js` must first be tested with compiled contracts and correct content paths.

## 3. Accounts, region, and secrets

Create owner-controlled accounts for Vercel, API/DB/coordination hosting, authentication, Gemini billing/quota, selected sandbox, and diagnostics. Enable strong account authentication and narrowly scoped automation credentials. Select the initial user geography; place API, worker, database and coordination together where possible. Test latency from the expected users.

Record the purchased plan, quota and spend owner for each provider. Budget a Vercel plan suitable for a commercial application; Hobby is restricted to personal non-commercial use. [Hobby usage policy](https://vercel.com/docs/plans/hobby)

Use distinct staging and production resources/credentials. Do not upload `apps/api/.env.local` to Vercel. Public browser configuration can be visible; Gemini, database, sandbox, webhook and service credentials cannot be `NEXT_PUBLIC_*` variables.

### Web configuration

Set these on the Vercel project, with the appropriate environment scope:

| Variable | Current / proposed | Production example | Preview/staging example |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | Current | `https://api.example.com` | `https://api-staging.example.com` |
| `NEXT_PUBLIC_WS_URL` | Current | `wss://api.example.com` | `wss://api-staging.example.com` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Proposed if Clerk selected | Production publishable key | Development-instance publishable key |
| `CLERK_SECRET_KEY` | Proposed if server-side web auth requires it | Production key, server-side scope | Separate development key |
| `NEXT_PUBLIC_SITE_URL` | Proposed canonical URL | `https://example.com` | Stable staging URL |

Public Next.js values are compiled into browser output. Build production with production values; do not simply promote a staging-built artifact whose API URLs or identity instance are wrong. Environment changes require a new applicable deployment. [Vercel environment variables](https://vercel.com/docs/environment-variables)

### API and worker configuration

| Configuration | Status | Where and purpose |
|---|---|---|
| `NODE_ENV=production` | Standard; production validation proposed | API/worker |
| `PORT` / `API_PORT` | `API_PORT` current; `PORT` support proposed | Use host-assigned port; local default remains 4000 |
| `DATABASE_URL` | Documented, not wired at current entrypoint | API/worker restricted runtime role; TLS; never browser |
| `MIGRATION_DATABASE_URL` | Proposed | Migration job only, not candidate runtime |
| `REDIS_URL` | Documented, current leases still local | API/worker with supported queue/lease semantics |
| `WEB_ORIGIN` | Current | Exact production web origin; replace local exemptions |
| `ALLOWED_WEB_ORIGINS` | Proposed | Explicit environment-specific list if more than one origin is needed |
| `CLERK_SECRET_KEY`, issuer/authorized-party config | Proposed | Verified API auth; workers need only what their tasks require |
| `REALTIME_PROVIDER`, `REALTIME_MODEL`, `REALTIME_VOICE` | Current | Use account-verified Gemini model/config |
| `REALTIME_API_KEY`, `GEMINI_API_KEY` | Current key resolution | API and only workers that make model calls; never log values |
| `REALTIME_TOKEN_TTL_SECONDS` | Current | Credential policy; does not itself prove a hard live-session spending limit |
| `CLASSIFIER_MODEL`, `CLASSIFIER_TIMEOUT_MS` | Current | Verified classifier setup with observable fallback |
| `EVALUATOR_MODEL`, `OBSERVER_MODEL` | Documented but not evidence of wiring | Set only after P18 implements/selects an adapter; report active implementation |
| `RUNNER_CPU_LIMIT_SECONDS`, `RUNNER_WALL_LIMIT_SECONDS`, `RUNNER_MEMORY_LIMIT_KB`, `RUNNER_MAX_PROCESSES` | Documented; advisory for model judge | Enforce with actual sandbox adapter in P14–P16 |
| `RUNNER_PROVIDER`, sandbox endpoint/credentials | Proposed, provider-dependent names | Dispatch worker only; credentials outside candidate environment |
| `RETAIN_RAW_AUDIO=false` | Documented | Keep off; policy and implementation verified by P19 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | Documented; telemetry wiring to verify | API/worker diagnostics; redact payloads |
| Admission cap, credit budget, rate limits, retention days | Proposed typed configuration | API/worker shared policy; exact names defined in P03/P21 |

Do not keep `JUDGE_MODEL` enabled as the production execution path after adopting a real sandbox. Store each secret at the minimum set of services that needs it. A queue consumer evaluating reports does not need permission to mint voice credentials.

## 4. Branches, environments and previews

`production` already exists and tracks `origin/production`. Set it explicitly as the Vercel Production Branch; do not rely on the repository's default `main`. Use feature PRs targeting `production`; protect that branch with required checks. Vercel supports selecting the production branch for Git deployments. [Vercel Git deployments](https://vercel.com/docs/git)

| Environment | Web | API/data/provider state | Admission |
|---|---|---|---|
| Local | localhost | Local DB/coordination, fixtures or explicit dev credentials | Developer |
| PR preview | Protected Vercel preview | Fixtures by default; approved previews may use staging only | Team/testers |
| Stable staging | Dedicated Vercel project or stable staging deployment | Dedicated staging API, DB, coordination, auth, model budget | Invited testers |
| Production | Vercel project with `production` branch | Production-only resources | Invite gate, then controlled public signup |

Use an explicit stable staging origin for long voice acceptance. If using a dedicated staging project, document which branch/SHA is deployed there; a future `staging` branch can be added through the normal workflow. Do not expose production secrets to fork previews. Disable privileged preview builds for untrusted contributions.

Preview protection applies to the web deployment; it does not protect the separate API. API auth/authorization is always required. For approved dynamic preview origins, register exact URLs in the staging allowlist and remove them on teardown. Never wildcard the whole Vercel domain in production CORS or auth allowed parties.

## 5. Prepare and deploy the backend first

Perform this on staging before production:

The repository `render.yaml` is the staging API starting point. It uses
`Dockerfile.api`, disables automatic deployment, leaves credentials as
owner-entered values and starts with interview admission disabled. Review every
value during Blueprint creation; enable admission only after migration 012,
authentication, health and provider checks pass.

1. Complete P02/P03, create managed Postgres and compatible persistent coordination, and configure access/TLS/backups. Create distinct application and migration roles.
2. Build the API image using repository root as context and `Dockerfile.api` as its Dockerfile path. Test the image locally/in CI with its production command. The image contains compiled contracts, scenarios and required parser dependencies.
3. Run the migration command added by P07 as a single serialized release job. Never run competing migrations from every replica or Vercel build. Prove old code tolerates additive schema changes.
4. Create a paid Render web service from that image/config. Bind HTTP and WS to its assigned port. Route liveness to `/health/live` and readiness to `/health/ready`; readiness verifies storage without spending a provider request.
5. Create the worker from the same versioned image with the future worker start command. It must use durable queues and the same content/protocol versions as the API. Keep sandbox credentials in dispatch infrastructure, outside candidate processes.
6. Disable production automatic deploys for initial rollout. Later select deploy-after-successful-CI or a controlled release workflow. Render provides both manual deployment and a CI-gated option. [Render deployment controls](https://render.com/docs/deploys)
7. Configure `api-staging.example.com`, then `api.example.com` for production. Add the provider-prescribed DNS record and verify TLS and WSS before putting the address in browser config. Render web services use one public HTTP/WS port. [Render web services](https://render.com/docs/web-services)
8. Validate unauthorized HTTP and WS requests fail, authorized owner access succeeds, readiness is accurate, and a worker result reaches a connected browser. Prove this with two API instances or a rolling replacement before launch.

An API deploy can terminate sockets. On SIGTERM, stop new session admission, commit processed events, relinquish leases safely, close sockets with a retryable reason, and allow another runtime to reconstruct. Do not assume a host's graceful-shutdown window will preserve an entire remaining interview.

## 6. Import the web app into Vercel

First deploy protected staging. Once G1 is satisfied, use the same configuration shape with production-scoped values:

1. In Vercel, import the GitHub `Master_Leeter` repository into an owner-controlled project.
2. Select Next.js and use the following settings. Vercel supports pnpm monorepos and a project root per application. [Monorepo setup](https://vercel.com/docs/monorepos)

| Setting | Planned value |
|---|---|
| Root Directory | `apps/web` |
| Framework | Next.js |
| Production Branch | `production` for the production project |
| Node version | Align with P02 and CI; current CI uses 22, verify platform support when provisioning |
| Install command | `pnpm install --frozen-lockfile` with the pinned workspace package manager |
| Build command | `pnpm -r --filter @master-leeter/web... build` to build web and its workspace dependencies |
| Output directory | Next.js preset default; no static export |
| Development command | Framework default / `pnpm dev` from `apps/web` |

3. Confirm the build includes the root lockfile/workspace metadata and `packages/contracts`. If the dashboard offers an option to include source outside Root Directory, enable it for workspace dependencies. Verify this with the actual install/build log; do not copy contracts into the web folder or upload scenario content to the public assets directory.
4. Keep `transpilePackages` and `outputFileTracingRoot` in `next.config.mjs`; adjust only if P02's contracts packaging needs it. A web-only build must not start Fastify or need database migrations.
5. Add the environment variables from section 3. Confirm production browser URLs are HTTPS/WSS and use the matching API/auth environment.
6. Enable protection for preview/staging deployments. Use the production application's invite gate during beta; the public landing page can later be reachable without a Vercel team login.
7. Deploy and inspect build output, browser requests, authentication redirects and live socket handshake. Confirm secrets and full problem statements are absent from public assets and routine app state.
8. Add the chosen apex/web domain in Vercel. Apply exactly the DNS values Vercel displays, verify TLS, choose one canonical host, and update auth callback/allowed-party/CORS settings to match it. Do not hardcode guessed DNS targets.

Prefer Git-based imports for repeatability. If later using the CLI, run it from the repository root and link the intended monorepo project; follow the project's configured root settings. Provisioning and promotion are actions to perform later, after the code gates pass.

## 7. Hosted smoke and acceptance checks

Record commit SHA, web/API/worker deployment IDs, migration version, provider models, test date, browser/device, tester, and result for every release candidate.

- New sign-in completes at the intended origin; logout prevents further access; two users cannot access each other's resources.
- Browser requests use the expected HTTPS API and WSS hosts. No localhost, mixed content, secret keys, or overly broad CORS appear.
- Preflight handles mic denied, no device, selected device, output test and mute. Captions OFF still supports interview understanding.
- Start a scenario, hear the complete brief, clarify, explain an approach, code, run, test follow-up eligibility, finish, receive a report, sign out/in and reopen history.
- Test one real 45-minute session across provider renewal and an application disconnect. Validate timer credits, old-event replay, stale-authorization refusal, and no duplicate brief.
- Replace the API instance and restart workers during test sessions; drafts/events/reports survive and clients recover.
- Correct and wrong submissions produce actual execution results. A timeout produces a timeout, not a claimed wrong answer; flood attempts are contained.
- Quota/full-capacity state is understandable; duplicate start/run requests do not multiply credits or cost.
- Delete/export with an owner account, then verify inaccessible data and blocked report regeneration after restart.
- Run the G1/G2 live-test and load-test matrices; record failures with task IDs and rerun only affected acceptance after fixes.

A successful web build is not the live-audio acceptance result. Never publish a “ready for users” declaration based only on Vercel showing a green deployment.

## 8. Release and rollback sequence

For the first production release, deploy in this order: database/coordination → compatible migration → API and worker → web built with production values → auth/domain/origin checks → production smoke → invite gate. Maintain a release manifest linking the same compatible commit/config versions.

For later releases, keep the old frontend/API protocol functional while users finish interviews. Apply additive schema changes, deploy compatible backend/worker, then promote the tested production-target web build. Defer destructive schema cleanup until older binaries/jobs/sessions no longer require it. On each host, prevent automatic promotion of unverified commits; preview success and required CI must be tied to the release SHA.

If problems appear:

1. Pause new interview admission and cap provider spend; keep existing evidence/drafts accessible. Decide explicitly whether current voice sessions can continue.
2. Identify whether failure is web, API, worker, provider or data. Record release IDs and safe diagnostics.
3. For a web regression, roll back to a compatible prior production deployment using Vercel's rollback feature. That affects the Vercel deployment, not the external API, queues or database. [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)
4. For backend regression, deploy the previous compatible API/worker image and recover leases/jobs. Do not run a destructive down-migration to roll back code; use a forward data fix or planned restore if needed.
5. If restoring data, restore to an isolated DB, reconcile committed events/outbox, replay deletion records, validate access and only then switch traffic. Record actual data loss against the recovery target.
6. Re-run the affected smoke tests, restore capacity gradually, credit failed interviews and document the incident.

## 9. Launch-day checklist and troubleshooting

Public signup stays disabled until G2; billing stays disabled until G3. The landing page/waitlist can launch earlier with truthful availability copy and its own spam/privacy controls.

| Symptom | First checks |
|---|---|
| Page loads, scenarios fail | `NEXT_PUBLIC_API_URL` was set at build, API is reachable, CORS allows exact origin, readiness passes |
| HTTP works, socket fails | WSS URL/path, ticket validity/origin, handshake auth, proxy upgrade, API instance routing |
| Interviewer hears nothing with captions off | P11 transcription integration; ensure final turns are emitted independently of caption UI |
| Voice stops around provider limits | P12 GoAway/resumption/compression; new constrained credential works and mint limits permit renewal |
| API build green but process crashes | Contracts export format, content path, parser assets, production dependency set, `PORT` handling |
| Report stays queued | Durable job state, worker readiness, model/runner errors, retries/dead letter, deletion tombstone |
| Reload says unknown session | Correct environment and identity; Postgres store selected; state reconstruction after instance change |
| Preview touches real users | Pause preview; fix scoped public URLs/auth keys; separate staging data and credential access |
| Spike in spend | P21 admission/cap ledger, provider usage, retry loops, active direct-provider sessions, sandbox cleanup |

Before widening access, verify current provider quotas and plan limits, successful backup/rollback rehearsal, named support owner, configured budget thresholds, and a capacity cap that passed testing. Recheck linked platform documentation when implementation starts or if provisioning occurs significantly after this plan's date.
