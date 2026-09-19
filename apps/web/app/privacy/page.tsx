import { AccountMenu } from "../../components/AccountMenu";

export default function PrivacyPage() {
  return <main className="policy-shell">
    <nav className="history-nav"><a href="/" className="brand"><span className="brand-mark">ML</span><span className="brand-name">Master Leeter</span></a><AccountMenu /></nav>
    <header><div className="eyebrow">Privacy</div><h1>Your interview is private practice.</h1><p>Effective September 17, 2026. This summary describes the free capped beta implemented by this application.</p></header>
    <section><h2>What is processed</h2><p>We process your sign-in identity, finalized speech transcript, code, notes, interview events, optional pasted resume text, extracted resume facts, and generated feedback to run the interview and produce your report. The voice provider processes live microphone audio. Master Leeter does not retain raw microphone audio.</p></section>
    <section><h2>Retention</h2><p>Raw pasted resume text expires after 24 hours and can be erased sooner. Completed interview evidence and reports are automatically tombstoned and redacted after 365 days. Operational deletion records keep pseudonymous account and session identifiers so erased data stays erased after recovery.</p></section>
    <section><h2>AI providers</h2><p>Live voice, classification, resume analysis and grading send only the context required for those features to the configured model provider. Candidate speech and code are treated as data, never as instructions that can change interview or privacy policy.</p></section>
    <section><h2>Your controls</h2><p>History lets you export or erase individual interviews. Settings can erase all practice data while preserving sign-in, or permanently delete both practice data and the Supabase Auth identity. Active interviews must finish before deletion so final writes cannot recreate erased data.</p></section>
    <section><h2>Beta support</h2><p>This is an invite beta. Use the <a href="/support">support page</a> and contact the person who invited you for privacy requests or unresolved deletion receipts. Do not include code, transcripts, credentials or resume text in a support message.</p></section>
  </main>;
}
