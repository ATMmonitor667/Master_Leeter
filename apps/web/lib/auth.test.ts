import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), refreshSession: vi.fn(), createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
  mocks.createClient.mockReturnValue({ auth: { getSession: mocks.getSession, refreshSession: mocks.refreshSession } });
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: "first-token" } }, error: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("authenticated browser API calls", () => {
  it("attaches identity while retaining idempotency headers and forbidding redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetcher);
    const { apiFetch } = await import("./auth");
    await apiFetch("/v1/interview-sessions", { method: "POST", headers: { "idempotency-key": "stable" }, body: "{}" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/interview-sessions");
    expect(init.headers.get("authorization")).toBe("Bearer first-token");
    expect(init.headers.get("idempotency-key")).toBe("stable");
    expect(init.redirect).toBe("error");
  });
  it("refreshes once on 401 and retries the same request", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(new Response("{}")); vi.stubGlobal("fetch", fetcher);
    mocks.refreshSession.mockResolvedValue({ data: { session: { access_token: "refreshed" } }, error: null });
    const { apiFetch } = await import("./auth");
    expect((await apiFetch("/v1/me")).status).toBe(200);
    expect(fetcher.mock.calls[1]![1].headers.get("authorization")).toBe("Bearer refreshed");
    expect(mocks.refreshSession).toHaveBeenCalledOnce();
  });
  it("requires sign-in when refresh fails and never loops", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 401 })); vi.stubGlobal("fetch", fetcher);
    mocks.refreshSession.mockResolvedValue({ data: { session: null }, error: new Error("revoked") });
    const { apiFetch } = await import("./auth");
    await expect(apiFetch("/v1/me")).rejects.toThrow("Please sign in");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("never sends tokens to another origin or without a session", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const { apiFetch } = await import("./auth");
    await expect(apiFetch("https://evil.example/steal")).rejects.toThrow("Unexpected API destination");
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    await expect(apiFetch("/v1/me")).rejects.toThrow("Please sign in");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires auth in production even if development is configured", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "development");
    const { authEnabled } = await import("./auth"); expect(authEnabled()).toBe(true);
  });
});
