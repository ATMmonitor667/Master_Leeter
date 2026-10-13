"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch, SignInRequired } from "../../lib/api-client";
import { apiUrl } from "../../lib/public-config";
import { startError } from "../../lib/start-error";

/**
 * Session setup.
 *
 * The catalogue shows level, topics, and duration — enough to choose, not enough
 * to prepare. Scenarios are identified by an opaque ref rather than their
 * internal id, because an id like `conveyor-rescan@1` names the problem the
 * candidate is about to hear for the first time.
 */

import { Navigation } from "../../components/Shell";
import { RadioCard, Skeleton } from "../../components/ui/Primitives";
import type { INTERVIEW_MINUTES as ServerMinutes } from "@master-leeter/contracts";
/** Mirrors the server's accepted chat interview lengths. */
const INTERVIEW_MINUTES = [30, 45, 60, 90] as const satisfies typeof ServerMinutes;
import { Icon } from "../../components/ui/Icon";
import styles from "./Setup.module.css";

interface CatalogueEntry {
  ref: string;
  level: string;
  topics: string[];
  expectedMinutes: number;
}

type Tone = "EXTRA_NICE" | "NORMAL" | "MEAN";
interface ResumeFact {
  id: string;
  category: "SKILL" | "PROJECT" | "EXPERIENCE";
  claim: string;
  evidence: string;
}
interface Preparation {
  id: string;
  status: "ANALYZING" | "REVIEW" | "CONFIRMED" | "READY";
  analysis: { summary: string; facts: ResumeFact[] } | null;
  sessionId: string | null;
  confirmedFactIds: string[];
}

const MODES = ["LEARNING", "MOCK", "STRICT"] as const;
const MODE_COPY: Record<(typeof MODES)[number], string> = {
  LEARNING: "More room for hints and a gentler intervention cadence.",
  MOCK: "A balanced, realistic interview with evidence-based feedback.",
  STRICT: "Minimal help, longer silences, and a higher bar for intervention.",
};
const TONES: Array<{ id: Tone; title: string; description: string }> = [
  {
    id: "EXTRA_NICE",
    title: "Extra nice",
    description: "Patient and reassuring, with the same interview rules.",
  },
  {
    id: "NORMAL",
    title: "Normal",
    description: "Neutral, concise, and professional.",
  },
  {
    id: "MEAN",
    title: "Mean",
    description: "Blunt and demanding, without insults or a scoring penalty.",
  },
];

