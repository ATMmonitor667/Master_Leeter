import styles from "../Screens.module.css";
import { Navigation, Footer } from "../../components/Shell";
import { AccountMenu } from "../../components/AccountMenu";

const items = [
  [
    "Does it execute my code?",
    "When a code sandbox is connected, Run executes your code against the examples. Otherwise the run result is a model prediction and the room labels it as one. Post-interview grades are model estimates grounded in your code and the transcript, and may be wrong.",
  ],
  [
    "Which devices are supported?",
    "Use a current desktop Chrome or Edge release. Voice interviews need a working microphone and speakers; chat interviews need neither. Other browsers and mobile devices have not completed release acceptance.",
  ],
  [
    "How long is an interview?",
    "You choose 30, 45 or 60 minutes. Setup happens before the clock. The server owns the deadline, and reconnecting does not start a new interview.",
  ],
  [
    "Will the interviewer constantly talk?",
    "It is instructed not to. The interviewer is a live voice model told to stay quiet while you think aloud and to answer when you ask it something. It can still misjudge a pause; muting the microphone guarantees silence.",
  ],
  [
    "Do the styles change my grade?",
    "No. Supportive, Neutral and Tough change how the interviewer talks and how many hints you get. Style is not a scoring dimension.",
  ],
  [
    "Do I have to paste a resume?",
    "No. Resume context is optional. If you add it, you review every extracted fact before the interviewer may use it.",
  ],
  [
    "Is this a hiring assessment?",
    "No. It is deliberate practice. Scores are feedback on one simulated session and are not validated predictions of hiring performance.",
  ],
  [
    "What happens to my data?",
    "Audio goes from your browser to the voice provider for the live conversation and is not stored by Master Leeter; the text transcript is. Resume text expires after 24 hours, diagnostic reports after 30 days, and completed interview evidence after 365 days. You can export or delete interview data sooner.",
  ],
];

export default function FaqPage() {
  return (
    <section className={styles.page}>
      <Navigation />
      <div className="policy-shell">
        <nav className="history-nav">
          <a href="/" className="brand">
            <span className="brand-mark">ML</span>
            <span className="brand-name">Master Leeter</span>
          </a>
          <AccountMenu />
        </nav>
        <header data-enter>
          <div className="eyebrow">Free capped beta</div>
          <h1>What to expect.</h1>
          <p>Clear limits make practice more useful.</p>
        </header>
        <div className="faq-list" data-accordion>
          {items.map(([question, answer]) => (
            <details key={question}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
      <Footer />
    </section>
  );
}
