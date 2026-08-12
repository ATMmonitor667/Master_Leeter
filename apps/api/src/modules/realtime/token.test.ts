import { beforeAll, describe, expect, it } from "vitest";
import { CONTENT_ROOT, buildServer } from "../../index.js";
import { loadScenarioLibrary, scenarioRef } from "../scenario/loader.js";
import type { LoadedScenario } from "../scenario/loader.js";
import {
  DEFAULT_MAX_MINTS_PER_SESSION,
  GeminiTokenMinter,
  MintLimiter,
  RealtimeTokenError,
  constrainedSetup,
  minterFromEnv,
  realtimeWsUrl,
  toModelResource,
  type RealtimeCredential,
  type RealtimeTokenMinter,
} from "./token.js";

/**
 * M3-1 — ephemeral realtime credentials.
 *
 * The acceptance criterion is a negative ("the provider key never reaches the
 * browser"), which is the kind that passes by accident right up until it
 * doesn't. So the key used throughout is a distinctive string and several tests
 * do nothing but search for it in things the client receives.
 */

const KEY = "REAL-SECRET-KEY-must-never-be-sent-to-a-browser";

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** A fetch that records the call and replies with whatever the test wants. */
function fakeFetch(reply: () => Response): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return reply();
  }) as unknown as typeof fetch;

  return { fetch: impl, calls };
}

