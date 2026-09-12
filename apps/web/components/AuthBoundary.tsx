"use client";
import { useEffect, useState, type ReactNode } from "react";
import { authClient, authEnabled } from "../lib/auth";

/** Do not mount microphone/socket/report effects before sign-in. */
export function AuthBoundary({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!authEnabled()) { setReady(true); return; }
    let active = true;
    try {
      const auth = authClient().auth;
      const update = (signedIn: boolean) => {
        if (!active) return;
        setReady(signedIn);
        if (!signedIn) window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      };
      const { data } = auth.onAuthStateChange((_event, session) => update(Boolean(session)));
      void auth.getSession().then(({ data, error: failure }) => update(!failure && Boolean(data.session))).catch(() => {
        if (active) setError("Could not verify sign-in. Please reload and try again.");
      });
      return () => { active = false; data.subscription.unsubscribe(); };
    } catch (cause) { setError((cause as Error).message); }
    return () => { active = false; };
  }, []);
  if (error) return <main className="auth-shell"><div className="setup-card"><h1>Sign-in unavailable</h1><p role="alert">{error}</p><a href="/" className="secondary-button">Back to home</a></div></main>;
  if (!ready) return <main className="auth-shell"><p role="status">Checking your sign-in…</p></main>;
  return children;
}
