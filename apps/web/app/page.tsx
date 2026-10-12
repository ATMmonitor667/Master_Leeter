import Link from "next/link";
import { Navigation, Footer } from "../components/Shell";
import { Icon } from "../components/ui/Icon";
import s from "./Landing.module.css";
export default function Home() {
  return (
    <section className={s.page}>
      <Navigation />
      <header className={s.hero}>
        <div>
          <div className="eyebrow">Voice-first interview practice · Beta</div>
          <h1>
            Think clearly.
            <br />
            Code deliberately.
            <br />
            <span>Practice the room.</span>
          </h1>
          <p>
            A technical interview with space to work. Hear an original problem,
            talk through your reasoning, and leave with evidence you can learn
            from.
          </p>
          <div className={s.actions}>
            <Link href="/start" className="primary-button">
              Start an interview <Icon name="arrow" />
            </Link>
            <a href="#sample" className="secondary-button">
              See sample evidence
            </a>
          </div>
          <div className={s.proof}>
            <span>
              <Icon name="code" />
              Original problems
            </span>
            <span>
              <Icon name="clock" />
              45 minutes
            </span>
            <span>
              <Icon name="notes" />
              Evidence-backed feedback
            </span>
          </div>
        </div>
        <div className={s.room} aria-hidden="true">
          <div className={s.roomHeader}>
            <span>solution.py</span>
            <span>Python</span>
          </div>
          <pre className={s.sampleCode}>
            <span className={s.lineNumber}>01</span> <span>def</span>{" "}
            solve(values):{`\n`}
            <span className={s.lineNumber}>02</span> # Your approach starts
            here.{`\n`}
            <span className={s.lineNumber}>03</span> # No autocomplete. No rush.
            {`\n`}
            <span className={s.lineNumber}>04</span> pass{`\n\n\n`}
          </pre>
          <div className={s.roomHeader}>
            <span className={s.presence}>
              <Icon name="mic" />
              Interviewer listening
            </span>
            <span>38:24</span>
          </div>
          <div className={s.quiet}>Space for your own reasoning.</div>
        </div>
      </header>
      <section className={s.section}>
        <div className="eyebrow">The interview, without the guesswork</div>
        <h2>One room. Three parts.</h2>
        <div className={s.steps}>
          {[
            [
              "01",
              "Hear the problem",
              "The prompt is spoken. Ask questions to clarify the constraints before you code.",
            ],
            [
              "02",
              "Think out loud",
              "Write Python and explain your approach. The interviewer stays quiet while you work.",
            ],
            [
              "03",
              "Get the evidence",
              "Review moments from your session, separate model estimates, and specific practice drills.",
            ],
          ].map(([n, title, copy]) => (
            <article key={n}>
              <span className={s.stepNumber}>{n}</span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>
      <section className={s.section}>
        <div className="eyebrow">Designed for deliberate practice</div>
        <h2>Less assistance. More room to think.</h2>
        <div className={s.truth}>
          {[
            [
              "Silence is intentional.",
              "The application controls when the interviewer speaks. A pause in your explanation is not an invitation to interrupt.",
            ],
            [
              "Original, authored problems.",
              "Clarifications and hints come from reviewed scenario content. You hear the problem for the first time in the room.",
            ],
            [
              "Your code is your work.",
              "An editor without AI autocomplete. Feedback follows the interview, rather than guiding every keystroke.",
            ],
            [
              "Your practice stays yours.",
              "Resume context is optional. You can export or delete interview data, and raw microphone audio is not retained by this application.",
            ],
          ].map(([title, copy]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>
      <section id="sample" className={`${s.section} ${s.evidence}`}>
        <div>
          <div className="eyebrow">Illustrative report fragment</div>
          <h2>Feedback with a reason.</h2>
          <p>
            Reports connect feedback to captured moments. This example
            demonstrates the format; it is not a real user’s session or a
            measured result.
          </p>
          <Link href="/start" className="secondary-button">
            Build your own practice record <Icon name="arrow" />
          </Link>
        </div>
        <blockquote>
          <span className="eyebrow">08:42 · Reasoning evidence</span>
          <p>
            “I’ll compare the single-pass approach with the simpler nested-loop
            version, then check the edge cases.”
          </p>
          <p>
            <strong>Observation</strong>
            <br />
            The candidate explained a trade-off before implementation. A useful
            next drill is to state the time and space costs explicitly.
          </p>
          <cite>
            Synthetic example · AI assessments are estimates, not executed
            tests.
          </cite>
        </blockquote>
      </section>
      <section className={`${s.section} ${s.faq}`}>
        <div className="eyebrow">Before you begin</div>
        <h2>A few things to know.</h2>
        {[
          [
            "Does it execute my code?",
            "This beta provides model-estimated feedback. It does not require a Run or Submit step, and correctness estimates may be wrong.",
          ],
          [
            "What do I need?",
            "A desktop browser, microphone, and speakers. Chrome and Edge are the intended supported browsers; live release acceptance remains in progress.",
          ],
          [
            "Can I skip the resume?",
            "Yes. Resume context is optional, and any extracted facts are yours to review before use.",
          ],
          [
            "When does the clock start?",
            "After preparation, voice connection, and the spoken brief. The server owns the 45-minute interview deadline.",
          ],
        ].map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
        <p>
          <Link href="/faq">
            Read all questions <Icon name="arrow" />
          </Link>
        </p>
      </section>
      <Footer />
    </section>
  );
}
