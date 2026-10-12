"use client";
import styles from "../Screens.module.css";
import { Navigation, Footer } from "../../components/Shell";
import { useEffect, useState, type FormEvent } from "react";
import { authEnabled } from "../../lib/auth-mode";
import { EMAIL_RESEND_SECONDS, emailAuthError } from "../../lib/email-auth";

function destination(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next &&
    (/^\/(?:interview|report)\/[a-f0-9-]{36}$/.test(next) ||
      ["/start", "/history", "/settings"].includes(next))
    ? next
    : "/start";
}
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(
      () => setCooldown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [cooldown]);
  useEffect(() => {
    try {
      setEmail(sessionStorage.getItem("ml-login-email") ?? "");
    } catch {}
  }, []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!authEnabled()) {
      window.location.replace("/");
      return;
    }
    try {
      void import("../../lib/auth")
        .then(({ authClient }) => authClient().auth.getSession())
        .then(({ data }) => {
          if (data.session) window.location.replace(destination());
        })
        .catch(() =>
          setMessage("Could not check your sign-in. Please try again."),
        );
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { authClient } = await import("../../lib/auth");
      const auth = authClient().auth;
      if (!sent) {
        const { error } = await auth.signInWithOtp({
          email: email.trim(),
          options: { shouldCreateUser: true },
        });
        if (error) throw new Error(emailAuthError(error));
        setSent(true);
        setCooldown(EMAIL_RESEND_SECONDS);
        try {
          sessionStorage.setItem("ml-login-email", email.trim());
        } catch {}
      } else {
        const { data, error } = await auth.verifyOtp({
          email: email.trim(),
          token: code.trim(),
          type: "email",
        });
        if (error) throw new Error(emailAuthError(error, true));
        if (!data.session) throw new Error("Could not complete sign-in. Please request a new code.");
        window.location.replace(destination());
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.page}>
      <Navigation />
      <div className="auth-shell">
        <a href="/" className="brand">
          <span className="brand-mark">ML</span>Master Leeter
        </a>
        <section className="setup-card auth-card" aria-labelledby="login-title">
          <div className="eyebrow">Your next interview starts here</div>
          <h1 id="login-title">
            {sent
              ? "Check your inbox."
              : "A little practice. A lot more confidence."}
          </h1>
          <p>
            {sent
              ? `Enter the sign-in code sent to ${email}. Check your spam folder too.`
              : "Sign in with an email code to keep your interviews private. No password to remember."}
          </p>
          <form onSubmit={submit} className="auth-form">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              disabled={sent || busy}
              onChange={(event) => setEmail(event.target.value)}
            />
            {sent && (
              <>
                <label htmlFor="code">Sign-in code</label>
                <input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6,10}"
                  minLength={6}
                  maxLength={10}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoFocus
                />
              </>
            )}
            {message && (
              <p role="alert" className="error-banner">
                {message}
              </p>
            )}
            <button className="primary-button" disabled={busy}>
              {busy
                ? "One moment…"
                : sent
                  ? "Continue to Master Leeter →"
                  : "Send my sign-in code →"}
            </button>
            {sent && (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || cooldown > 0}
                  onClick={async () => {
                    setBusy(true);
                    setMessage(null);
                    try {
                      const { authClient } = await import("../../lib/auth");
                      const { error } = await authClient().auth.signInWithOtp({
                        email: email.trim(),
                        options: { shouldCreateUser: true },
                      });
                      if (error) throw new Error(emailAuthError(error));
                      setCooldown(EMAIL_RESEND_SECONDS);
                      setCode("");
                    } catch (error) {
                      setMessage((error as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {cooldown ? `Resend in ${cooldown}s` : "Resend code"}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busy}
                  onClick={() => {
                    setSent(false);
                    setCode("");
                    setMessage(null);
                  }}
                >
                  Use another email
                </button>
              </>
            )}
          </form>
          <p className="auth-caption">
            Your code expires. Only enter it on Master Leeter.
          </p>
        </section>
      </div>
      <Footer />
    </section>
  );
}
