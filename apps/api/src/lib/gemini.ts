/**
 * Gemini text client — shared by the classifier (M4-1), observer (M5-1), and
 * evaluator (M6-2).
 *
 * One provider across the whole product (ADR-001 picked Gemini Live for voice;
 * the text roles follow so there is a single key, a single vendor outage to
 * reason about, and a single free-tier quota to budget).
 *
 * Deliberately native `generateContent` rather than Google's OpenAI-compatible
 * shim. The reason is `responseSchema`: with a schema the model cannot return an
 * intent outside the enum, which turns "did the model emit valid JSON" from a
 * parsing problem into a non-problem. A classifier that occasionally fails to
 * parse is a classifier that occasionally falls back mid-interview, and that
 * shows up as inconsistent interviewer behaviour rather than an error.
 *
 * Not an SDK dependency. This is one POST with a timeout.
 */

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Distinguishable so callers can decide whether falling back is appropriate. */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly kind: "TIMEOUT" | "RATE_LIMITED" | "HTTP" | "MALFORMED" | "NO_KEY",
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/**
 * Subset of the JSON-Schema dialect Gemini accepts for `responseSchema`.
 *
 * Hand-rolled rather than reusing Zod's JSON-Schema output: Gemini rejects
 * several standard keywords, and a type that only permits what the API accepts
 * catches the mismatch at compile time instead of as a 400 at runtime.
 */
export interface GeminiSchema {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  enum?: readonly string[];
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: readonly string[];
  /** Gemini honours this for output ordering; unordered JSON costs consistency. */
  propertyOrdering?: readonly string[];
  minimum?: number;
  maximum?: number;
  nullable?: boolean;
}

export interface GeminiClientOptions {
  /**
   * Explicit `| undefined` on every optional, because `exactOptionalPropertyTypes`
   * is on and these are pass-through options: a caller forwarding its own
   * possibly-absent config should not have to build the object with conditional
   * spreads. "Absent" and "present but undefined" mean the same thing here.
   */
  apiKey?: string | undefined;
  model: string;
  baseUrl?: string | undefined;
  requestTimeoutMs?: number | undefined;
  /**
   * Injected for tests, and the seam any future provider swap goes through.
   * Signature is deliberately transport-shaped, not Gemini-shaped.
   */
  fetchImpl?: typeof fetch | undefined;
}

export interface GenerateJsonRequest {
  system: string;
  prompt: string;
  schema: GeminiSchema;
  /**
   * 0 disables Gemini 3.x "thinking".
   *
   * The classifier runs on the critical path between a candidate finishing a
   * sentence and the interviewer being allowed to speak, on top of a voice path
   * already measured at p50 ≈ 1.0 s (ADR-001). Thinking tokens are latency the
   * user experiences as a laggy interviewer. Roles that run off the critical
   * path (observer, evaluator) should raise this.
   */
  thinkingBudget?: number;
  temperature?: number;
  maxOutputTokens?: number;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export class GeminiClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiClientOptions) {
    this.timeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.opts.model;
  }

  configured(): boolean {
    return Boolean(this.opts.apiKey) && Boolean(this.opts.model);
  }

  /**
   * One structured-output call. Returns parsed JSON or throws `GeminiError`.
   *
   * Every failure is typed rather than swallowed. Callers that must not block —
   * the classifier — catch and degrade; callers that can afford to retry — the
   * evaluator — can branch on `kind`.
   */
  async generateJson<T>(req: GenerateJsonRequest): Promise<T> {
    if (!this.opts.apiKey) throw new GeminiError("no Gemini API key configured", "NO_KEY");

    const url = `${this.opts.baseUrl ?? DEFAULT_BASE_URL}/models/${encodeURIComponent(
      this.opts.model,
    )}:generateContent`;

    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        // Determinism first. The same transcript classified twice must give the
        // same answer, or the replay guarantee in replay.test.ts degrades from
        // "reproducible" to "usually reproducible", which is not a guarantee.
        temperature: req.temperature ?? 0,
        responseMimeType: "application/json",
        responseSchema: req.schema,
        ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(req.thinkingBudget !== undefined
          ? { thinkingConfig: { thinkingBudget: req.thinkingBudget } }
          : {}),
      },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
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
        throw new GeminiError(`Gemini request exceeded ${this.timeoutMs}ms`, "TIMEOUT");
      }
      throw new GeminiError((err as Error).message, "HTTP");
    }

    if (res.status === 429) {
      // Free tier is a real constraint, not a theoretical one — see the RPM
      // budget note in the classifier. Typed so callers stop hammering.
      throw new GeminiError("Gemini rate limit exceeded", "RATE_LIMITED", 429);
    }
    if (!res.ok) {
      throw new GeminiError(`Gemini responded ${res.status}`, "HTTP", res.status);
    }

    let parsed: GenerateContentResponse;
    try {
      parsed = (await res.json()) as GenerateContentResponse;
    } catch {
      throw new GeminiError("Gemini response was not JSON", "MALFORMED");
    }

    if (parsed.promptFeedback?.blockReason) {
      throw new GeminiError(
        `Gemini blocked the prompt: ${parsed.promptFeedback.blockReason}`,
        "MALFORMED",
      );
    }

    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string" || text.trim() === "") {
      throw new GeminiError("Gemini returned no content", "MALFORMED");
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      // Should be unreachable with responseSchema set, which is exactly why it
      // is worth surfacing loudly rather than trying to repair the string.
      throw new GeminiError("Gemini returned unparseable JSON despite schema", "MALFORMED");
    }
  }
}

/**
 * Resolve the key for text roles.
 *
 * `GEMINI_API_KEY` is preferred, but one Google AI Studio key serves both Live
 * and text, so falling back to `REALTIME_API_KEY` means the common case needs
 * one variable rather than two identical ones.
 */
export function geminiApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["GEMINI_API_KEY"] ?? env["REALTIME_API_KEY"];
}
