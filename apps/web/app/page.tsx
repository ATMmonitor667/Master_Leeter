/**
 * Placeholder shell.
 *
 * The candidate workspace (M2-3) replaces this: Monaco, notepad, timer, test
 * panel, and an interviewer status indicator — Listening / Waiting / Speaking.
 *
 * Two rules this page will have to keep:
 *   1. The full problem statement is NEVER rendered. Not in the DOM, not in a
 *      network payload, not in the client bundle. Oral delivery only.
 *   2. No scrolling chat transcript by default — it turns the experience back
 *      into a reading task.
 */
export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "3rem", maxWidth: "42rem" }}>
      <h1>Master_Leeter</h1>
      <p>Voice-first AI technical interview simulator.</p>
      <p>
        Skeleton only. See <code>docs/ISSUES.md</code> — the candidate workspace is M2-3.
      </p>
    </main>
  );
}
