-- Apply AFTER 001_init.sql using the migration owner in a disposable DB first.
-- Legacy rows remain NULL: never invent a pin or collapse historical identities.
BEGIN;
ALTER TABLE public.interview_sessions ADD COLUMN idempotency_key TEXT;
ALTER TABLE public.interview_sessions ADD COLUMN scenario_snapshot JSONB;
ALTER TABLE public.interview_sessions ADD CONSTRAINT session_user_idempotency
  UNIQUE (user_id, idempotency_key);
ALTER TABLE public.interview_sessions ADD CONSTRAINT nonnegative_paused_seconds
  CHECK (paused_seconds >= 0);

CREATE FUNCTION public.preserve_session_pin() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.scenario_version_id IS DISTINCT FROM OLD.scenario_version_id
     OR NEW.scenario_hash IS DISTINCT FROM OLD.scenario_hash
     OR NEW.scenario_snapshot IS DISTINCT FROM OLD.scenario_snapshot
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.policy IS DISTINCT FROM OLD.policy THEN
    RAISE EXCEPTION 'session identity and scenario pin are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_session_pin BEFORE UPDATE ON public.interview_sessions
  FOR EACH ROW EXECUTE FUNCTION public.preserve_session_pin();

-- These tables contain private code/transcripts and full scenario evidence.
-- Direct browser access is forbidden. The backend uses a dedicated trusted
-- role; provisioning that role and its minimal grants is an integration gate.
ALTER TABLE public.interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.interview_sessions, public.session_events, public.session_reports FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON public.interview_sessions, public.session_events, public.session_reports FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
