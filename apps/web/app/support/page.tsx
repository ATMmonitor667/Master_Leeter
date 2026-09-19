import { AccountMenu } from "../../components/AccountMenu";

export default function SupportPage() {
  const email = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
  return <main className="policy-shell">
    <nav className="history-nav"><a href="/" className="brand"><span className="brand-mark">ML</span><span className="brand-name">Master Leeter</span></a><AccountMenu /></nav>
    <header><div className="eyebrow">Beta support</div><h1>Something went wrong?</h1><p>Preserve the interview reference and request ID shown by the app. They let the operator investigate without reading your transcript.</p></header>
    <section><h2>Before contacting support</h2><p>For microphone problems, confirm browser permission, select the intended input, run the speaker check, and reconnect from the interview screen. For a queued report or pending deletion, wait a few minutes and retry once.</p></section>
    <section><h2>Contact</h2>{email
      ? <p>Email <a href={`mailto:${email}`}>{email}</a> with the time, browser version and opaque request/session reference.</p>
      : <p>Contact the person who invited you to the beta and include the time, browser version and opaque request/session reference.</p>}
      <p>Never send passwords, API keys, resume text, source code, transcripts or microphone recordings.</p></section>
    <section><h2>Urgent privacy request</h2><p>Use Settings for data or account deletion. If the app reports a pending or incomplete deletion, stop using the account and contact the beta operator with only the request time and opaque reference.</p></section>
  </main>;
}
