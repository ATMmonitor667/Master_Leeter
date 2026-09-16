-- Tombstone first, then irreversibly redact payloads while preserving the
-- append-only event skeleton and original evidence hash.
BEGIN;
ALTER TABLE public.interview_sessions ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX interview_sessions_deleted ON public.interview_sessions (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reject_event_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('master_leeter.redaction', true) = 'on'
     AND NEW.payload = '{"redacted":true}'::jsonb
     AND NEW.session_id = OLD.session_id
     AND NEW.seq = OLD.seq
     AND NEW.occurred_at = OLD.occurred_at
     AND NEW.type = OLD.type
     AND NEW.actor = OLD.actor
     AND NEW.scenario_version_id = OLD.scenario_version_id
     AND NEW.evidence_hash = OLD.evidence_hash
     AND NEW.trace_id = OLD.trace_id
     AND NEW.idempotency_key = OLD.idempotency_key
     AND NEW.client_seq IS NOT DISTINCT FROM OLD.client_seq THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'session_events is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.redact_session_events(target_session UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE affected INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.interview_sessions
    WHERE id = target_session AND deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SESSION_NOT_TOMBSTONED';
  END IF;
  PERFORM set_config('master_leeter.redaction', 'on', true);
  UPDATE public.session_events
  SET payload = '{"redacted":true}'::jsonb
  WHERE session_id = target_session AND payload <> '{"redacted":true}'::jsonb;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
REVOKE ALL ON FUNCTION public.redact_session_events(UUID) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.redact_session_events(UUID) FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
