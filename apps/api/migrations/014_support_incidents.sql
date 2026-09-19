-- Privacy-bounded user incident reports. The diagnostic payload is validated
-- against a closed application schema before it reaches this table.
BEGIN;

CREATE TABLE public.support_incidents (
  id uuid PRIMARY KEY,
  idempotency_key uuid NOT NULL,
  user_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES public.interview_sessions(id),
  category text NOT NULL CHECK (category IN ('VOICE','CONNECTION','SAVING','REPORT','OTHER')),
  diagnostics jsonb NOT NULL CHECK (jsonb_typeof(diagnostics) = 'object'),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  resolved_at timestamptz,
  UNIQUE (user_id,idempotency_key),
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
);
CREATE INDEX support_incidents_open_created
  ON public.support_incidents(status,created_at) WHERE status='OPEN';
CREATE INDEX support_incidents_expiry ON public.support_incidents(expires_at);
CREATE INDEX support_incidents_session ON public.support_incidents(session_id);

ALTER TABLE public.support_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_incidents FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.support_incidents FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.support_incidents FROM authenticated;
  END IF;
END $$;

COMMIT;
