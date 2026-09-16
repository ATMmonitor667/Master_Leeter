# Production configuration and release artifact

The API image is built from the repository root:

```text
docker build -f Dockerfile.api -t master-leeter-api:<release> .
```

The image runs as the unprivileged `node` user, starts compiled JavaScript with
the compiled contracts export, includes the five scenario assets, binds
`0.0.0.0`, and honors host-provided `PORT` before local `API_PORT`.

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
| `RELEASE_SHA` | Safe image/commit identifier returned by health probes |

`ALLOW_INSECURE_DEV=1`, file questions, HTTP origins, in-memory storage and
development authentication are rejected when `NODE_ENV=production`.

## Browser build environment

Vercel builds must set `NEXT_PUBLIC_APP_ENV` to `preview` or `production`,
`NEXT_PUBLIC_AUTH_MODE=supabase`, an HTTPS `NEXT_PUBLIC_API_URL`, the matching
Supabase project URL/public key, and optionally a WSS `NEXT_PUBLIC_WS_URL`.
When the WebSocket URL is absent it is derived from the API origin. Hosted build
validation rejects localhost, insecure schemes and secret Supabase keys.

The browser receives only `NEXT_PUBLIC_*` values. Database, Supabase secret and
model-provider keys remain API-only.

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
healthy liveness/readiness. Docker engine was unavailable on the development
machine, so a clean Linux image build and hosted SIGTERM/WS smoke remain release
acceptance rather than completed evidence.
