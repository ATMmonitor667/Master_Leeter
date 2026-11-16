import Link from "next/link";
import { Navigation, Footer } from "../components/Shell";
import { Icon } from "../components/ui/Icon";
import { CognitionCore } from "../components/landing/CognitionCore";
import s from "./Landing.module.css";
export default function Home() {
  return (
    <section className={s.page}>
      <Navigation />
      <header className={s.hero}>
        <div className={s.heroCopy}>
          <div className="eyebrow" data-enter>Voice-first technical interviews · Beta</div>
          <h1 data-enter="1">
            The room
            <br />
            is ready.
            <br />
            <span>Are you?</span>
          </h1>
          <p data-enter="2">
            Hear the problem. Think aloud. Write your solution. Get feedback
            grounded in what actually happened.
          </p>
          <div className={s.actions} data-enter="3">
            <Link href="/start" className="primary-button">
              Enter practice room <Icon name="arrow" />
            </Link>
            <a href="#flow" className="secondary-button">
              Explore the flow
            </a>
          </div>
          <div className={s.proof} data-enter="4">
            <span>
              <Icon name="mic" />
              Voice or chat
            </span>
            <span>
              <Icon name="clock" />
              30, 45 or 60 minutes
            </span>
            <span>
              <Icon name="notes" />
              Feedback after the interview
            </span>
          </div>
          <p className={s.note} data-enter="5">
            Best with sound. Microphone permission is requested only when you
            start a voice interview.
          </p>
        </div>
        <div className={s.stage}>
          <CognitionCore />
        </div>
      </header>
      <section className={s.statement} data-reveal>
        <p>
          You think. <span>The interviewer listens.</span>
        </p>
        <small>
          Talk to it the way you would talk to a person across the table. It
          stays quiet while you work and answers when you ask.
        </small>
      </section>
      <section className={`${s.section} ${s.demo}`}>
        <div data-reveal>
          <div className="eyebrow">Inside the room</div>
          <h2>The editor is the room. The voice stays out of the way.</h2>
          <ul className={s.points}>
            <li>
              <strong>Spoken brief.</strong> The interviewer presents the
              problem out loud. A written card is there too, with an oral-only
              switch for hard mode.
            </li>
            <li>
              <strong>Quiet while you think.</strong> Half-sentences and
              reading code aloud are not questions. Mute the microphone to
              think in complete silence.
            </li>
            <li>
              <strong>It can see your code.</strong> Ask “does this look
              right?” and the answer refers to what is in the editor now.
            </li>
          </ul>
        </div>
        <figure className={s.room} data-card="tilt" data-reveal>
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
            <span className={s.lineNumber}>04</span> pass{`\n\n`}
          </pre>
          <div className={s.roomHeader}>
            <span className={s.presence}>
              <span className={s.bars} aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              Interviewer listening
            </span>
            <span>38:24</span>
          </div>
          <figcaption className={s.quiet}>
            Illustration, not a recording of a real session.
          </figcaption>
        </figure>
      </section>
      <section id="flow" className={s.section}>
        <div className="eyebrow" data-reveal>The interview, without the guesswork</div>
        <h2 data-reveal>One room. Three parts.</h2>
        <div className={s.steps}>
          {[
            [
              "01",
              "Hear the problem",
              "A familiar problem retold as a new story, so you solve it instead of recognising it. Ask questions before you code.",
            ],
            [
              "02",
              "Think aloud and code",
              "Write Python with no AI autocomplete. Run your code against the examples, ask for a hint, or keep going.",
            ],
            [
              "03",
              "Review the evidence",
              "After the interview: a report tied to moments from your session, and a reviewer you can question about it.",
            ],
          ].map(([n, title, copy]) => (
            <article key={n} data-card="tilt" data-reveal>
              <span className={s.stepNumber}>{n}</span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>
      <section className={s.section}>
        <div className="eyebrow" data-reveal>Designed for deliberate practice</div>
        <h2 data-reveal>Less assistance. More room to think.</h2>
        <div className={s.truth}>
          {([
            [
              "mic",
              "A conversation, not a quiz bot.",
              "You speak, it answers, and you can interrupt it. There is no button to hold and no turn to wait for.",
            ],
            [
              "notes",
              "Your problem or ours.",
              "Pick a difficulty from the bank, or paste a problem you are practising. Either way it is reworded for that session only.",
            ],
            [
              "code",
              "Your code is your work.",
              "The interviewer is instructed never to state the algorithm or write code. Hints are limited by the style you choose: supportive, neutral or tough.",
            ],
            [
              "check",
              "No grade during the interview.",
              "Scoring happens afterwards, separately, from the transcript and your code. The live interviewer never gives a score.",
            ],
          ] as const).map(([icon, title, copy]) => (
            <article key={title} data-card="tilt" data-reveal>
              <span className={s.glyph} aria-hidden="true">
                <Icon name={icon} />
              </span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>
      <section id="sample" className={`${s.section} ${s.evidence}`}>
        <div data-reveal>
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
        <blockquote data-card="signal tilt" data-reveal>
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
      <section className={`${s.section} ${s.faq}`} data-accordion>
        <div className="eyebrow">Before you begin</div>
        <h2>A few things to know.</h2>
        {[
          [
            "Does it execute my code?",
            "When a code sandbox is connected, Run executes your code against the examples. Otherwise the result is a model prediction, and the room labels it as one because it may be wrong.",
          ],
          [
            "What do I need?",
            "A desktop browser. Voice interviews need a microphone and speakers; chat interviews need neither. Chrome and Edge are the browsers this beta is tested in.",
          ],
          [
            "Can I skip the resume?",
            "Yes. Resume context is optional, and you confirm each extracted fact before the interviewer may use it.",
          ],
          [
            "Where does my audio go?",
            "From your browser straight to the voice provider for the live conversation. Master Leeter stores the text transcript, your code and run results, not the audio.",
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
      <section className={s.finale} data-card="signal quiet" data-reveal>
        <h2>Ready to practice the room?</h2>
        <Link href="/start" className="primary-button">
          Start an interview <Icon name="arrow" />
        </Link>
        <p>
          <Link href="/privacy">Privacy</Link> · <Link href="/support">Help</Link>
        </p>
      </section>
      <Footer />
    </section>
  );
}
