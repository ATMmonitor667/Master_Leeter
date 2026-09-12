# Authentication setup and acceptance

Implemented in iteration I02a on `codex/production-02-auth-storage`, based on the
question-bank commit `d1c9354`. This is an access-control release, not a public
launch: session, event, consent, ticket and report state still lives in one API
process. I02b supplies durable storage and restart/multiple-process recovery.

## What works

- Email-code sign-in through the official Supabase browser SDK, session refresh,
  sign-out, and protected interview/report pages. Node 22+ is required by the SDK.
- API bearer verification through Supabase Auth `/auth/v1/user`; verified UUID
  and token expiry, anonymous/revoked/expired credentials rejected. Browser
  session data and x-user-id never authorize secure API calls.
- Ownership checks before HTTP/voice/report/export/deletion actions. Unknown
  sessions and another user's sessions both return 404. Expensive report
  regeneration is operator-only and unavailable to ordinary users.
- Each editor connection obtains a random ticket through authenticated HTTP.
  Tickets expire after 30 seconds, bind to one user/session and can be consumed
  once. New tickets replace unused ones for that user/session. Socket lifetime
  ends at the bearer expiry (or 55 minutes), then the browser obtains a new ticket.
- Only the configured WEB_ORIGIN can open secure sockets. Each frame must match
  its socket's session ID. Frames are ordered, with a bounded pending queue and
  payload size. HTTP APIs accept credentials only in Authorization, not URLs.
- Request logs omit queries and redact auth/cookie headers. Private responses
  use no-store. Exports retain candidate data and event metadata but omit private
  interviewer/system payloads. End active sessions before deleting practice data.
- Production API startup refuses development auth or absent auth configuration;
  production browser pages require sign-in regardless of development flags.

## Owner setup

Use the same development Supabase project as the question bank. No new service
account, real sign-in, email or cloud configuration was created by this change.

1. Enable email authentication and configure the **Magic Link** email template
   to send the code with `{{ .Token }}`. The login UI verifies a code; the default
   clickable magic-link template alone is insufficient. Follow
   [Supabase email OTP setup](https://supabase.com/docs/guides/auth/auth-email-passwordless#with-otp).
2. Configure the intended Site URL / allowed redirects and project email rate
   limits. Use a production email sender before opening registration beyond test
   accounts. Set project signup policy for your intended pilot; the form requests
   signup for new emails but the project's policy remains authoritative.
3. Set these in ignored `apps/api/.env.local`:

   ```dotenv
   AUTH_MODE=supabase
   SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
   WEB_ORIGIN=http://localhost:3000
   ```

   Preserve QUESTION_BANK_SOURCE and the separate server secret from iteration 1.
   For identity verification use the public publishable key (legacy anon JWT is
   supported); never a service-role or secret key in frontend configuration.
4. Set these in ignored `apps/web/.env.local` (Next reads this file):

   ```dotenv
   NEXT_PUBLIC_AUTH_MODE=supabase
   NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
   NEXT_PUBLIC_API_URL=http://localhost:4000
   NEXT_PUBLIC_WS_URL=ws://localhost:4000
   ```

   API and browser must use the same project. Use HTTPS/WSS and the exact deployed
   web origin in staging. NEXT_PUBLIC values are compiled at build time, so
   changing them on the host requires rebuilding the frontend. Elevated service
   keys remain API-only. Do not paste any secrets into chat or commits.
5. Start API/web, open `/login`, and complete sign-in yourself with a test email.
   No live credentials are required for unit or socket integration tests.

## Acceptance still requiring your project

Local verification: 832 tests pass across the full suite and targeted transport
tests; TypeScript and the production build pass. Browser QA covered desktop and
390px mobile sign-in layout (no horizontal overflow) and recoverable email-service
failure using a local placeholder endpoint. Real OTP delivery/verification and
authenticated provider sessions were not exercised.

- Code delivery/verification, signup policy, resend/error states, expiry and
  refresh with actual Supabase credentials; reload and sign-out in another tab.
- Two separate browser accounts: session URLs, voice tokens/tools, reports,
  exports, deletion, socket-ticket requests and forged socket frames must reject
  access to the other account's interview.
- Let an access token expire during an interview; verify a fresh ticket, socket
  reconnection and pending-code delivery. Try a reused ticket and wrong Origin.
- End an interview; confirm reports/export are owned and no interviewer wording
  appears in exported event payloads; delete ended practice data.

Implementation reference: [Supabase getUser](https://supabase.com/docs/reference/javascript/auth-getuser),
[verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp).

## Remaining I02 work

Authentication is implemented; durable sessions/events/consent/reports, atomic
finalization/deletion, cross-process ticket/session coordination, replay and
recovery are not. Access tokens already issued may stay valid until expiry after
sign-out; socket expiry is bounded and browser sign-out unmounts the workspace.
Do not claim immediate global revocation of every existing provider credential.
Account deletion here removes practice data/consents, not the Supabase Auth user.
Full account erasure and worker cancellation belong to the durable lifecycle pass.

Offline local development can use AUTH_MODE=development with
NEXT_PUBLIC_AUTH_MODE=development; that mode intentionally preserves test
fixtures and placeholder identity. It is refused by production API startup.
