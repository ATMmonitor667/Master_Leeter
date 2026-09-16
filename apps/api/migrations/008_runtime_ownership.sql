-- Private runtime ownership. Random fencing tokens are replaced on every claim.
CREATE TABLE public.session_runtime_owners (
  session_id uuid PRIMARY KEY REFERENCES public.interview_sessions(id),
  token uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.session_runtime_owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_runtime_owners FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.session_runtime_owners FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.session_runtime_owners FROM authenticated;
  END IF;
END $$;
