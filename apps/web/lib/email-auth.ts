/** Supabase's default per-address resend interval. */
export const EMAIL_RESEND_SECONDS = 60;

/** Closed messages: never render a provider response or user address as an error. */
export function emailAuthError(error: { code?: string | undefined; status?: number | undefined }, verifying = false): string {
  switch (error.code) {
    case "over_email_send_rate_limit":
      return "The email service has reached its sending limit. Please try again later.";
    case "over_request_rate_limit":
      return "Please wait at least a minute before requesting another code.";
    case "email_address_not_authorized":
      return "The email service is not configured to send to this address. Please contact support.";
    case "email_address_invalid":
    case "validation_failed":
      return "Please check your email address and try again.";
    case "signup_disabled":
      return "New accounts are currently unavailable. Please contact support.";
    case "email_provider_disabled":
      return "Email sign-in is currently unavailable. Please contact support.";
    case "otp_expired":
      return "That code is invalid or expired. Request a new code and use the most recent email.";
    default:
      if (error.status === 429) return "Too many sign-in requests. Please wait before trying again.";
      return verifying
        ? "Could not verify that code. Please try again or request a new code."
        : "Could not send a code. Please try again shortly. If this continues, contact support.";
  }
}