const ok = (body: unknown = { name: "auth_tokens/ephemeral-abc123" }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function minter(reply: () => Response, opts: { voice?: string; now?: number } = {}) {
  const f = fakeFetch(reply);
  const instance = new GeminiTokenMinter({
    apiKey: KEY,
    model: "gemini-2.5-flash-native-audio-latest",
    ...(opts.voice ? { voice: opts.voice } : {}),
    fetchImpl: f.fetch,
    now: () => opts.now ?? 1_700_000_000_000,
  });
  return { instance, calls: f.calls };
}

describe("the minted token cannot auto-respond", () => {
  /**
   * The reason this module exists beyond key hygiene, and the assertion worth
   * breaking the build over. If the constraint stops being sent, ADR-001 goes
   * back to being a line of client code that a refactor can delete.
   */
  it("burns automaticActivityDetection.disabled into the credential", async () => {
    const { instance, calls } = minter(() => ok());
    await instance.mint();

    const setup = calls[0]?.body["bidiGenerateContentSetup"] as {
      realtimeInputConfig: { automaticActivityDetection: { disabled: boolean } };
    };

    expect(setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);
  });

  /**
   * Pins the wire field name, which a fake-fetch test otherwise cannot notice.
   *
   * The first version of this module sent `liveConnectConstraints` — the SDK's
   * name for this, and the one the published guides use. Every test below was
   * green against it and the API rejects it as an unknown field on both v1beta
   * and v1alpha. `verify:token` is what caught it; this assertion is what stops
   * it coming back quietly.
   */
  it("sends the REST field name, not the SDK's", async () => {
    const { instance, calls } = minter(() => ok());
    await instance.mint();

    expect(calls[0]?.body).toHaveProperty("bidiGenerateContentSetup");
    expect(calls[0]?.body).not.toHaveProperty("liveConnectConstraints");
  });

  it("says so in the credential, so the client can refuse a bad one", async () => {
    const { instance } = minter(() => ok());
    const credential = await instance.mint();
    expect(credential.automaticActivityDetectionDisabled).toBe(true);
  });

  it("constrains the model, so a leaked token cannot drive arbitrary generation", () => {
    const setup = constrainedSetup("gemini-2.5-flash-native-audio-latest");
    expect(setup.model).toBe("models/gemini-2.5-flash-native-audio-latest");
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
  });

  it("carries the voice only when one is configured", () => {
    expect(constrainedSetup("m", "Puck").generationConfig).toHaveProperty("speechConfig");
    expect(constrainedSetup("m").generationConfig).not.toHaveProperty("speechConfig");
  });
});

describe("GeminiTokenMinter", () => {
  it("authenticates with a header, never a query parameter", async () => {
    const { instance, calls } = minter(() => ok());
    await instance.mint();

    const call = calls[0]!;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    // A key in a URL is a key in every proxy log and every error report.
    expect(call.url).not.toContain(KEY);
    expect((call.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
  });

  it("mints single-use tokens", async () => {
    const { instance, calls } = minter(() => ok());
    await instance.mint();
    expect(calls[0]?.body["uses"]).toBe(1);
  });

  it("expires the token, and the start window sooner", async () => {
    const now = 1_700_000_000_000;
    const { instance } = minter(() => ok(), { now });
    const credential = await instance.mint();

    expect(Date.parse(credential.expiresAt)).toBe(now + 600_000);
    expect(Date.parse(credential.sessionExpiresAt)).toBe(now + 60_000);
    // The window to OPEN a session closes long before the session may run.
    expect(Date.parse(credential.sessionExpiresAt)).toBeLessThan(Date.parse(credential.expiresAt));
  });

  it("returns the provider's token name as the credential", async () => {
    const { instance } = minter(() => ok({ name: "auth_tokens/xyz" }));
    expect((await instance.mint()).token).toBe("auth_tokens/xyz");
  });

  it("points at the CONSTRAINED endpoint, which is the one tokens work against", async () => {
    const { instance } = minter(() => ok({ name: "auth_tokens/xyz" }));
    const { wsUrl } = await instance.mint();

    expect(wsUrl).toContain("BidiGenerateContentConstrained");
    expect(wsUrl).toContain("access_token=auth_tokens%2Fxyz");
  });

  it("reports a quota rejection as its own kind, so callers can back off", async () => {
    const { instance } = minter(() => new Response("quota", { status: 429 }));
    await expect(instance.mint()).rejects.toMatchObject({ kind: "RATE_LIMITED" });
  });

  it("keeps the provider's explanation on the error, for the log", async () => {
    const { instance } = minter(
      () => new Response("liveConnectConstraints.config: unknown field", { status: 400 }),
    );
    // A rejected constraint is the likeliest first-run failure and the body is
    // the only thing that says which field.
    await expect(instance.mint()).rejects.toThrow(/unknown field/);
  });

  it("refuses a reply with no token rather than returning an empty credential", async () => {
    const { instance } = minter(() => ok({ notName: "nope" }));
    await expect(instance.mint()).rejects.toMatchObject({ kind: "MALFORMED" });
  });

  it("reports a timeout as a timeout", async () => {
    const boom = (async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;

    const instance = new GeminiTokenMinter({ apiKey: KEY, model: "m", fetchImpl: boom });
    await expect(instance.mint()).rejects.toMatchObject({ kind: "TIMEOUT" });
  });

  it("fails closed with no key, and never calls the provider", async () => {
    const f = fakeFetch(() => ok());
    const instance = new GeminiTokenMinter({ model: "m", fetchImpl: f.fetch });

    expect(instance.configured()).toBe(false);
    await expect(instance.mint()).rejects.toMatchObject({ kind: "NOT_CONFIGURED" });
    expect(f.calls).toHaveLength(0);
  });

  it("normalizes model ids either way round", () => {
    expect(toModelResource("gemini-x")).toBe("models/gemini-x");
    expect(toModelResource("models/gemini-x")).toBe("models/gemini-x");
  });

  it("percent-encodes the token into the socket URL", () => {
    expect(realtimeWsUrl("a/b c")).toContain("access_token=a%2Fb%20c");
  });
});

describe("minterFromEnv", () => {
  it("returns null when voice is unconfigured, rather than a stub that fails later", () => {
    expect(minterFromEnv({})).toBeNull();
    expect(minterFromEnv({ REALTIME_MODEL: "m" })).toBeNull();
    expect(minterFromEnv({ REALTIME_API_KEY: "k" })).toBeNull();
  });

  it("builds a minter when both are present", () => {
    const built = minterFromEnv({ REALTIME_MODEL: "gemini-live", REALTIME_API_KEY: "k" });
    expect(built?.configured()).toBe(true);
    expect(built?.id).toContain("gemini-live");
  });
});

describe("MintLimiter", () => {
  it("permits a realistic number of reconnects and then stops", () => {
    const limiter = new MintLimiter(3);
    expect([limiter.take("s"), limiter.take("s"), limiter.take("s")]).toEqual([true, true, true]);
    expect(limiter.take("s")).toBe(false);
  });

  it("counts per session", () => {
    const limiter = new MintLimiter(1);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("forgets an ended session", () => {
    const limiter = new MintLimiter(1);
    limiter.take("s");
    limiter.forget("s");
    expect(limiter.take("s")).toBe(true);
  });

  it("defaults to a budget that survives a bad afternoon of drops", () => {
    expect(DEFAULT_MAX_MINTS_PER_SESSION).toBeGreaterThanOrEqual(6);
  });
});

// ── Route ────────────────────────────────────────────────────────────────────

let library: Map<string, LoadedScenario>;

beforeAll(async () => {
  library = await loadScenarioLibrary(CONTENT_ROOT);
});

function stubMinter(overrides: Partial<RealtimeCredential> = {}): RealtimeTokenMinter {
  return {
    id: "stub-minter",
    configured: () => true,
    mint: async () => ({
      token: "auth_tokens/ephemeral-abc123",
      wsUrl: realtimeWsUrl("auth_tokens/ephemeral-abc123"),
      model: "models/gemini-live",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      automaticActivityDetectionDisabled: true,
      ...overrides,
    }),
  };
}

function server(realtimeTokenMinter?: RealtimeTokenMinter) {
  return buildServer({ library, ...(realtimeTokenMinter ? { realtimeTokenMinter } : {}) });
}

async function newSession(app: ReturnType<typeof server>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/interview-sessions",
    headers: { "idempotency-key": `rt-${Math.random()}` },
    payload: { scenarioRef: scenarioRef("conveyor-rescan@1") },
  });
  return res.json().sessionId as string;
}

const mint = (app: ReturnType<typeof server>, id: string) =>
  app.inject({ method: "POST", url: `/v1/interview-sessions/${id}/realtime-token` });

describe("POST /v1/interview-sessions/:id/realtime-token", () => {
  it("issues a credential for a live session", async () => {
    const app = server(stubMinter());
    const res = await mint(app, await newSession(app));

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      token: "auth_tokens/ephemeral-abc123",
      automaticActivityDetectionDisabled: true,
    });
    expect(res.json().wsUrl).toContain("BidiGenerateContentConstrained");
  });

  /**
   * The whole point of the issue. A response that carries the real key is not a
   * degraded feature, it is a leaked credential.
   */
  it("never puts the provider key in the response", async () => {
    const f = fakeFetch(() => ok());
    const real = new GeminiTokenMinter({
      apiKey: KEY,
      model: "gemini-live",
      voice: "Puck",
      fetchImpl: f.fetch,
    });

    const app = server(real);
    const res = await mint(app, await newSession(app));

    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(KEY);
    expect(JSON.stringify(res.headers)).not.toContain(KEY);
  });

  it("says 503 when voice is unconfigured, and keeps the interview alive", async () => {
    const app = server();
    const sessionId = await newSession(app);

    expect((await mint(app, sessionId)).statusCode).toBe(503);
    // The rest of the session surface is unaffected by voice being absent.
    const still = await app.inject({ method: "GET", url: `/v1/interview-sessions/${sessionId}` });
    expect(still.statusCode).toBe(200);
  });

  it("404s an unknown session rather than minting an unattached credential", async () => {
    const res = await mint(server(stubMinter()), "00000000-0000-4000-8000-00000000dead");
    expect(res.statusCode).toBe(404);
  });

  it("refuses to mint for an ended session", async () => {
    const app = server(stubMinter());
    const sessionId = await newSession(app);
    await app.inject({ method: "POST", url: `/v1/interview-sessions/${sessionId}/end` });

    expect((await mint(app, sessionId)).statusCode).toBe(409);
  });

  it("caps minting so a client retry loop cannot drain the quota", async () => {
    const app = server(stubMinter());
    const sessionId = await newSession(app);

    for (let i = 0; i < DEFAULT_MAX_MINTS_PER_SESSION; i++) {
      expect((await mint(app, sessionId)).statusCode).toBe(201);
    }

    const capped = await mint(app, sessionId);
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error).toBe("TOKEN_CAP_REACHED");
  });

  it("does not echo provider detail to the browser when minting fails", async () => {
    const failing: RealtimeTokenMinter = {
      id: "failing",
      configured: () => true,
      mint: async () => {
        throw new RealtimeTokenError(
          `auth_tokens responded 400: project ${KEY} is not enabled`,
          "PROVIDER_ERROR",
          400,
        );
      },
    };

    const app = server(failing);
    const res = await mint(app, await newSession(app));

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("REALTIME_MINT_FAILED");
    // The detail is genuinely useful — in the log, not in a browser.
    expect(res.body).not.toContain(KEY);
    expect(res.body).not.toContain("not enabled");
  });
});
