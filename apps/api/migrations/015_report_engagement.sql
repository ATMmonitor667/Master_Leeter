-- First candidate view is enough to measure report engagement. It stays on the
-- deletable report cache and never creates a separate user tracking record.
BEGIN;
ALTER TABLE public.session_reports ADD COLUMN viewed_at timestamptz;
CREATE INDEX session_reports_viewed ON public.session_reports(viewed_at)
  WHERE viewed_at IS NOT NULL;
COMMIT;
