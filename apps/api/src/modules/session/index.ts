/**
 * Session module: the session record and the append-only event log.
 *
 * Storage only. The HTTP routes for an interview live in modules/interview.
 */
export { InMemoryEventLog, evidenceHash, type AppendRequest, type EventLog } from "./event-log.js";
export { PgEventLog, type QueryClient } from "./pg-event-log.js";
export {
  InMemorySessionStore,
  SessionNotFoundError,
  remainingSeconds,
  DEFAULT_INTERVIEW_SECONDS,
  type InterviewSession,
  type SessionStore,
} from "./session-store.js";
export { InMemorySessionLifecycle, type SessionLifecycle } from "./lifecycle.js";
export { INITIAL_STATE, policyFor } from "./policy.js";
