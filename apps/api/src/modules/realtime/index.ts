/**
 * Realtime module (M3).
 *
 * Credential issuance for the voice path. Not an HTTP module — the session
 * module owns the route, the same way it calls into the orchestrator rather
 * than the other way round.
 *
 * Pure re-exports, deliberately: a barrel with logic in it is a barrel that
 * grows into a second home for the thing it re-exports.
 */

export {
  DEFAULT_MAX_MINTS_PER_SESSION,
  DEFAULT_START_WINDOW_SECONDS,
  DEFAULT_TTL_SECONDS,
  GeminiTokenMinter,
  MintLimiter,
  RealtimeTokenError,
  constrainedSetup,
  minterFromEnv,
  realtimeWsUrl,
  toModelResource,
  type GeminiTokenMinterOptions,
  type RealtimeCredential,
  type RealtimeTokenErrorKind,
  type RealtimeTokenMinter,
} from "./token.js";
