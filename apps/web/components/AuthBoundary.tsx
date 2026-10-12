"use client";
import { useEffect, useState, type ReactNode } from "react";
import { authEnabled } from "../lib/auth-mode";

/** Do not mount microphone/socket/report effects before sign-in. */
export function AuthBoundary({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!authEnabled()) {
      setReady(true);
      return;
    }
    let active = true;
    let unsubscribe = () => {};
    void import("../lib/auth")
      .then(({ authClient }) => {
        if (!active) return;
        try {
          const auth = authClient().auth;
          const update = (signedIn: boolean) => {
            if (!active) return;
            setReady(signedIn);
            if (!signedIn)
              window.location.replace(
                `/login?next=${encodeURIComponent(window.location.pathname)}`,
              );
          };
          const { data } = auth.onAuthStateChange((_event, session) =>
            update(Boolean(session)),
          );
          void auth
            .getSession()
            .then(({ data, error: failure }) =>
              update(!failure && Boolean(data.session)),
            )
            .catch(() => {
              if (active)
                setError(
                  "Could not verify sign-in. Please reload and try again.",
                );
            });
          unsubscribe = () => data.subscription.unsubscribe();
        } catch (cause) {
          setError((cause as Error).message);
        }
      })
      .catch(() => {
        if (active) setError("Could not verify sign-in. Please retry.");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  if (error)
    return (
      <section className="auth-shell">
        <div className="setup-card">
          <h1>Sign-in unavailable</h1>
          <p role="alert">{error}</p>
          <a href="/" className="secondary-button">
            Back to home
          </a>
        </div>
      </section>
    );
  if (!ready)
    return (
      <section className="auth-shell">
        <p role="status">Checking your sign-in…</p>
      </section>
    );
  return children;
}
