/**
 * Ephemeral realtime credentials (M3-1).
 *
 * The browser needs to open a WebSocket to Gemini Live. `REALTIME_API_KEY` must
 * never make that trip — a key in client JavaScript is a key in every candidate's
 * devtools, billable against the project until it is rotated.
 *
 * So the server mints a short-lived, single-use token instead. Google's
 * `auth_tokens` endpoint takes the real key and returns a credential the client
 * can hold safely because it expires in minutes and unlocks almost nothing.
 *
 * ── The part that is more than key hygiene ─────────────────────────────────
 *
 * A minted token can carry `bidiGenerateContentSetup`: a model and a connect
 * config that the eventual session is locked to. Whatever the client sends in
 * its own `setup` message, the constraints win.
 *
 * That is where ADR-001 stops being a convention. Until now, "VAD must not
 * auto-create responses" was a line of client setup code that a refactor could
 * drop, and nothing downstream would notice until an interviewer started talking
 * over people. Pinning `automaticActivityDetection.disabled: true` into the
 * credential moves the invariant into the thing the browser is issued: a client
 * that forgets the flag, or a tampered client that deliberately omits it, still
 * cannot obtain a connection that answers on its own. The Response Gate remains
 * the only path to speech because the credential cannot express any other shape.
 *
 * Invariant 1 is now enforced by the credential, not by the caller.
 *
 * ── What this deliberately does not do ─────────────────────────────────────
 *
 * No idempotency key, breaking the convention in `CLAUDE.md` on purpose. A mint
 * is not a mutation of interview state — it produces a credential, and every
 * caller wants a *fresh* one. Replaying an idempotency key after a voice drop
 * would hand back a single-use token that has already been spent, which is the
 * one thing a reconnecting client must not receive. Abuse is bounded by the
 * per-session cap below instead, which is the risk an idempotency key was
 * protecting against here anyway.
 *
 * Nothing is appended to the session event log. A credential is not evidence
 * about a candidate, `EVENT_TYPES` is the frozen M0-3 seam, and widening a
 * contract every lane depends on to record a token mint is a bad trade. Mints
 * are logged at info level (M7-2, as reduced).
 */

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Ephemeral tokens connect to `BidiGenerateContentConstrained`, NOT the
 * `BidiGenerateContent` endpoint the M0-1 spike used with a raw key.
 *
 * Worth stating loudly because the failure is confusing: the unconstrained
 * endpoint rejects a token with an auth error that reads like the token is bad,
 * and the obvious next move — regenerate the token — never helps. M3-2 should
 * build its URL from `realtimeWsUrl` rather than adapting the spike's.
 */
const LIVE_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

/**
 * How long a minted token remains valid.
 *
 * Long enough to survive a candidate fumbling a microphone permission prompt,
 * short enough that a leaked token is worthless by the time anyone finds it in a
 * log. A dropped connection mints a new one; that is cheap and it is the path
 * M7-1's reconnect handling already takes.
 */
export const DEFAULT_TTL_SECONDS = 600;

/**
 * How long the client has to *start* the session.
 *
 * Distinct from the TTL, and the more important of the two. `expireTime` bounds
 * how long an established session may live; `newSessionExpireTime` bounds the
 * window in which the token can open one at all. A token that reaches an
 * attacker after the candidate has connected is already useless.
 */
export const DEFAULT_START_WINDOW_SECONDS = 60;

/**
 * Mints allowed per session.
 *
 * A reconnect loop in the client is the realistic threat, not an attacker — a
 * bad retry that mints on every failed dial can burn a free-tier quota in
 * seconds, and the symptom (voice stops working mid-interview, for everyone)
 * looks nothing like the cause. Generous enough for a session with several
 * genuine drops.
 */
export const DEFAULT_MAX_MINTS_PER_SESSION = 12;

export type RealtimeTokenErrorKind =
  | "NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "MALFORMED";

export class RealtimeTokenError extends Error {
  constructor(
    message: string,
    readonly kind: RealtimeTokenErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RealtimeTokenError";
  }
}

/**
 * What the browser is given.
 *
 * Note what is absent: the API key, the system instruction, and anything drawn
 * from the scenario. The token authorizes a connection; it does not carry
 * interview content (invariant 2).
 */
export interface RealtimeCredential {
  /** The ephemeral token. Safe to send to the browser; useless in ten minutes. */
  token: string;
  /** Endpoint the token is valid against. Constrained variant — see LIVE_WS_BASE. */
  wsUrl: string;
  model: string;
  expiresAt: string;
  /** Deadline for opening the session, not for finishing it. */
  sessionExpiresAt: string;
  /**
   * Echoed so the client can assert what it was issued rather than assume it.
   *
   * M3-2 should refuse to connect if this is ever false: it means something
   * minted a credential that permits the model to answer on its own, and the
   * correct response to that is a loud failure, not a voice session.
   */
  automaticActivityDetectionDisabled: true;
}

export interface RealtimeTokenMinter {
  /** Stable identity for the boot log, mirroring `IntentClassifier.id`. */
  readonly id: string;
  configured(): boolean;
  mint(): Promise<RealtimeCredential>;
}

