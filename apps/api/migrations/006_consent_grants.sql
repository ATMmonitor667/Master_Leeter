-- Append-only consent decisions. Browser roles never read this table directly;
-- the authenticated API returns only the current per-scope decision.
BEGIN;
CREATE TABLE public.consent_grants (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('TRANSCRIPT','RAW_AUDIO','CALIBRATION')),
  granted        BOOLEAN NOT NULL,
  decided_at     TIMESTAMPTZ NOT NULL,
  notice_version TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consent_grants_user_history
  ON public.consent_grants (user_id, decided_at, id);
ALTER TABLE public.consent_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.consent_grants FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON public.consent_grants FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
