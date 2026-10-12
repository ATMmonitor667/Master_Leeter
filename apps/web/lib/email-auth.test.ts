import { describe, expect, it } from "vitest";
import { EMAIL_RESEND_SECONDS, emailAuthError } from "./email-auth";

describe("email sign-in failure handling", () => {
  it("waits for the default resend interval", () => { expect(EMAIL_RESEND_SECONDS).toBe(60); });
  it.each([
    ["over_email_send_rate_limit", "sending limit"],
    ["over_request_rate_limit", "at least a minute"],
    ["email_address_not_authorized", "not configured"],
    ["email_address_invalid", "email address"],
    ["signup_disabled", "New accounts"],
    ["email_provider_disabled", "unavailable"],
    ["otp_expired", "invalid or expired"],
  ])("explains provider error %s", (code, expected) => { expect(emailAuthError({ code })).toContain(expected); });
  it("handles generic rate limiting", () => { expect(emailAuthError({ status: 429 })).toContain("wait"); });
  it("does not expose unknown provider details", () => {
    expect(emailAuthError({ code: "secret provider details" })).not.toContain("secret provider details");
    expect(emailAuthError({}, true)).toContain("verify");
  });
});
