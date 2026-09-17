"use client";
import { useEffect, useState, type FormEvent } from "react";
import { authClient, authEnabled } from "../../lib/auth";

function destination(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && (/^\/(?:interview|report)\/[a-f0-9-]{36}$/.test(next) || ["/history", "/settings"].includes(next)) ? next : "/#start";
}
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!authEnabled()) { window.location.replace("/"); return; }
    try {
      void authClient().auth.getSession().then(({ data }) => {
        if (data.session) window.location.replace(destination());
      }).catch(() => setMessage("Could not check your sign-in. Please try again."));
    } catch (error) { setMessage((error as Error).message); }
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const auth = authClient().auth;
      if (!sent) {
        const { error } = await auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
        if (error) throw new Error("Could not send a code. Please wait a moment and try again.");
        setSent(true);
      } else {
        const { data, error } = await auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
        if (error || !data.session) throw new Error("That code is invalid or expired. Try again or request a new code.");
        window.location.replace(destination());
      }
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="auth-shell">
    <a href="/" className="brand"><span className="brand-mark">ML</span>Master Leeter</a>
    <section className="setup-card auth-card" aria-labelledby="login-title">
      <div className="eyebrow">Your next interview starts here</div>
      <h1 id="login-title">{sent ? "Check your inbox." : "A little practice. A lot more confidence."}</h1>
      <p>{sent ? `Enter the sign-in code sent to ${email}. Check your spam folder too.` : "Sign in with an email code to keep your interviews private. No password to remember."}</p>
      <form onSubmit={submit} className="auth-form">
        <label htmlFor="email">Email address</label>
        <input id="email" type="email" autoComplete="email" required maxLength={254} value={email} disabled={sent || busy} onChange={(event) => setEmail(event.target.value)} />
        {sent && <><label htmlFor="code">Sign-in code</label><input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" minLength={6} maxLength={10} required value={code} onChange={(event) => setCode(event.target.value)} autoFocus /></>}
        {message && <p role="alert" className="error-banner">{message}</p>}
        <button className="primary-button" disabled={busy}>{busy ? "One moment…" : sent ? "Continue to Master Leeter →" : "Send my sign-in code →"}</button>
        {sent && <button type="button" className="ghost-button" disabled={busy} onClick={() => { setSent(false); setCode(""); setMessage(null); }}>Use another email or request a new code</button>}
      </form>
      <p className="auth-caption">Your code expires. Only enter it on Master Leeter.</p>
    </section>
  </main>;
}
