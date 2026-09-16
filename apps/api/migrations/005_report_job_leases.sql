-- Fenced report workers. An expired claimant may be replaced; its late result
-- cannot overwrite the replacement because completion matches lease_token.
BEGIN;
ALTER TABLE public.session_reports ADD COLUMN lease_token UUID;
ALTER TABLE public.session_reports ADD COLUMN lease_expires_at TIMESTAMPTZ;
ALTER TABLE public.session_reports ADD CONSTRAINT report_lease_pair
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));
CREATE INDEX session_reports_claimable
  ON public.session_reports (status, lease_expires_at);
COMMIT;
