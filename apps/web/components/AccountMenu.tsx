"use client";
import { useEffect, useState } from "react";
import { authClient, authEnabled } from "../lib/auth";

export function AccountMenu() {
  const [email, setEmail] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEnabled(authEnabled());
    if (!authEnabled()) return;
    try {
      const { data } = authClient().auth.onAuthStateChange((_event, session) => setEmail(session?.user.email ?? null));
      return () => data.subscription.unsubscribe();
    } catch (cause) { setError((cause as Error).message); }
  }, []);
  if (!enabled) return null;
  return <div className="account-menu">
    {error && <span role="alert">{error}</span>}
    {email ? <><a className="account-link" href="/history">History</a><span className="account-email">{email}</span><button className="ghost-button" onClick={async () => {
      const { error: failure } = await authClient().auth.signOut();
      if (failure) setError("Could not sign out. Please retry.");
      else window.location.assign("/");
    }}>Sign out</button></> : <a className="secondary-button" href="/login">Sign in →</a>}
  </div>;
}
