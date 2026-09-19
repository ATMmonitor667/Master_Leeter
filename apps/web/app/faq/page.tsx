import { AccountMenu } from "../../components/AccountMenu";

const items = [
  ["Does it execute my code?", "No. This beta does not require Run or Submit. Any code-quality or correctness grade is a model estimate grounded in the final code and interview evidence, and may be wrong."],
  ["Which devices are supported?", "Use a current desktop Chrome or Edge release with a working microphone and speakers. Other browsers and mobile devices have not completed release acceptance."],
  ["How long is an interview?", "The interview budget is 45 minutes. Preparation happens before the clock. The server owns the deadline, and reconnecting does not start a new interview."],
  ["Will the interviewer constantly talk?", "No. Silence is an application decision. The interviewer speaks only for the oral prompt, an allowed clarification or probe, a bounded hint, a transition, or completion."],
  ["Do the tones change my grade?", "No. Extra nice, Normal and Mean change presentation only. Tone is not a scoring dimension."],
  ["Is this a hiring assessment?", "No. It is deliberate practice. Scores are feedback on one simulated session and are not validated predictions of hiring performance."],
  ["What happens to my data?", "Raw audio is not retained. Resume text expires after 24 hours; completed interview evidence expires after 365 days. You can export or delete it sooner."],
];

export default function FaqPage() {
  return <main className="policy-shell">
    <nav className="history-nav"><a href="/" className="brand"><span className="brand-mark">ML</span><span className="brand-name">Master Leeter</span></a><AccountMenu /></nav>
    <header><div className="eyebrow">Free capped beta</div><h1>What to expect.</h1><p>Clear limits make practice more useful.</p></header>
    <div className="faq-list">{items.map(([question, answer]) => <section key={question}><h2>{question}</h2><p>{answer}</p></section>)}</div>
  </main>;
}
