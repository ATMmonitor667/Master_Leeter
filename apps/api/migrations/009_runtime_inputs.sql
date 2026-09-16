-- A receipt and its processing obligation commit together. No candidate payload
-- is copied: the immutable event remains the only evidence source.
CREATE TABLE public.runtime_inputs (
  session_id uuid NOT NULL,
  input_seq integer NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (session_id, input_seq),
  FOREIGN KEY (session_id, input_seq) REFERENCES public.session_events(session_id, seq)
);
CREATE INDEX runtime_inputs_pending ON public.runtime_inputs(session_id, input_seq)
  WHERE completed_at IS NULL;
ALTER TABLE public.runtime_inputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_inputs FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.runtime_inputs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.runtime_inputs FROM authenticated;
  END IF;
END $$;

-- Existing checkpoints use this deterministic event-specific key. Missing
-- checkpoints mean uncertain processing, not permission to rerun model calls.
INSERT INTO public.runtime_inputs(session_id,input_seq,completed_at)
SELECT e.session_id,e.seq,c.occurred_at
FROM public.session_events e
LEFT JOIN public.session_events c ON c.session_id=e.session_id
  AND c.type='RUNTIME_CHECKPOINT'
  AND c.idempotency_key='runtime-checkpoint:event:' || e.seq::text
WHERE e.client_seq IS NOT NULL;
