# Local development

Node 22+ and pnpm 9 are required. The API reads `apps/api/.env.local`; Next.js
reads `apps/web/.env.local`. Keep one active entry per variable in each file:
later duplicate entries override earlier ones.

## Run without Docker

For a disposable local interview, set these in `apps/api/.env.local`:

```dotenv
NODE_ENV=development
DATABASE_URL=
QUESTION_BANK_SOURCE=files
AUTH_MODE=development
ALLOW_INSECURE_DEV=1
WEB_ORIGIN=http://localhost:3000
```

Set `NEXT_PUBLIC_AUTH_MODE=development` and
`NEXT_PUBLIC_API_URL=http://localhost:4000` in `apps/web/.env.local`. In separate
terminals, run `pnpm dev:api` and `pnpm dev:web`. The API serves the authored
file question bank and keeps sessions in memory; restarting it loses those
sessions. `pnpm infra:up` and database migrations are not part of this mode.
Check `http://localhost:4000/health`, then open `http://localhost:3000`.
Stop `pnpm dev:web` before running `pnpm build`; both Next.js commands write
to `apps/web/.next`.

## Run against Supabase

For private questions, set `QUESTION_BANK_SOURCE=supabase`, `SUPABASE_URL`, and
the server-only `SUPABASE_SECRET_KEY`. For durable sessions, also set a working
`DATABASE_URL` from the same project's direct or pooler connection details.
Supabase's URL and publishable/secret API keys do not supply the database
password. Supabase is the PostgreSQL provider; Docker Desktop is unnecessary.

Use `MIGRATION_DATABASE_URL` for the separate migration-owner connection. The
default `pnpm db:migrate` command only prints an offline plan. Consult
[database migrations](DATABASE_MIGRATIONS.md) before running `--status` or
`--apply` against a real project. Never use the local development auth flags on
a hosted API.
