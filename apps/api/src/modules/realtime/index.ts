/**
 * Realtime module (M3).
 *
 * Credential issuance, the interviewer persona, and the voice agent's tool
 * surface — the whole boundary between this system and the realtime provider.
 * Not an HTTP module: the session module owns the routes, the same way it calls
 * into the orchestrator rather than the other way round.
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

export {
  DEFAULT_INTERVIEWER_VOICE,
  INTERVIEWER_PERSONA,
  PERSONA_PROHIBITIONS,
} from "./persona.js";

export {
  VOICE_TOOLS,
  executeVoiceTool,
  type ToolRefusal,
  type ToolResult,
  type VoiceToolContext,
  type VoiceToolDeps,
  type VoiceToolName,
} from "./tools.js";
