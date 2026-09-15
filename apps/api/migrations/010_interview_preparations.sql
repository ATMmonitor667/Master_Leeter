-- Private, retry-safe interview preparation. Raw resumes never enter the
-- append-only session event log and can be erased independently.
BEGIN;
ALTER TABLE public.interview_sessions
  ADD COLUMN interviewer_tone text NOT NULL DEFAULT 'NORMAL'
  CHECK (interviewer_tone IN ('EXTRA_NICE','NORMAL','MEAN'));

-- Extend the existing immutable session pin to the preparation-owned settings.
CREATE OR REPLACE FUNCTION public.preserve_session_pin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.scenario_version_id IS DISTINCT FROM OLD.scenario_version_id
     OR NEW.scenario_hash IS DISTINCT FROM OLD.scenario_hash
     OR NEW.scenario_snapshot IS DISTINCT FROM OLD.scenario_snapshot
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.policy IS DISTINCT FROM OLD.policy
     OR NEW.expected_seconds IS DISTINCT FROM OLD.expected_seconds
     OR NEW.interviewer_tone IS DISTINCT FROM OLD.interviewer_tone THEN
    RAISE EXCEPTION 'session identity and scenario pin are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE public.interview_preparations (
  id                    uuid PRIMARY KEY,
  user_id               text NOT NULL,
  idempotency_key       text NOT NULL,
  tone                  text NOT NULL CHECK (tone IN ('EXTRA_NICE','NORMAL','MEAN')),
  status                text NOT NULL CHECK (status IN ('ANALYZING','REVIEW','CONFIRMED','READY','DELETED')),
  consented_at          timestamptz NOT NULL,
  notice_version        text NOT NULL,
  resume_text           text,
  resume_expires_at     timestamptz NOT NULL,
  analysis              jsonb,
  analysis_token        uuid,
  analysis_started_at   timestamptz,
  confirmed_fact_ids    jsonb NOT NULL DEFAULT '[]'::jsonb,
  scenario_version_id   text,
  scenario_hash         text,
  restatement           jsonb,
  restatement_token     uuid,
  restatement_started_at timestamptz,
  session_id            uuid UNIQUE REFERENCES public.interview_sessions(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id,idempotency_key),
  CHECK ((scenario_version_id IS NULL) = (scenario_hash IS NULL)),
  CHECK ((analysis_token IS NULL) = (analysis_started_at IS NULL)),
  CHECK ((restatement_token IS NULL) = (restatement_started_at IS NULL)),
  CHECK (jsonb_typeof(confirmed_fact_ids) = 'array'),
  CHECK (status <> 'READY' OR (scenario_version_id IS NOT NULL AND restatement IS NOT NULL AND session_id IS NOT NULL)),
  CHECK (status <> 'DELETED' OR (resume_text IS NULL AND analysis IS NULL AND confirmed_fact_ids = '[]'::jsonb))
);
CREATE INDEX interview_preparations_user ON public.interview_preparations(user_id,created_at DESC);

CREATE FUNCTION public.preserve_preparation_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.consented_at IS DISTINCT FROM OLD.consented_at
     OR NEW.notice_version IS DISTINCT FROM OLD.notice_version
     OR NEW.resume_expires_at IS DISTINCT FROM OLD.resume_expires_at
     OR (OLD.scenario_version_id IS NOT NULL AND NEW.scenario_version_id IS DISTINCT FROM OLD.scenario_version_id)
     OR (OLD.scenario_hash IS NOT NULL AND NEW.scenario_hash IS DISTINCT FROM OLD.scenario_hash)
     OR (OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id) THEN
    RAISE EXCEPTION 'preparation identity and pins are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_preparation_identity BEFORE UPDATE ON public.interview_preparations
  FOR EACH ROW EXECUTE FUNCTION public.preserve_preparation_identity();

ALTER TABLE public.interview_preparations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.interview_preparations FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON public.interview_preparations FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
