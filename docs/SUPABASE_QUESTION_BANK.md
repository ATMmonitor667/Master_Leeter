# Supabase question-bank setup

Iteration 1 implements the migration, importer and adapter. No cloud project has
been provisioned, migrated or seeded. Sessions/events remain in memory and auth
is still a placeholder: do not invite public users yet.

## Owner checklist

1. Create or select a **development** Supabase project, separate from production.
2. Review and apply `supabase/migrations/202609110001_question_bank.sql` once using
   that project's SQL editor or migration runner. Check the project first. This
   creates a table/function/trigger, not a database reset.
3. In ignored `apps/api/.env.local`, set server-only configuration:

   ```dotenv
   QUESTION_BANK_SOURCE=supabase
   SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   SUPABASE_SECRET_KEY=YOUR_SERVER_SECRET_KEY
   ```

   A legacy SUPABASE_SERVICE_ROLE_KEY works instead. Do not use an anon/publishable
   key for this private table. Never put elevated keys in NEXT_PUBLIC variables,
   frontend code, commits or messages. Real environment variables override files.
   New secret keys use the apikey header; legacy service-role JWTs additionally
   use bearer authorization. See [Supabase API-key guidance](https://supabase.com/docs/guides/getting-started/api-keys).
4. From the repository root, validate without network access or writes:

   ```sh
   pnpm questions:import
   ```

   Expected: five validated original versions. After reviewing the target project
   and applying its migration, import with:

   ```sh
   pnpm questions:import --apply
   ```

   Repeat: expect zero inserted, five already present. Inserts are sequential,
   not one transaction; re-run safely after a partial outage. Conflicting content
   fails closed: create a new version, never overwrite/delete the old one. Hashes
   cover exact UTF-8 bytes, including line endings; preserve repository LF settings.
5. Start `pnpm dev:api` and check the flows below. Gemini is not needed for bank
   validation; later voice testing needs GEMINI_API_KEY and account-available
   model settings in the API env.

## Cloud acceptance

Run these read-only SQL checks in the development project after import:

```sql
select version_id, public_ref, status from public.interview_questions order by version_id;
select relrowsecurity from pg_class where oid = 'public.interview_questions'::regclass;
select role_name,
  has_table_privilege(role_name, 'public.interview_questions', 'SELECT') as can_read,
  has_table_privilege(role_name, 'public.interview_questions', 'INSERT') as can_insert,
  has_table_privilege(role_name, 'public.interview_questions', 'DELETE') as can_delete,
  has_column_privilege(role_name, 'public.interview_questions', 'status', 'UPDATE') as can_retire,
  has_column_privilege(role_name, 'public.interview_questions', 'content_yaml', 'UPDATE') as can_edit_content
from (values ('anon'), ('authenticated'), ('service_role')) roles(role_name);
```

Expected: five ACTIVE rows; RLS true; anon/authenticated all false; service_role
read/insert/retire true, delete/edit-content false. Elevated server roles bypass
RLS, so explicit grants and the immutable-content trigger matter. See
[Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

Also verify actual anon and signed-in user REST requests cannot read private
content. Do not log credentials or full private payloads. In disposable development
transactions verify content updates/deletes fail, status updates succeed, then
roll back. The table intentionally has no public read policy or browser write route.

## Application acceptance

- GET `/v1/scenarios` exposes only ref, level, topics and expectedMinutes, never
  briefs, hidden tests, facts or reference solutions.
- POST `/v1/interview-sessions` with Idempotency-Key and `{}` selects an ACTIVE
  DB question. `{ "scenarioRef": "<catalogue ref>" }` selects a specific one.
- Same user/key returns the same session even when the bank later goes offline.
  Current x-user-id is only a development placeholder, not verified identity.
- Retire a version: new starts skip/reject it, existing pins stay unchanged,
  reimport does not reactivate it. Restore development status after testing.
- Empty bank/invalid key fails safely, without a file fallback. Production boot
  refuses an empty/invalid bank. Restart still loses sessions until iteration 2.

For offline development set QUESTION_BANK_SOURCE=files. Production defaults to
Supabase and refuses files, so do not copy the files setting from .env.example
unchanged into a deployed API.

Retain staging SQL/grants/import acceptance evidence before launch. Mocked REST
tests do not prove cloud permissions. Migrations/imports/retirements are operator
actions, never automatic startup writes. Roll back app code independently of this
additive table; retire content instead of dropping historical versions.
