# Production database migrations

The API never migrates its database during startup. A separate operator job plans,
checks and applies every immutable SQL file from `supabase/migrations` and
`apps/api/migrations`.

```text
pnpm db:migrate -- --plan
pnpm db:migrate -- --status
pnpm db:migrate -- --apply
```

`--plan` is offline and prints ordered names plus checksums. Status and apply use
`MIGRATION_DATABASE_URL`; apply also requires `MIGRATION_CONFIRM_DATABASE` to
exactly equal the URL's database name. The runner holds an advisory lock, rejects
changed or reordered history, and commits all pending DDL with journal rows in
one transaction.

An existing schema without `public.master_leeter_migrations` is deliberately
refused. Compare it against all migration files in an isolated clone, resolve any
drift, and establish the journal through an explicitly reviewed one-off procedure.
Do not mark unknown production objects as applied merely to make the command pass.

Use a migration-owner connection only in the protected migration job. The API
runtime role receives its documented table/function privileges and cannot alter
schema. Keep admission disabled until migration status has no pending entries,
API readiness succeeds, private browser-role access is denied, and a rollback
decision has been recorded for the release.
