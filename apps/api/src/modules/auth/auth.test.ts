import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, SocketTickets, SupabaseAuthenticator, authenticatorFromEnv } from "./index.js";

const userId = "11111111-1111-4111-8111-111111111111";
const token = (overrides: Record<string, unknown> = {}) => `header.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides })).toString("base64url")}.signature`;
const make = (fetcher: typeof fetch) => new SupabaseAuthenticator({ url: "https://example.supabase.co", publicKey: "sb_publishable_test", fetch: fetcher });
afterEach(() => vi.useRealTimers());

describe("Supabase identity verification", () => {
  it("asks the Auth server and uses only the verified subject", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: userId })));
    expect((await make(fetcher).verify(token())).userId).toBe(userId);
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://example.supabase.co/auth/v1/user");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { apikey: "sb_publishable_test" } });
  });
  it("rejects revoked credentials without echoing provider secrets", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private provider details", { status: 401 }));
    await expect(make(fetcher).verify(token())).rejects.toThrow("UNAUTHORIZED");
  });
  it("fails closed on Auth outage or malformed responses", async () => {
    for (const fetcher of [vi.fn<typeof fetch>().mockRejectedValue(new Error("credential secret")), vi.fn<typeof fetch>().mockResolvedValue(new Response("not json")), vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }))]) {
      await expect(make(fetcher).verify(token())).rejects.toThrow("AUTH_UNAVAILABLE");
    }
  });
  it("rejects expired tokens, subject mismatches and anonymous accounts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ id: userId })));
    for (const jwt of [token({ exp: 1 }), token({ sub: "22222222-2222-4222-8222-222222222222" }), token({ exp: "tomorrow" })]) {
      await expect(make(fetcher).verify(jwt)).rejects.toThrow("UNAUTHORIZED");
    }
    await expect(make(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: userId, is_anonymous: true })))).verify(token())).rejects.toThrow("UNAUTHORIZED");
  });
  it("rejects unsafe endpoints before transmitting credentials", () => {
    for (const url of ["http://example.com", "https://user:password@example.com", "https://example.com/other", "https://example.com/?x=1"]) {
      expect(() => new SupabaseAuthenticator({ url, publicKey: "public" })).toThrow(AuthError);
    }
  });
  it("cannot enable development identity in production or start with missing keys", () => {
    expect(authenticatorFromEnv({ NODE_ENV: "development", AUTH_MODE: "development", ALLOW_INSECURE_DEV: "1" })).toBeUndefined();
    for (const env of [{}, { NODE_ENV: "staging" }, { AUTH_MODE: "development" },
      { NODE_ENV: "development", AUTH_MODE: "development" },
      { NODE_ENV: "production", AUTH_MODE: "development", ALLOW_INSECURE_DEV: "1" },
      { NODE_ENV: "staging", AUTH_MODE: "development", ALLOW_INSECURE_DEV: "1" },
      { NODE_ENV: "production" }, { AUTH_MODE: "typo" }]) {
      expect(() => authenticatorFromEnv(env)).toThrow("AUTH_CONFIGURATION");
    }
  });
  it("defaults to verified identity even without NODE_ENV", () => {
    expect(authenticatorFromEnv({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" })).toBeInstanceOf(SupabaseAuthenticator);
  });
});

describe("socket tickets", () => {
  it("binds to the issuing session and consumes once", () => {
    const tickets = new SocketTickets(() => 100);
    const principal = { userId, expiresAt: 100_000 };
    const key = tickets.issue("room-a", principal);
    expect(tickets.take(key, "room-b")).toBeNull();
    expect(tickets.take(key, "room-a")).toEqual(principal);
    expect(tickets.take(key, "room-a")).toBeNull();
  });
  it("expires after 30 seconds and invalidates superseded pending tickets", () => {
    let now = 100;
    const tickets = new SocketTickets(() => now);
    const principal = { userId, expiresAt: 100_000 };
    const first = tickets.issue("room", principal);
    const second = tickets.issue("room", principal);
    expect(tickets.take(first, "room")).toBeNull();
    now += 30_001;
    expect(tickets.take(second, "room")).toBeNull();
  });
  it("never outlives the bearer token", () => {
    let now = 100;
    const tickets = new SocketTickets(() => now);
    const key = tickets.issue("room", { userId, expiresAt: 200 });
    now = 201;
    expect(tickets.take(key, "room")).toBeNull();
    expect(() => tickets.issue("room", { userId, expiresAt: 200 })).toThrow("UNAUTHORIZED");
  });
});
