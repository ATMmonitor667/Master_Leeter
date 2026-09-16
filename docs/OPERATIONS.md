# Operations and safe diagnostics

Every API response carries a server-generated `X-Request-Id`. Ask a user for
that value and the approximate time when investigating a failure. Routine logs
may contain that request ID and opaque session/run/job identifiers; they must
not contain bearer tokens, socket tickets, resume text, transcripts, source
code, tool payloads, provider response bodies or database URLs.

The API logger removes authorization, API-key and cookie headers and omits URL
queries. Production uncaught errors return `INTERNAL_ERROR` plus the request ID.
Provider/session paths log typed failure names or codes rather than raw error
objects. Startup prints only configuration variable names or safe subsystem
codes.

## Probes and capability status

- `/health/live`: process liveness and release identity.
- `/health/ready`: current storage reachability; returns 503 while draining.
- `/health/status`: safe configured capability and circuit state. It exposes no
  counts, user identities, content or credentials and does not call a provider.

Readiness controls routing. A provider circuit opening is a degraded capability,
not process unhealth: active interviews must retain editor/timer/recovery access.
Gemini grader calls open their breaker immediately on quota exhaustion or after
two consecutive failures. Realtime credential minting opens immediately on a
quota response or after three consecutive failures. After a 60-second cooldown,
one probe is admitted before the breaker closes.

## Alert signals

Configure the host/log service to alert the operator on these structured events:

| Signal | Suggested action |
|---|---|
| readiness 503 for two probe intervals | Stop routing new traffic; inspect Supabase connectivity/schema |
| `rate-limit storage unavailable` | Treat admission as failed closed; inspect database availability |
| `report recovery unavailable` | Inspect database/job leases; the log is throttled after the first failure |
| `report evaluation attempts exhausted` | Inspect provider quota/model/schema and the cited opaque session ID |
| `realtime token mint failed` or voice circuit `OPEN` | Inspect Gemini quota and account/model availability |
| `automatic session completion failed` | Inspect lifecycle/storage before deadlines accumulate |
| `shutdown failed` | Verify the previous instance released ownership and report jobs |

Alert delivery, escalation contact and log retention are hosting decisions and
must be configured on staging before the invite pilot. A log line in source is
not evidence that paging works; force each failure and record the delivered
alert without opening candidate content.
