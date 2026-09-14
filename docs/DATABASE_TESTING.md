# PostgreSQL acceptance for Supabase storage

Supabase remains the database provider. The `pg` driver is a server-side
PostgreSQL connection, not a replacement for Supabase. The API still uses
in-memory repositories until lifecycle/recovery integration is complete.

## Local integration tests

Use a dedicated local PostgreSQL 16+ server with a test superuser able to create
databases and roles. Never provide a live Supabase URL to this harness. It
accepts only loopback hosts and the postgres/template1 maintenance database.
It creates a random `ml_test_<uuid>` database and `ml_reader_<uuid>` role, applies
every numbered migration through 006_consent_grants.sql there, and removes only
those generated resources at the end. If the process is killed, they can remain;
inspect their exact names before manually cleaning them up.

PowerShell, from the repository root:

```powershell
$env:TEST_DATABASE_ADMIN_URL='postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/postgres'
pnpm --filter @master-leeter/api test:database
Remove-Item Env:TEST_DATABASE_ADMIN_URL
```

Do not paste a real password into committed scripts or chat. The explicit command
fails if the test URL is missing; ordinary unit runs skip database integration
tests when it is absent. No `.env.local` is loaded by this harness.

CI's `database` job runs a disposable PostgreSQL 16 service with test-only
credentials. It exercises concurrent creation, atomic event sequencing, retry
deduplication, rollback after a rejected pin, fresh-pool reads, code/notes replay,
durable browser sequencing, cross-pool single-use socket tickets,
fenced report claims/results and durable consent history,
terminal state, immutable pin/event triggers and RLS with an unprivileged role.
Configure this job as a required branch-protection check before merging releases.
Fresh-pool reconstruction tests storage, not full API/voice restart recovery.

## Supabase connection when runtime integration is ready

Use the server/pooler PostgreSQL connection from the project's Connect panel,
stored in the backend's ignored environment file. `PgDatabase` verifies remote
TLS certificates. It rejects URL query parameters so `sslmode` cannot override
certificate checking; use the plain connection URL. Custom CA support is not
implemented; do not bypass TLS verification if the certificate chain fails.
The browser continues using only the Supabase public key, never this URL.

No migration is automatically applied to Supabase. Apply migrations to a private
development database first. Legacy session rows have no scenario snapshot;
never recover those using a different/current question version. Live Supabase
anon/authenticated grants, production-role provisioning, RLS behavior and
connection compatibility still need acceptance on that project.

Driver implementation follows node-postgres guidance for
[same-client transactions](https://node-postgres.com/features/transactions) and
[TLS configuration](https://node-postgres.com/features/ssl).
