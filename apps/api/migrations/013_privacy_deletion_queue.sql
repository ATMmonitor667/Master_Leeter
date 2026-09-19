-- Durable privacy work. A request is committed before any store is redacted so
-- process replacement cannot silently abandon a user deletion or retention job.
BEGIN;
CREATE TABLE public.privacy_deletion_requests (
  id uuid PRIMARY KEY,
  dedupe_key text UNIQUE NOT NULL,
  scope text NOT NULL CHECK (scope IN ('SESSION','ACCOUNT')),
  reason text NOT NULL CHECK (reason IN ('USER_REQUEST','RETENTION','RESTORE_REPLAY')),
  user_id text NOT NULL,
  session_ids uuid[] NOT NULL,
  requested_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  receipt jsonb,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((completed_at IS NULL) = (receipt IS NULL)),
  CHECK (scope <> 'SESSION' OR cardinality(session_ids) = 1)
);
CREATE INDEX privacy_deletion_recoverable
  ON public.privacy_deletion_requests(completed_at,lease_expires_at,requested_at)
  WHERE completed_at IS NULL;
CREATE UNIQUE INDEX one_pending_account_deletion
  ON public.privacy_deletion_requests(user_id)
  WHERE scope='ACCOUNT' AND completed_at IS NULL;
ALTER TABLE public.privacy_deletion_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.privacy_deletion_requests FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.privacy_deletion_requests FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.privacy_deletion_requests FROM authenticated;
  END IF;
END $$;
COMMIT;