export interface GeminiTokenMinterOptions {
  apiKey?: string | undefined;
  model: string;
  voice?: string | undefined;
  baseUrl?: string | undefined;
  ttlSeconds?: number | undefined;
  startWindowSeconds?: number | undefined;
  requestTimeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

/** Live API model ids are resource names. `gemini-x` and `models/gemini-x` both arrive here. */
export function toModelResource(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

/**
 * The connect config burned into the token.
 *
 * Exported because it is the enforcement point for ADR-001 and deserves to be
 * asserted directly in tests rather than inferred from a request body. If this
 * function ever stops returning `disabled: true`, silence control has quietly
 * become advisory again.
 *
 * ── Shape, established against the live API rather than the docs ───────────
 *
 * Google's guides call this `liveConnectConstraints` with a nested `config`.
 * That is the SDK's name for it and does not exist on REST — `auth_tokens`
 * rejects it as an unknown field on `v1beta` *and* `v1alpha`. The REST field is
 * `bidiGenerateContentSetup`, and it takes the Live API `setup` message
 * verbatim: `model` at the top, generation options under `generationConfig`,
 * and `realtimeInputConfig` as a sibling — not wrapped in `config`.
 *
 * Both wrong shapes fail as a 400 at mint time, which is loud. Worth knowing
 * anyway, because the docs will send you to the wrong one.
 */
export function constrainedSetup(model: string, voice?: string | undefined) {
  return {
    model: toModelResource(model),
    generationConfig: {
      responseModalities: ["AUDIO"],
      ...(voice
        ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
        : {}),
    },
    // ADR-001, made structural. See the module comment.
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
  };
}

export function realtimeWsUrl(token: string): string {
  return `${LIVE_WS_BASE}?access_token=${encodeURIComponent(token)}`;
}

interface AuthTokenResponse {
  /** The token itself. Google returns it as a resource name; it IS the credential. */
  name?: string;
}

export class GeminiTokenMinter implements RealtimeTokenMinter {
  readonly id: string;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlSeconds: number;
  private readonly startWindowSeconds: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GeminiTokenMinterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.startWindowSeconds = opts.startWindowSeconds ?? DEFAULT_START_WINDOW_SECONDS;
    this.timeoutMs = opts.requestTimeoutMs ?? 5_000;
    this.id = `gemini-live:${opts.model}@v1`;
  }

  configured(): boolean {
    return Boolean(this.opts.apiKey) && Boolean(this.opts.model);
  }

  async mint(): Promise<RealtimeCredential> {
    if (!this.opts.apiKey) {
      throw new RealtimeTokenError("no realtime API key configured", "NOT_CONFIGURED");
    }

    const nowMs = this.now();
    const expiresAt = new Date(nowMs + this.ttlSeconds * 1_000).toISOString();
    const sessionExpiresAt = new Date(nowMs + this.startWindowSeconds * 1_000).toISOString();

    const body = {
      // Single use. A token that opens two sessions is a token that survives
      // being stolen from one of them.
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime: sessionExpiresAt,
      bidiGenerateContentSetup: constrainedSetup(this.opts.model, this.opts.voice),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl ?? DEFAULT_BASE_URL}/auth_tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.opts.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new RealtimeTokenError(`mint exceeded ${this.timeoutMs}ms`, "TIMEOUT");
      }
      throw new RealtimeTokenError((err as Error).message, "PROVIDER_ERROR");
    }

    if (res.status === 429) {
      throw new RealtimeTokenError("realtime token quota exhausted", "RATE_LIMITED", 429);
    }
    if (!res.ok) {
      // The provider's body often explains a rejected constraint precisely, and
      // that detail belongs in our log — never in the reply, which is on its way
      // to a browser.
      throw new RealtimeTokenError(
        `auth_tokens responded ${res.status}: ${await safeBody(res)}`,
        "PROVIDER_ERROR",
        res.status,
      );
    }

    let parsed: AuthTokenResponse;
    try {
      parsed = (await res.json()) as AuthTokenResponse;
    } catch {
      throw new RealtimeTokenError("auth_tokens response was not JSON", "MALFORMED");
    }

    const token = parsed.name;
    if (typeof token !== "string" || token.length === 0) {
      throw new RealtimeTokenError("auth_tokens returned no token name", "MALFORMED");
    }

    return {
      token,
      wsUrl: realtimeWsUrl(token),
      model: toModelResource(this.opts.model),
      expiresAt,
      sessionExpiresAt,
      automaticActivityDetectionDisabled: true,
    };
  }
}

/**
 * Per-session mint budget.
 *
 * Counts, never expires an entry on its own — a session's counter is dropped
 * when the session ends, which is the only moment the number stops mattering.
 * A sliding window would be more forgiving of a long session with many genuine
 * drops, and would also forgive the retry loop this exists to catch.
 */
export class MintLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number = DEFAULT_MAX_MINTS_PER_SESSION) {}

  /** True when the mint is permitted. Records the attempt as a side effect. */
  take(sessionId: string): boolean {
    const used = this.counts.get(sessionId) ?? 0;
    if (used >= this.max) return false;
    this.counts.set(sessionId, used + 1);
    return true;
  }

  used(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }

  forget(sessionId: string): void {
    this.counts.delete(sessionId);
  }
}

/** Truncated: a provider error body is diagnostic, not something to store whole. */
async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}

/**
 * Build from environment, or return null.
 *
 * Null rather than a throwing stub, and rather than a fake that mints nothing:
 * there is no useful degraded voice session, so the route answers 503 and says
 * why. Same posture as the runner — a missing dependency costs a capability, not
 * the service (M2-4).
 */
export function minterFromEnv(env: NodeJS.ProcessEnv = process.env): RealtimeTokenMinter | null {
  const model = env["REALTIME_MODEL"];
  const apiKey = env["REALTIME_API_KEY"];
  if (!model || !apiKey) return null;

  return new GeminiTokenMinter({
    apiKey,
    model,
    voice: env["REALTIME_VOICE"],
    ...(env["REALTIME_TOKEN_TTL_SECONDS"]
      ? { ttlSeconds: Number(env["REALTIME_TOKEN_TTL_SECONDS"]) }
      : {}),
  });
}
