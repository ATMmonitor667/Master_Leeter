-- Shared single-use WebSocket credentials. Tokens are stored only as SHA-256
-- hashes and are never readable by browser roles.
BEGIN;
CREATE TABLE public.socket_tickets (
  token_hash           TEXT PRIMARY KEY,
  session_id           UUID NOT NULL REFERENCES public.interview_sessions(id),
  user_id              TEXT NOT NULL,
  principal_expires_at TIMESTAMPTZ NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT socket_ticket_expiry_order CHECK (expires_at <= principal_expires_at),
  CONSTRAINT one_pending_socket_ticket UNIQUE (session_id, user_id)
);
CREATE INDEX socket_tickets_expiry ON public.socket_tickets (expires_at);
ALTER TABLE public.socket_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.socket_tickets FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON public.socket_tickets FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
