import { describe, expect, it, vi } from "vitest";
import { WebhookAlertSink } from "./operational-alerts.js";

describe("operational alert delivery", () => {
  it("adds severity/release, keeps the bearer secret out of the body, and refuses redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const sink = new WebhookAlertSink({ url: "https://alerts.example", release: "release1", token: "test-secret", fetch: fetcher,
      now: () => "2026-10-11T12:00:00Z" });
    await sink.publish({ kind: "USER_REPORTED_INCIDENT", incidentId: "incident1", sessionId: "session1", category: "VOICE", requestId: "request1" });
    const init = fetcher.mock.calls[0]![1]!;
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: "Bearer test-secret" });
    expect(JSON.parse(String(init.body))).toMatchObject({ severity: "warning", release: "release1" });
    expect(String(init.body)).not.toContain("test-secret");
  });

  it.each([408, 429, 503])("retries transient HTTP %s and succeeds", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await new WebhookAlertSink({ url: "https://alerts.example", release: "test", fetch: fetcher })
      .publish({ kind: "PRIVACY_MAINTENANCE_UNAVAILABLE", consecutiveFailures: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent failures or expose response bodies/URLs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive response", { status: 403 }));
    await expect(new WebhookAlertSink({ url: "https://secret-destination.example", release: "test", fetch: fetcher })
      .publish({ kind: "REPORT_RECOVERY_UNAVAILABLE", consecutiveFailures: 1 })).rejects.toThrow(/^OPERATIONAL_ALERT_DELIVERY_FAILED$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds network failure retries at three attempts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("sensitive network error"));
    await expect(new WebhookAlertSink({ url: "https://alerts.example", release: "test", fetch: fetcher })
      .publish({ kind: "SESSION_COMPLETION_UNAVAILABLE", consecutiveFailures: 1 })).rejects.toThrow(/^OPERATIONAL_ALERT_DELIVERY_FAILED$/);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