export default function SetupPage() {
  const [step, setStep] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const stepTitle = useRef<HTMLHeadingElement>(null);
  const [scenarios, setScenarios] = useState<CatalogueEntry[]>([]);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [mode, setMode] = useState<(typeof MODES)[number]>("MOCK");
  const [tone, setTone] = useState<Tone>("NORMAL");
  const [format, setFormat] = useState<"VOICE" | "CHAT">("CHAT");
  const [focus, setFocus] = useState<"CODING" | "RESUME" | "COMBINED">("CODING");
  const [minutes, setMinutes] = useState<(typeof INTERVIEW_MINUTES)[number]>(45);
  const [resumeText, setResumeText] = useState("");
  const [consent, setConsent] = useState(false);
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [confirmedFacts, setConfirmedFacts] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const preparationKey = useRef<string | null>(null);
  const sessionKey = useRef<string | null>(null);

  useEffect(() => {
    fetch(apiUrl("/v1/scenarios"), { redirect: "error" })
      .then((r) => {
        if (!r.ok) throw new Error("Catalogue unavailable");
        return r.json();
      })
      .then((d) => {
        const entries = (d.scenarios ?? []) as CatalogueEntry[];
        setScenarios(entries);
        setLoaded(true);
        setSelectedRef((current) =>
          entries.some((entry) => entry.ref === current)
            ? current
            : (entries[0]?.ref ?? null),
        );
      })
      .catch(() => {
        setLoaded(true);
        setError(
          "Could not reach the interview service. Please reload to retry.",
        );
      });
  }, []);

  async function analyzeResume() {
    setStarting(true);
    setError(null);
    try {
      preparationKey.current ??= crypto.randomUUID();
      const res = await apiFetch("/v1/preparations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": preparationKey.current,
        },
        body: JSON.stringify({ resumeText, consent, tone }),
      });
      if (!res.ok) {
        const failure = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          startError(
            failure.error,
            "Resume review could not finish. Please retry.",
          ),
        );
      }
      let next = (await res.json()) as Preparation;
      for (let poll = 0; next.status === "ANALYZING" && poll < 40; poll += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const latest = await apiFetch(`/v1/preparations/${next.id}`);
        if (!latest.ok) throw new Error("Could not read the resume review.");
        next = (await latest.json()) as Preparation;
      }
      if (next.status === "ANALYZING")
        throw new Error("Resume review is still running. Try again shortly.");
      setPreparation(next);
      setConfirmedFacts(
        new Set(next.analysis?.facts.map((fact) => fact.id) ?? []),
      );
      setStarting(false);
    } catch (err) {
      if (err instanceof SignInRequired) {
        window.location.assign("/login");
        return;
      }
      setError((err as Error).message);
      setStarting(false);
    }
  }

  async function startPrepared(scenarioRef: string) {
    if (!preparation) return;
    setStarting(true);
    setError(null);
    try {
      // A previous completion may have succeeded even if its response was lost.
      const latest = await apiFetch(`/v1/preparations/${preparation.id}`);
      if (!latest.ok)
        throw new Error(
          "Could not recover the interview preparation. Please retry.",
        );
      const current = (await latest.json()) as Preparation;
      setPreparation(current);
      if (current.status !== "REVIEW")
        setConfirmedFacts(new Set(current.confirmedFactIds));
      if (current.status === "READY" && current.sessionId) {
        window.location.href = `/interview/${current.sessionId}`;
        return;
      }
      if (current.status === "REVIEW") {
        const reviewed = await apiFetch(
          `/v1/preparations/${current.id}/facts`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmedFactIds: [...confirmedFacts] }),
          },
        );
        if (!reviewed.ok)
          throw new Error(`Resume confirmation failed (${reviewed.status}).`);
        setPreparation((await reviewed.json()) as Preparation);
      } else if (current.status !== "CONFIRMED") {
        throw new Error(
          "Resume review is still running. Please retry shortly.",
        );
      }
      const completed = await apiFetch(
        `/v1/preparations/${preparation.id}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenarioRef, mode, language: "python", format, focus,
            ...(format === "CHAT" ? { durationMinutes: minutes } : {}) }),
        },
      );
      if (!completed.ok) {
        const failure = (await completed.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          startError(
            failure.error,
            "Interview preparation could not finish. Please retry.",
          ),
        );
      }
      const result = (await completed.json()) as Preparation;
      if (!result.sessionId)
        throw new Error("Interview session was not created.");
      window.location.href = `/interview/${result.sessionId}`;
    } catch (err) {
      if (err instanceof SignInRequired) {
        window.location.assign("/login");
        return;
      }
      setError((err as Error).message);
      setStarting(false);
    }
  }

  async function startInterview(scenarioRef: string) {
    if (format === "CHAT" && focus !== "CODING" && (!preparation || !confirmedFacts.size)) {
      setStep(2);
      setError("Review your resume and confirm at least one fact before starting a resume interview.");
      return;
    }
    if (preparation) {
      await startPrepared(scenarioRef);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      sessionKey.current ??= crypto.randomUUID();
      const response = await apiFetch("/v1/interview-sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": sessionKey.current,
        },
        body: JSON.stringify({
          scenarioRef,
          mode,
          language: "python",
          interviewerTone: tone,
          format,
          ...(format === "CHAT" ? { durationMinutes: minutes } : {}),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        sessionId?: string;
        error?: string;
      };
      if (!response.ok || !result.sessionId)
        throw new Error(startError(result.error));
      window.location.href = `/interview/${result.sessionId}`;
    } catch (err) {
      if (err instanceof SignInRequired) {
        window.location.assign("/login");
        return;
      }
      setError(
        err instanceof Error ? err.message : "Interview could not start.",
      );
      setStarting(false);
    }
  }

  async function eraseResume() {
    if (!preparation) return;
    try {
      const res = await apiFetch(`/v1/preparations/${preparation.id}/resume`, {
        method: "DELETE",
      });
      if (!res.ok)
        throw new Error("Could not erase the resume text. Please retry.");
      setResumeText("");
      setError(null);
    } catch (err) {
      if (err instanceof SignInRequired) {
        window.location.assign("/login");
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : "Could not erase the resume text. Please retry.",
      );
    }
  }

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("ml-setup") ?? "{}");
      if (MODES.includes(saved.mode)) setMode(saved.mode);
      if (TONES.some((t) => t.id === saved.tone)) setTone(saved.tone);
      if (typeof saved.ref === "string") setSelectedRef(saved.ref);
      if (saved.format === "VOICE" || saved.format === "CHAT") setFormat(saved.format);
      if (["CODING", "RESUME", "COMBINED"].includes(saved.focus)) setFocus(saved.focus);
      if (INTERVIEW_MINUTES.includes(saved.minutes)) setMinutes(saved.minutes);
    } catch {}
    setPreferencesLoaded(true);
  }, []);
  useEffect(() => {
    if (preferencesLoaded)
      try {
        sessionStorage.setItem(
          "ml-setup",
          JSON.stringify({ mode, tone, ref: selectedRef, format, focus, minutes }),
        );
      } catch {}
  }, [preferencesLoaded, mode, tone, selectedRef, format, focus, minutes]);
  useEffect(() => {
    stepTitle.current?.focus();
  }, [step]);
  const selected =
    scenarios.find((scenario) => scenario.ref === selectedRef) ?? null;
  const titles = [
    "Choose your session",
    "Set the room",
    "Add context, if you want",
  ];
  return (
    <section className={styles.page}>
      <Navigation />
      <header className={styles.heading}>
        <div className="eyebrow">Before the clock starts</div>
        <h1>Your next 45 minutes.</h1>
        <p>
          A few choices, then space to think. Preparation doesn’t use interview
          time.
        </p>
      </header>
      <div className={styles.layout}>
        <div>
          <ol className={styles.steps} aria-label="Interview setup steps">
            {["Session", "Room", "Context"].map((name, index) => (
              <li key={name}>
                <button
                  type="button"
                  aria-current={step === index ? "step" : undefined}
                  onClick={() => setStep(index)}
                  disabled={starting}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {name}
                </button>
              </li>
            ))}
          </ol>
          <div className={styles.card}>
            <h2 ref={stepTitle} tabIndex={-1}>
              {titles[step]}
            </h2>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            {step === 0 && (
              <>
              <fieldset className={styles.fieldset}>
                <legend>Interview format</legend>
                <div className={styles.radios}>
                  {(["CHAT", "VOICE"] as const).map((item) => <RadioCard key={item}
                    name="format" title={item === "CHAT" ? "Chat interviewer" : "Voice interviewer"}
                    description={item === "CHAT" ? "Read, ask questions, and submit your thoughts. No microphone needed." : "Speak with the interviewer and think aloud."}
                    checked={format === item} disabled={starting || preparation?.status === "READY"}
                    onChange={() => { setFormat(item); sessionKey.current = null; }} />)}
                </div>
              </fieldset>
              {format === "CHAT" && <fieldset className={styles.fieldset}>
                <legend>What would you like to practice?</legend>
                <div className={styles.radios}>
                  {([
                    ["CODING", "Coding", "Discuss a problem, explain your approach, and write code."],
                    ["RESUME", "Resume", "Questions about your projects, experience, and technical decisions."],
                    ["COMBINED", "Resume + coding", "Start with your experience, then move to a coding problem."],
                  ] as const).map(([item, title, description]) => <RadioCard key={item} name="focus"
                    title={title} description={description} checked={focus === item}
                    disabled={starting || preparation?.status === "READY"}
                    onChange={() => { setFocus(item); sessionKey.current = null; }} />)}
                </div>
              </fieldset>}
              {format === "CHAT" && <fieldset className={styles.fieldset}>
                <legend>Interview length</legend>
                <p>The clock starts when you press Start in the interview, not before.</p>
                <div className={styles.radios}>
                  {INTERVIEW_MINUTES.map((item) => <RadioCard key={item} name="minutes"
                    title={`${item} minutes`} description={item <= 30 ? "One focused problem." : item >= 90 ? "Room for several follow-ups." : "Problem plus follow-ups."}
                    checked={minutes === item} disabled={starting || preparation?.status === "READY"}
                    onChange={() => { setMinutes(item); sessionKey.current = null; }} />)}
                </div>
              </fieldset>}
              {!(format === "CHAT" && focus === "RESUME") &&
              <fieldset className={styles.fieldset}>
                <legend>Interview session</legend>
                <p>
                  {format === "CHAT" ? "Choose the level and topics. Your problem will appear in the interview chat."
                    : "Only the level and topics are shown. You’ll hear the problem in the interview."}
                </p>
                {!loaded && (
                  <div
                    className={styles.radios}
                    aria-label="Loading interview sessions"
                  >
                    <Skeleton height={88} />
                    <Skeleton height={88} />
                    <Skeleton height={88} />
                  </div>
                )}
                {loaded && scenarios.length === 0 && !error && (
                  <p>
                    No sessions are available right now. Please try again later.
                  </p>
                )}
                <div className={styles.radios}>
                  {scenarios.map((scenario, index) => (
                    <RadioCard
                      key={scenario.ref}
                      name="session"
                      title={`${scenario.level} session ${index + 1}`}
                      description={`${scenario.topics.join(" · ")} · 45 minutes`}
                      value={scenario.ref}
                      checked={selectedRef === scenario.ref}
                      disabled={starting}
                      onChange={() => {
                        setSelectedRef(scenario.ref);
                        sessionKey.current = null;
                      }}
                    />
                  ))}
                </div>
                {scenarios.length > 1 && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setSelectedRef(
                        scenarios[Math.floor(Math.random() * scenarios.length)]!
                          .ref,
                      );
                      sessionKey.current = null;
                    }}
                  >
                    Surprise me
                  </button>
                )}
              </fieldset>
              }
              </>
            )}
            {step === 1 && (
              <>
                <fieldset className={styles.fieldset}>
                  <legend>How much support?</legend>
                  <div className={styles.radios}>
                    {MODES.map((item) => (
                      <RadioCard
                        key={item}
                        name="mode"
                        title={item[0] + item.slice(1).toLowerCase()}
                        description={MODE_COPY[item]}
                        value={item}
                        checked={mode === item}
                        disabled={starting}
                        onChange={() => {
                          setMode(item);
                          sessionKey.current = null;
                        }}
                      />
                    ))}
                  </div>
                </fieldset>
                <fieldset className={styles.fieldset}>
                  <legend>Interviewer tone</legend>
                  <p>Tone changes the delivery, not your grade.</p>
                  <div className={styles.radios}>
                    {TONES.map((item) => (
                      <RadioCard
                        key={item.id}
                        name="tone"
                        title={item.title}
                        description={item.description}
                        checked={tone === item.id}
                        disabled={starting || !!preparation}
                        onChange={() => {
                          setTone(item.id);
                          preparationKey.current = null;
                          sessionKey.current = null;
                        }}
                      />
                    ))}
                  </div>
                </fieldset>
              </>
            )}
            {step === 2 && (
              <fieldset className={styles.fieldset}>
                <legend>
                  Resume context{" "}
                  <span className={styles.optional}>{format === "CHAT" && focus !== "CODING" ? "Required" : "Optional"}</span>
                </legend>
                <p>
                  {format === "CHAT" && focus !== "CODING" ? "Paste your resume and confirm the facts you'd like to discuss."
                    : "You can continue without a resume. If you add one, review the facts before the interviewer uses them."}
                </p>
                {!preparation ? (
                  <>
                    <label htmlFor="resume">Paste resume text</label>
                    <textarea
                      id="resume"
                      className={styles.resume}
                      maxLength={50000}
                      value={resumeText}
                      disabled={starting}
                      placeholder="Skills, projects, and experience…"
                      onChange={(event) => {
                        setResumeText(event.target.value);
                        preparationKey.current = null;
                      }}
                    />
                    <label className={styles.consent}>
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(event) => setConsent(event.target.checked)}
                      />
                      <span>
                        I consent to processing this text to personalize this
                        interview. I can erase it later.
                      </span>
                    </label>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={starting || !consent || !resumeText.trim()}
                      onClick={analyzeResume}
                    >
                      {starting ? "Reviewing resume…" : "Review resume facts"}
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={starting}
                      onClick={() => {
                        setResumeText("");
                        setConsent(false);
                      }}
                    >
                      Clear text
                    </button>
                  </>
                ) : (
                  <div className={styles.facts}>
                    <p>{preparation.analysis?.summary}</p>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={starting}
                      onClick={eraseResume}
                    >
                      Erase source text
                    </button>
                    {(preparation.analysis?.facts ?? []).map((fact) => (
                      <label key={fact.id} className={styles.consent}>
                        <input
                          type="checkbox"
                          checked={confirmedFacts.has(fact.id)}
                          disabled={starting || preparation.status !== "REVIEW"}
                          onChange={() =>
                            setConfirmedFacts((current) => {
                              const next = new Set(current);
                              next.has(fact.id)
                                ? next.delete(fact.id)
                                : next.add(fact.id);
                              return next;
                            })
                          }
                        />
                        <span>
                          <strong>{fact.claim}</strong>
                          <small>Source: {fact.evidence}</small>
                        </span>
                      </label>
                    ))}
                    <p>Only checked facts will be used.</p>
                  </div>
                )}
              </fieldset>
            )}
            <div className={styles.stepActions}>
              {step > 0 && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={starting}
                  onClick={() => setStep(step - 1)}
                >
                  Back
                </button>
              )}
              {step < 2 && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={starting || !selected}
                  onClick={() => setStep(step + 1)}
                >
                  Continue <Icon name="arrow" />
                </button>
              )}
            </div>
          </div>
        </div>
        <aside className={styles.summary} aria-label="Interview summary">
          <span className="eyebrow">Your room</span>
          <h2>Ready when you are.</h2>
          <dl>
            <div><dt>Format</dt><dd>{format === "CHAT" ? "Chat · no microphone" : "Voice"}</dd></div>
            {format === "CHAT" && <div><dt>Length</dt><dd>{minutes} min</dd></div>}
            {format === "CHAT" && <div><dt>Focus</dt><dd>{focus === "COMBINED" ? "Resume + coding" : focus === "RESUME" ? "Resume" : "Coding"}</dd></div>}
            <div>
              <dt>Session</dt>
              <dd>{selected?.level ?? "Choose a session"}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>45 minutes</dd>
            </div>
            <div>
              <dt>Support</dt>
              <dd>{mode[0] + mode.slice(1).toLowerCase()}</dd>
            </div>
            <div>
              <dt>Tone</dt>
              <dd>{TONES.find((t) => t.id === tone)?.title}</dd>
            </div>
            <div>
              <dt>Resume</dt>
              <dd>
                {preparation
                  ? `${confirmedFacts.size} reviewed facts`
                  : "No context added"}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            className="primary-button"
            disabled={!selected || starting}
            aria-busy={starting}
            onClick={() => selected && void startInterview(selected.ref)}
          >
            {starting ? "Preparing interview…" : "Enter interview"}
            <Icon name="arrow" />
          </button>
          <p>
            {format === "CHAT" ? "Your conversation opens next. Submit questions, thoughts, and code at your own pace."
              : "Microphone checks come next. Your timer starts after the spoken brief."}
          </p>
          <a href="/support">Need help?</a>
        </aside>
      </div>
    </section>
  );
}
