# Deferred feature test pass — 2026-10-11

This pass adds 93 executable local regressions and four PostgreSQL regressions
for features whose earlier implementation checkpoints deferred new tests.
It adds no provider credentials and makes no cloud requests.

| Area | New coverage |
|---|---|
| Preparation | Consent, account ownership, reviewed facts, retry-safe completion, private response projection, immutable pins, stale analysis workers, resume deletion/expiry and deleted-key reuse |
| Resume models | Exact source evidence, category filtering, fact limits, unique review identities and canonical wording fallback |
| Independent graders | Separate solution/transcript inputs, exact citations, private-reference leak rejection, missing evidence/dimensions, partial-result retry and quota circuit |
| Launch controls | Production config rejection/redacted errors, rate quotas/bursts/window reset, shutdown admission and unavailable rate store |
| Operations | Circuit recovery probes, alert retries, permanent delivery failure, bounded attempts and bearer placement |
| Support | Explicit consent, strict diagnostic schema, ownership, retry deduplication, expiry and safe storage failures |
| Privacy | Claim fencing/recovery, bounded recovery batches, erasure-before-identity ordering and retry after unfinished erasure |
| History | Account isolation, tied-timestamp pagination, tombstone exclusion and malformed cursor/limit rejection |
| Voice | Exact speculative reuse, changed-text reclassification, speculation failure fallback, timed prosodic windows, neutral/noisy/short evidence, reset, stale/future audio exclusion and pitch-scale consistency |
| PostgreSQL | Cross-pool resume erasure, support deduplication/deletion, account-erasure deduplication/fencing and concurrent shared rate limits |

The existing PostgreSQL harness now discovers every numbered API migration,
including 010–015; it previously stopped at 009, which cannot satisfy the
current durable-storage startup checks. It retains the loopback maintenance
database guard and writes only to its generated test database.

## Verified locally

- API: 873 passed; PostgreSQL suite needs a separate database run.
- Web: 142 passed.
- Contracts: 38 passed.
- Total: 1,053 passed. The database suite contains 20 checks, including four
  added in this pass, that have not been executed here.
- API, API-script and web TypeScript checks passed.
- Interruption/factuality/leakage evaluation gates passed.
- Environment tracking and sorted-file guards passed.

The installed dependencies have missing command shims on this Windows checkout,
so verification invoked their installed entry points with Node directly:

```powershell
# Run from apps/api
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.scripts.json
node node_modules/tsx/dist/cli.mjs src/eval/cli.ts

# Run from apps/web
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

# Run from packages/contracts
node ../../apps/api/node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1
```

## Remaining verification

Docker's Linux engine is unavailable on this machine. Run the database job in
CI or provide a disposable local PostgreSQL 16+ maintenance server using
`TEST_DATABASE_ADMIN_URL` and `pnpm --filter @master-leeter/api test:database`.
Never use a remote Supabase connection for that destructive test harness.

No new browser E2E or production build was run for these test-only changes.
Existing browser checks are documented in `UI_REDESIGN_STATUS.md`.
Real OTP delivery, microphone interviews, hosted recovery/load, provider model
availability, grading calibration, backup/restore and release acceptance remain
open. Passing these regressions does not establish production readiness.
