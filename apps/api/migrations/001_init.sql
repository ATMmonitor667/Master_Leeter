-- Master_Leeter initial schema.
--
-- Design notes that are not obvious from the DDL:
--
--  * session_events has NO update or delete path. Grant only INSERT and SELECT
--    to the application role. Append-only enforced by the database is worth more
--    than append-only enforced by discipline (invariant 8).
--
--  * seq is assigned server-side and unique per session. The unique constraint
--    is the thing that actually guarantees ordering under concurrent appends;
--    application-level counters race.
--
--  * scenario_version_id is a pinned string, not a foreign key. Scenarios live
--    in version control, not in Postgres, and a retired version must remain
--    referenceable forever (invariant 4).

CREATE TABLE IF NOT EXISTS interview_sessions (
    id                  UUID PRIMARY KEY,
    user_id             TEXT        NOT NULL,
    scenario_version_id TEXT        NOT NULL,
    scenario_hash       TEXT        NOT NULL,
    mode                TEXT        NOT NULL CHECK (mode IN ('LEARNING', 'MOCK', 'STRICT')),
    policy              JSONB       NOT NULL,
    state               TEXT        NOT NULL,
    language            TEXT        NOT NULL DEFAULT 'python',
    trace_id            TEXT        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    expected_seconds    INTEGER     NOT NULL,
    -- Accumulated pause time, so a voice drop does not eat the candidate's clock.
    paused_seconds      INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON interview_sessions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_events (
    session_id          UUID        NOT NULL REFERENCES interview_sessions (id),
    seq                 INTEGER     NOT NULL,
    occurred_at         TIMESTAMPTZ NOT NULL,
    type                TEXT        NOT NULL,
    actor               TEXT        NOT NULL CHECK (actor IN ('CANDIDATE', 'INTERVIEWER', 'SYSTEM')),
    scenario_version_id TEXT        NOT NULL,
    payload             JSONB       NOT NULL,
    evidence_hash       TEXT        NOT NULL,
    trace_id            TEXT        NOT NULL,
    idempotency_key     TEXT        NOT NULL,
    PRIMARY KEY (session_id, seq)
);

-- Makes blind retry after reconnect safe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
    ON session_events (session_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_events_type ON session_events (session_id, type);

-- Belt and braces: refuse mutation at the database, not just in the repository.
CREATE OR REPLACE FUNCTION reject_event_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'session_events is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_no_update ON session_events;
CREATE TRIGGER trg_events_no_update
    BEFORE UPDATE OR DELETE ON session_events
    FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE IF NOT EXISTS session_reports (
    session_id   UUID PRIMARY KEY REFERENCES interview_sessions (id),
    rubric_id    TEXT        NOT NULL,
    status       TEXT        NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED')),
    -- Regenerable from events after a rubric change, so this is a cache, not a source of truth.
    body         JSONB,
    error        TEXT,
    attempts     INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);
