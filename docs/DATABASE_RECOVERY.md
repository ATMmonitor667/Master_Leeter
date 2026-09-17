# Database backup and isolated recovery

Master Leeter uses Supabase PostgreSQL as its application database. Supabase's
managed backups and point-in-time recovery remain the primary production
recovery controls. These commands create a separate, verifiable `public` schema
archive for release drills and restore it only into an isolated PostgreSQL
database.

This archive does not include Supabase Auth identities, Storage objects,
project settings, secrets, or schemas outside `public`. Keep the matching
Supabase managed-backup policy and provider recovery procedure enabled.

## Prerequisites

- Install `pg_dump`, `pg_restore`, and `psql` from a PostgreSQL client version
  compatible with the Supabase database version.
- Use a direct or session-pooler PostgreSQL connection string. The public
  Supabase URL and publishable key cannot create database backups.
- Choose an absolute `.dump` path outside the repository and its worktrees.
- Store the archive and its `.manifest.json` sidecar in encrypted, access
  controlled storage. Both files are required for verification and restore.
- Run restore drills against a disposable, access-restricted database. Never
  point the restore command at the live database.
- Provision the roles referenced by the source grants in the isolated target.
  Archives preserve grants and revocations, including private-function access;
  a missing role must fail the restore rather than silently discard permissions.

The scripts pass the database password to PostgreSQL through `PGPASSWORD` and
do not print connection strings. Prefer a temporary secret injected by the CI
or hosting secret store rather than saving database URLs in a shell profile.

## Create and verify an archive

Set `BACKUP_DATABASE_URL` to the source database connection string, then run:

```text
npm run db:backup -- C:\secure-backups\master-leeter-2026-09-16.dump
npm run db:backup:verify -- C:\secure-backups\master-leeter-2026-09-16.dump
```

The backup command refuses to overwrite an archive or manifest. The manifest
records the release, byte count, source fingerprint, and SHA-256 digest without
including the database address or credentials. Verification checks the byte
count, streams the checksum, and asks `pg_restore` to read the archive catalogue.

Record the archive location, manifest digest, release identifier, operator,
start/end time, and verification result in the incident or release record.

## Restore drill

Create a fresh isolated database with no public traffic. Set:

```text
RESTORE_DATABASE_URL=postgresql://<user>:<password>@<isolated-host>:5432/<isolated-database>?sslmode=require
RESTORE_CONFIRM_DATABASE=<isolated-database>
RESTORE_ISOLATED_ACK=I_UNDERSTAND_THIS_REPLACES_THE_TARGET
```

Then run:

```text
npm run db:restore -- C:\secure-backups\master-leeter-2026-09-16.dump
```

Restore verifies the manifest before connecting, rejects a destination with the
same fingerprint as the backup source, cleans archive-owned objects inside one
transaction, and checks all current application tables. A successful command is
only database-level evidence. Fingerprints ignore login-user changes but cannot
recognize every DNS alias or direct/pooler address for the same database. The
operator must verify that the target is a separate project/database. Supabase's
default `postgres` database name is supported; template databases are refused.
Before enabling any application against the
restored database:

1. Reconcile every deletion and retention action recorded after the backup.
   The durable, external erasure ledger is still an open production gate, so a
   restored database must remain isolated until that control exists and passes.
2. Apply only forward migrations that are newer than the archive and record
   their exact revisions.
3. Boot the matching API release with admission disabled and run liveness,
   readiness, sign-in, owner-isolation, session replay, and report smoke checks.
4. Confirm that browser roles cannot read private application tables.
5. Record row-count comparisons, checks performed, failures, and the decision to
   discard the drill database or promote a recovery candidate.

## Release rollback boundary

Application rollback and database recovery are separate operations. Prefer
redeploying the last known-good immutable web/API releases while leaving a
forward-compatible database in place. Do not reverse a migration unless a
reviewed migration-specific rollback exists and its data-loss impact is known.
If the database itself must be recovered, keep admission disabled, use Supabase
PITR or an isolated verified archive, reconcile erasures, and complete the smoke
checks above before traffic is restored.
