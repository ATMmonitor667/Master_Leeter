-- Each independent grader checkpoints under the fenced report lease. If the
-- second provider call fails, retrying the job reuses the completed first result
-- rather than charging for it again or allowing a stale worker to overwrite it.
BEGIN;
ALTER TABLE public.session_reports
  ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMIT;
