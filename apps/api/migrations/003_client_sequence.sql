-- Persist the browser's event sequence with the evidence it identifies.
-- This makes a fresh API process able to validate the next event without
-- trusting client memory or accepting an older sequence under a new key.
BEGIN;
ALTER TABLE public.session_events
  ADD COLUMN client_seq INTEGER;
ALTER TABLE public.session_events
  ADD CONSTRAINT nonnegative_client_seq CHECK (client_seq IS NULL OR client_seq >= 0);
CREATE UNIQUE INDEX session_events_client_seq
  ON public.session_events (session_id, client_seq)
  WHERE client_seq IS NOT NULL;
COMMIT;
