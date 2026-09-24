# Production completion ledger

Scope decision recorded 2026-09-17: the first release is a free, capped beta.
Interviews do not require a Run button and code results remain clearly labelled
model estimates. A real execution sandbox and paid billing are later products,
not release gates for this scope.

## I08 local completion checkpoint (2026-09-19)

The release branch `codex-production-08-release-completion` closes the remaining
implementation work that can be verified without a hosted account or a person
using a microphone:

- Preparation completion now uses the same admission and rate-limit boundary as
  direct session creation, and shutdown refuses both preparation and session
  admission routes while draining.
- Privacy maintenance failures are contained, retried on the next minute, and
  emit a redacted operational alert on the first and every twelfth consecutive
  failure instead of becoming an unhandled interval rejection.
- Restore validation now requires the privacy/support tables, rejects unsafe
  remote SSL modes, and prints the next migration/preflight action explicitly.
- `pnpm db:migrate --check` verifies a complete, checksum-matching journal with
  no writes. `pnpm release:preflight` validates production configuration and,
  with `--database`, checks private-table/function isolation and an active bank.
  `pnpm release:smoke` and the manually triggered hosted-smoke workflow provide
  bounded, read-only liveness, readiness, release, CORS, capability and invalid
  authentication checks.
- Seven additional original question drafts are schema-validated and held in
  `content/scenario-drafts/`. They are never loaded by the API or activated by
  the normal importer. Reviewers can validate them with
  `pnpm questions:import --drafts`; activation remains an explicit reviewed
  content operation.

Validation on this branch: `pnpm typecheck`, `pnpm build`, both question-bank
dry runs, migration plan, secret/environment scan, sorted-file scan, bundle scan
and `git diff --check` pass. Automated test suites remain assigned to the
separate test pass. No database, provider, hosting or user data was contacted.

## Remaining code and configuration

I09 correction: the database preflight now refuses to claim browser isolation
unless both Supabase `anon` and `authenticated` roles exist. It also refuses a
release snapshot when active interviews have unfinished durable runtime inputs.
This detects lost dispatch; it does not reprocess potentially partial AI work.
The automatic completion sweep now retries database discovery failures without
an unhandled process rejection. Safe cross-instance command routing and input
reconciliation remain separate engineering work if multiple API replicas must
serve the same active interview. Until that is implemented and verified, use one
API replica for the invite beta and treat a `RUNTIME_OWNED_ELSEWHERE` response as
a deployment fault. Do not claim two-replica acceptance from the current code.
Hosted startup now takes a session-scoped database lock and refuses a second
API replica. Readiness checks that the lease connection is still alive. This
enforces the current deployment limit; it does not turn missing replay/routing
into a completed capability.
Deadline discovery now emits a redacted alert on the first and every twelfth
consecutive outage, while `product:metrics` shows the unresolved input count.
These checks make the failure visible; they do not replace the missing replay
and routing mechanism. Also complete the separately assigned automated tests
before any external rollout.

| Production tasks | Remaining work |
|---|---|
| P01 | Record the owner-selected region, monthly budget, supported devices, domain and incident owner. Keep product and deployment docs synchronized. |
| P02–P03 | Prove the Linux image in CI and validate final hosted environment values. A separate worker image is unnecessary while the durable report/privacy workers run inside each fenced API replica. |
| P04–P06 | Complete live Supabase sign-in, expiry/revocation/deletion, origin, route-ownership and abuse acceptance. Auth identity deletion after application-data deletion is implemented. |
| P07–P10 | Apply the numbered migrations with the migration job; run real database and two-replica recovery checks. Durable repositories, runtime leases and input obligations exist; cross-instance acceptance remains. |
| P11–P13 | Run the full 45-minute voice/device/reconnect/finalization matrix on staging and fix observed failures. |
| P17–P18 | Run live report recovery/deletion races and human calibration of independent grades and observer behavior. |
| P19 | Review privacy copy and operate the deletion-ledger export/replay procedure. Automatic resume and completed-session expiry, durable deletion recovery and user export/delete are implemented. |
| P20 | Run screen-reader, contrast and supported-browser/device acceptance on the implemented optional-resume onboarding and keyboard/status/dialog accessibility paths. |
| P21–P22 | Confirm provider-enforced voice lifetime/cost bounds, configure alerts and support ownership, and measure the implemented redacted in-session incident signal on staging. |
| P23–P26 | Run database/browser/load/provider acceptance, required CI checks, protected staging, managed backup/PITR, restore and rollback rehearsals. |
| P27 | Invite 5–10 people and complete ten observed full interviews. |
| P28 | Author and review enough original scenarios for repeat use. Five are currently packaged; the target remains 12–20 after human and grading review. |
| P29–P31 | Run the aggregate product snapshot with matching provider cost/host/signup metrics, pass capacity gates, publish a demo, run two cohorts and assign launch monitoring ownership. |

P14–P16 (external sandbox execution) and P32 (billing) are explicitly deferred by
the selected release scope. If the product later claims executed code results or
charges users, those tasks become release gates again.

## External acceptance that code cannot complete alone

- Owner applies migrations and private question content to development Supabase.
- Owner configures protected Vercel/Render staging, managed backup/PITR, alerts,
  domains, quotas and provider budgets.
- Real accounts, browsers, microphones, network interruptions and 45-minute
  interviews supply the voice/recovery evidence.
- Human reviewers approve scenario correctness, oral delivery and grader quality.
- Pilot users and measured sessions supply G1/G2 release evidence.

The codebase must keep these items open until evidence exists. A local build or
mock provider cannot honestly close them.
