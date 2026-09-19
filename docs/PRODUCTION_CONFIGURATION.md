# Production configuration and release artifact

The API image is built from the repository root:

```text
docker build -f Dockerfile.api -t master-leeter-api:<release> .
```

The image runs as the unprivileged `node` user, starts compiled JavaScript with
the compiled contracts export, includes the five scenario assets, binds
`0.0.0.0`, and honors host-provided `PORT` before local `API_PORT`. Its Docker
health check calls `/health/ready`, so an instance is removed from service when
storage is unavailable or shutdown drain has begun.

CI builds this exact Linux image, verifies its configured user, boots it with
the compiled start command, checks live/ready and the packaged scenario
catalogue, then stops it through Docker to exercise the SIGTERM path.

`render.yaml` defines the first staging API service with automatic deployment
disabled. It requires the owner to enter all URLs and credentials in Render and
keeps `ADMISSION_ENABLED=false` until migrations and hosted checks pass. The
blueprint is configuration scaffolding; importing it does not prove readiness
or authorize a production deployment.

## API environment

Production boot validates configuration before opening a socket. Error messages
name invalid variables and never include their values.

| Variable | Production requirement |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | Host port; `API_PORT` is the local fallback |
| `WEB_ORIGIN` | Exact HTTPS web origin, without a path or wildcard |
| `DATABASE_URL` | Supabase direct or pooler PostgreSQL URL; activates all durable repositories |
| `AUTH_MODE` | `supabase` |
| `QUESTION_BANK_SOURCE` | `supabase` |
| `SUPABASE_URL` | HTTPS project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Public key used to verify signed-in users |
| `SUPABASE_SECRET_KEY` | Server-only question-bank key; legacy service-role key is accepted as a fallback |
| `REALTIME_API_KEY`, `REALTIME_MODEL` | Gemini Live credential and account-verified model |
| `GEMINI_API_KEY` | Gemini text-model key; `REALTIME_API_KEY` is the supported fallback |
| `CLASSIFIER_MODEL`, `EVALUATOR_MODEL` | Required model roles; production may not use their local deterministic fallbacks |
| `RESUME_ANALYZER_MODEL`, `RESTATEMENT_MODEL` | Optional overrides; each falls back to the configured observer model |
| `JUDGE_MODEL` | Optional model-estimated run feedback; it is never described as sandbox execution |
| `DRAIN_GRACE_MS` | 0–20000 ms for load balancers to observe failed readiness before sockets close |
| `RELEASE_SHA` | Safe image/commit identifier returned by health probes; Render's `RENDER_GIT_COMMIT` is used when absent |
| `ALERT_WEBHOOK_URL` | Optional HTTPS endpoint for redacted critical operations alerts |
| `ALERT_WEBHOOK_TOKEN` | Optional Bearer credential; valid only with the webhook URL and never logged |
| `ADMISSION_ENABLED` | Operator kill switch for new interviews; existing interviews continue |
| `MAX_ACTIVE_INTERVIEWS` | Deployment-wide active-session ceiling, enforced under a Supabase advisory lock |
| `MONTHLY_INTERVIEWS_PER_USER` | Account interview allowance per UTC calendar month |
| `MAX_REALTIME_MINTS_PER_SESSION` | Lifetime provider credential cap for one interview |
| `SESSION_CREATES_PER_MINUTE` | Per-account create-request bucket |
| `PREPARATIONS_PER_MINUTE` | Per-account resume-analysis request bucket |
| `REALTIME_MINTS_PER_MINUTE` | Per-account voice credential request bucket |
| `RUN_REQUESTS_PER_MINUTE` | Per-account run-feedback request bucket |
| `SUPPORT_REPORTS_PER_MINUTE` | Per-account in-session incident-report bucket |
| `METRICS_DATABASE_URL` | Read-only operator connection used only by `pnpm product:metrics`; omit from the API service |
| `SESSION_RETENTION_DAYS` | Days after completion before interview evidence is tombstoned and redacted; current policy is 365 |

`ALLOW_INSECURE_DEV=1`, file questions, HTTP origins, in-memory storage and
development authentication are rejected when `NODE_ENV=production`.

Migration 012 adds a database backstop for one active interview per account and
atomic rate buckets shared by every API replica. New-session admission takes a
transaction-scoped Supabase advisory lock, then checks the process kill switch,
global capacity, the account's active interview and its monthly usage before
the session and start event commit together. Idempotent create retries retrieve
their original session before consuming capacity again. Deleting an interview
does not restore already-spent monthly allowance.

## Browser build environment

Vercel builds must set `NEXT_PUBLIC_APP_ENV` to `preview` or `production`,
`NEXT_PUBLIC_AUTH_MODE=supabase`, an HTTPS `NEXT_PUBLIC_API_URL`, the matching
Supabase project URL/public key, and optionally a WSS `NEXT_PUBLIC_WS_URL`.
When the WebSocket URL is absent it is derived from the API origin. Hosted build
validation rejects localhost, insecure schemes and secret Supabase keys.

The browser receives only `NEXT_PUBLIC_*` values. Database, Supabase secret and
model-provider keys remain API-only.

## Database recovery

The operator-only backup and restore commands, archive manifest, isolation
guards and recovery checklist are documented in
[`DATABASE_RECOVERY.md`](DATABASE_RECOVERY.md). They cover the application
`public` schema only; Supabase managed backups or PITR remain required for the
full project. Restore drills stay isolated until post-backup erasures can be
reconciled with `privacy:ledger:export` / `privacy:ledger:replay` and application
smoke checks pass. Numbered migrations are planned with `pnpm db:migrate`; only
explicit `--apply` mode writes and it requires `MIGRATION_CONFIRM_DATABASE` to
exactly match the target database name.

## Health and shutdown

- `GET /health/live` proves the process and event loop are responsive.
- `GET /health/ready` checks current storage reachability and returns 503 while
  storage is unavailable or the process is draining. It never pays for an AI
  request.
- `SIGTERM`/`SIGINT` first makes readiness fail and refuses new interview
  creation, then waits `DRAIN_GRACE_MS`, drains report work and storage hooks,
  and closes the server.

Routine API responses carry an opaque request ID and security headers. In
production, uncaught errors return the request ID and a safe error code without
provider bodies, database addresses, source code or transcript content.

Local validation completed for this checkpoint: the root production build and
all package typechecks pass; compiled API startup reports five scenarios and
healthy liveness/readiness. The release workflow now owns the clean Linux image
build and container smoke because the development machine has no available
Docker engine. A successful workflow run plus hosted SIGTERM/WS checks remain
release acceptance evidence.
