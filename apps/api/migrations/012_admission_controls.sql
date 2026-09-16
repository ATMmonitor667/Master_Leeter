-- Atomic launch admission and distributed expensive-route rate buckets.
BEGIN;

-- This is a backstop even if application admission is accidentally bypassed.
-- Existing duplicate active sessions must be resolved before this migration.
CREATE UNIQUE INDEX one_active_interview_per_user
  ON public.interview_sessions (user_id)
  WHERE ended_at IS NULL AND deleted_at IS NULL;

CREATE TABLE public.api_rate_limits (
  bucket_key text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX api_rate_limits_expiry ON public.api_rate_limits (expires_at);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_rate_limits FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.api_rate_limits FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.api_rate_limits FROM authenticated;
  END IF;
END $$;

COMMIT;
