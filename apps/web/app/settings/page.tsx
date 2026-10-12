"use client";
import styles from "../Screens.module.css";
import { Navigation, Footer } from "../../components/Shell";
import { useEffect, useState } from "react";
import { AccountMenu } from "../../components/AccountMenu";
import { apiFetch, SignInRequired } from "../../lib/api-client";

import { usePreferences } from "../../components/Preferences";

interface DeletionReceipt {
  sessionIds: string[];
  eventsRedacted: number;
  reportsDeleted: number;
  unreachable: string[];
}

export default function SettingsPage() {
  const {
    theme,
    setTheme,
    fontSize,
    setFontSize,
    readCaptions,
    setReadCaptions,
  } = usePreferences();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);
  const [accountConfirmation, setAccountConfirmation] = useState("");
  const [preview, setPreview] = useState<{
    sessions: number;
    completed: number;
    active: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let cursor: string | null = null;
        let total = 0,
          completed = 0;
        do {
          const response = await apiFetch(
            "/v1/interview-sessions?" +
              new URLSearchParams({
                limit: "20",
                ...(cursor ? { cursor } : {}),
              }),
          );
          if (!response.ok) throw new Error("Unavailable");
          const page = (await response.json()) as {
            sessions: Array<{ endedAt: string | null }>;
            nextCursor: string | null;
          };
          total += page.sessions.length;
          completed += page.sessions.filter((item) => item.endedAt).length;
          cursor = page.nextCursor;
          if (!active) return;
        } while (cursor);
        setPreview({ sessions: total, completed, active: total - completed });
      } catch {
        if (active) setPreviewError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function erasePracticeData() {
    if (confirmation !== "DELETE") return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/v1/privacy/account", {
        method: "DELETE",
      });
      const result = (await response
        .json()
        .catch(() => ({}))) as DeletionReceipt & { error?: string };
      if (!response.ok) {
        const message =
          result.error === "END_SESSION_BEFORE_DELETION"
            ? "Finish your active interview before erasing all practice data."
            : (result.error ?? `Deletion failed (${response.status}).`);
        throw new Error(message);
      }
      setReceipt(result);
      setConfirmation("");
    } catch (cause) {
      if (cause instanceof SignInRequired)
        window.location.replace("/login?next=%2Fsettings");
      else
        setError(cause instanceof Error ? cause.message : "Deletion failed.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    if (accountConfirmation !== "DELETE ACCOUNT") return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/v1/privacy/account/identity", {
        method: "DELETE",
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        const message =
          result.error === "END_SESSION_BEFORE_DELETION"
            ? "Finish your active interview before deleting your account."
            : result.error === "ACCOUNT_DELETION_PENDING"
              ? "Practice-data deletion is still being completed. Please retry account deletion shortly."
              : "Account deletion is temporarily unavailable. Please retry.";
        throw new Error(message);
      }
      const { authClient } = await import("../../lib/auth");
      await authClient().auth.signOut({ scope: "local" });
      window.location.replace("/");
    } catch (cause) {
      if (cause instanceof SignInRequired)
        window.location.replace("/login?next=%2Fsettings");
      else
        setError(
          cause instanceof Error ? cause.message : "Account deletion failed.",
        );
      setBusy(false);
    }
  }

  return (
    <section className={styles.page}>
      <Navigation />
      <div className="settings-shell">
        <nav className="history-nav">
          <a href="/" className="brand">
            <span className="brand-mark">ML</span>
            <span className="brand-name">Master Leeter</span>
          </a>
          <AccountMenu />
        </nav>
        <header className="settings-heading">
          <div className="eyebrow">Your workspace</div>
          <h1>Preferences and privacy</h1>
          <p>
            Export individual interviews from History. Raw microphone audio is
            not retained.
          </p>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <section className="settings-card">
          <h2>Appearance</h2>
          <p>These preferences are saved on this device.</p>
          <fieldset>
            <legend>Colour theme</legend>
            <div className="preference-options">
              {(["dark", "light", "system"] as const).map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="theme"
                    checked={theme === value}
                    onChange={() => setTheme(value)}
                  />
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </label>
              ))}
            </div>
          </fieldset>
          <label htmlFor="editor-font">Editor font size</label>
          <select
            id="editor-font"
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          >
            {[14, 16, 18].map((size) => (
              <option key={size} value={size}>
                {size}px
              </option>
            ))}
          </select>
          <label className="preference-check">
            <input
              type="checkbox"
              checked={readCaptions}
              onChange={(event) => setReadCaptions(event.target.checked)}
            />
            Read final candidate captions with a screen reader
          </label>
          <p>
            Interviewer speech is delivered through audio. Captions show your
            speech.
          </p>
        </section>
        {receipt && (
          <section className="settings-receipt" role="status">
            <h2>Practice data deletion completed</h2>
            <p>
              {receipt.sessionIds.length} interview
              {receipt.sessionIds.length === 1 ? "" : "s"} hidden,{" "}
              {receipt.eventsRedacted} event payloads redacted, and{" "}
              {receipt.reportsDeleted} report
              {receipt.reportsDeleted === 1 ? "" : "s"} removed.
            </p>
            {receipt.unreachable.length > 0 && (
              <p className="settings-warning">
                Some systems could not be reached. Keep this page open and
                contact support before assuming deletion is complete.
              </p>
            )}
            <a className="secondary-button" href="/history">
              Return to history
            </a>
          </section>
        )}
        <section className="settings-card">
          <h2>Erase all practice data</h2>
          <p>
            This removes interview access, candidate-authored event content,
            generated reports, resume preparation data, and stored consent
            history while keeping your sign-in identity.
          </p>
          <p>
            Active interviews must be completed first. This action cannot be
            undone.
          </p>
          <p>
            {preview
              ? `${preview.sessions} interviews in this account: ${preview.completed} completed and ${preview.active} active. Generated reports, resume preparation data, and consent records are included in deletion; their counts are not available in this preview.`
              : previewError
                ? "Interview counts are unavailable. Deletion still applies to all practice data in this account."
                : "Loading the interview counts for this account…"}
          </p>
          <label htmlFor="delete-confirmation">
            Type <strong>DELETE</strong> to confirm
          </label>
          <div className="settings-delete-row">
            <input
              id="delete-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              disabled={busy}
            />
            <button
              className="primary-button destructive-button"
              disabled={busy || confirmation !== "DELETE"}
              onClick={() => void erasePracticeData()}
            >
              {busy ? "Erasing…" : "Erase practice data"}
            </button>
          </div>
        </section>
        <section className="settings-card danger-zone">
          <h2>Delete account</h2>
          <p>
            This first completes the practice-data deletion above, then
            permanently removes your Supabase sign-in identity. It cannot be
            undone.
          </p>
          <label htmlFor="account-delete-confirmation">
            Type <strong>DELETE ACCOUNT</strong> to confirm
          </label>
          <div className="settings-delete-row">
            <input
              id="account-delete-confirmation"
              value={accountConfirmation}
              onChange={(event) => setAccountConfirmation(event.target.value)}
              autoComplete="off"
              disabled={busy}
            />
            <button
              className="primary-button destructive-button"
              disabled={busy || accountConfirmation !== "DELETE ACCOUNT"}
              onClick={() => void deleteAccount()}
            >
              {busy ? "Deleting…" : "Delete account"}
            </button>
          </div>
        </section>
      </div>
      <Footer />
    </section>
  );
}
