import Link from "next/link";
import type { CSSProperties } from "react";
import { DemoCodePanel } from "../components/DemoCodePanel";
import { NetworkBackdrop } from "../components/NetworkBackdrop";

const GROTESK = "var(--font-space-grotesk), Helvetica, sans-serif";
const MONO = "var(--font-jetbrains-mono), ui-monospace, monospace";

const TOPICS = [
  "two pointers",
  "graphs",
  "dp on trees",
  "sliding window",
  "union find",
  "heaps",
  "backtracking",
  "tries",
  "binary search",
  "topological sort",
];

const FEATURES = [
  {
    n: "01",
    title: "It interrupts you",
    body: "Ten minutes of silent brute force gets a question, not a green checkmark. Same as a real loop.",
  },
  {
    n: "02",
    title: "Complexity on demand",
    body: "Every submission ends with 'why is that O(n log n)?' — and it knows when you're guessing.",
  },
  {
    n: "03",
    title: "Voice or text",
    body: "Talk through it like a phone screen, or type if you're in a library. Transcript either way.",
  },
  {
    n: "04",
    title: "Weakness map",
    body: "Ten sessions in, it knows you fold on graph problems after minute twenty. It'll say so.",
  },
  {
    n: "05",
    title: "Company modes",
    body: "Tune the interviewer's pressure, hint policy, and follow-up depth to the bar you're targeting.",
  },
  {
    n: "06",
    title: "Replay any session",
    body: "Scrub your own keystrokes back with the interviewer's notes pinned to the moment you stalled.",
  },
] as const;

const primaryBtn: CSSProperties = {
  color: "#08090c",
  background: "#7fe3c2",
  border: "none",
  borderRadius: 10,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
  transition: "transform .15s, box-shadow .25s",
};

const ghostBtn: CSSProperties = {
  color: "#e6e8ee",
  background: "rgba(255,255,255,.04)",
  border: "1px solid rgba(255,255,255,.12)",
  borderRadius: 12,
  padding: "14px 24px",
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-block",
  transition: "background .2s",
};

export default function LandingPage() {
  const tickerItems = [...TOPICS, ...TOPICS];

  return (
    <div
      className="landing-page"
      style={{
        position: "relative",
        minHeight: "100vh",
        background: "#08090c",
        color: "#e6e8ee",
        fontFamily: GROTESK,
        overflowX: "hidden",
      }}
    >
      <NetworkBackdrop />
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1,
          pointerEvents: "none",
          background:
            "radial-gradient(900px 500px at 20% 0%, rgba(127,227,194,.10), transparent 60%), radial-gradient(700px 500px at 85% 15%, rgba(150,140,255,.10), transparent 60%)",
        }}
      />

      <div style={{ position: "relative", zIndex: 2 }}>
        {/* Nav */}
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "20px 40px",
            borderBottom: "1px solid rgba(255,255,255,.06)",
            backdropFilter: "blur(8px)",
            position: "sticky",
            top: 0,
            background: "rgba(8,9,12,.72)",
            zIndex: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                background: "linear-gradient(140deg, #7fe3c2, #8f8bff)",
                boxShadow: "0 0 24px rgba(127,227,194,.45)",
              }}
            />
            <span style={{ fontWeight: 700, letterSpacing: "-.02em", fontSize: 17 }}>Master Leeter</span>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: ".14em",
                textTransform: "uppercase",
                color: "#7fe3c2",
                border: "1px solid rgba(127,227,194,.3)",
                padding: "3px 7px",
                borderRadius: 999,
                marginLeft: 6,
              }}
            >
              beta
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 28, fontSize: 14, color: "#9aa1b1" }}>
            <a href="#practice" className="mkt-nav-link">
              Practice
            </a>
            <a href="#how" className="mkt-nav-link">
              How it works
            </a>
            <a href="#pricing" className="mkt-nav-link">
              Pricing
            </a>
            <Link href="/start" className="mkt-btn-primary" style={{ ...primaryBtn, padding: "10px 18px" }}>
              Start mock interview
            </Link>
          </div>
        </nav>

        {/* Hero */}
        <section
          style={{
            maxWidth: 1240,
            margin: "0 auto",
            padding: "90px 40px 40px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
            gap: 56,
            alignItems: "center",
          }}
        >
          <div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontFamily: MONO,
                fontSize: 11,
                letterSpacing: ".12em",
                textTransform: "uppercase",
                color: "#8f8bff",
                border: "1px solid rgba(143,139,255,.28)",
                background: "rgba(143,139,255,.07)",
                padding: "6px 12px",
                borderRadius: 999,
              }}
            >
              <span className="mkt-pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "#8f8bff" }} />
              Live voice + code interviewer
            </div>
            <h1
              style={{
                fontSize: "clamp(42px, 4.4vw, 66px)",
                lineHeight: 1.02,
                letterSpacing: "-.035em",
                fontWeight: 700,
                margin: "22px 0 0",
                textWrap: "balance" as const,
              }}
            >
              Get grilled on DSA
              <br />
              before they do it.
            </h1>
            <p
              style={{
                fontSize: 18,
                lineHeight: 1.6,
                color: "#9aa1b1",
                maxWidth: 480,
                margin: "20px 0 0",
                textWrap: "pretty" as const,
              }}
            >
              An AI interviewer that watches you type, interrupts your brute force, asks for the complexity, and
              writes the feedback report your friends won&apos;t.
            </p>
            <div style={{ display: "flex", gap: 12, marginTop: 32, flexWrap: "wrap" }}>
              <Link href="/start" className="mkt-btn-primary" style={{ ...primaryBtn, padding: "14px 24px", borderRadius: 12 }}>
                Run a free mock →
              </Link>
              <span className="mkt-btn-ghost" style={ghostBtn}>
                Watch 90s demo
              </span>
            </div>
            <div style={{ display: "flex", gap: 34, marginTop: 44, flexWrap: "wrap", fontFamily: MONO }}>
              {[
                { v: "1,842", l: "problems" },
                { v: "28 min", l: "avg session" },
                { v: "4.9★", l: "rating" },
              ].map((s) => (
                <div key={s.l}>
                  <div style={{ fontSize: 24, fontWeight: 600, color: "#e6e8ee" }}>{s.v}</div>
                  <div
                    style={{
                      fontSize: 11,
                      letterSpacing: ".1em",
                      textTransform: "uppercase",
                      color: "#6b7385",
                      marginTop: 4,
                    }}
                  >
                    {s.l}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <DemoCodePanel />
        </section>

        {/* Topic ticker */}
        <div
          style={{
            overflow: "hidden",
            borderTop: "1px solid rgba(255,255,255,.06)",
            borderBottom: "1px solid rgba(255,255,255,.06)",
            marginTop: 70,
            background: "rgba(255,255,255,.015)",
          }}
        >
          <div className="mkt-marquee" style={{ display: "flex", width: "max-content", fontFamily: MONO, fontSize: 12, letterSpacing: ".16em", textTransform: "uppercase", color: "#4d5464", padding: "14px 0" }}>
            {tickerItems.map((t, i) => (
              <span key={`${t}-${i}`} style={{ padding: "0 26px" }}>
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* Features */}
        <section id="how" style={{ maxWidth: 1240, margin: "0 auto", padding: "100px 40px 40px" }}>
          <h2 style={{ fontSize: 40, letterSpacing: "-.03em", fontWeight: 600, margin: 0, textWrap: "balance" as const }}>
            The parts of an interview
            <br />
            a judge score can&apos;t fake.
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 18,
              marginTop: 44,
            }}
          >
            {FEATURES.map((f) => (
              <article key={f.n} className="mkt-feature-card">
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#7fe3c2", letterSpacing: ".14em" }}>{f.n}</div>
                <h3 style={{ fontSize: 19, fontWeight: 600, marginTop: 14, letterSpacing: "-.01em" }}>{f.title}</h3>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: "#9aa1b1", marginTop: 9, textWrap: "pretty" as const }}>
                  {f.body}
                </p>
              </article>
            ))}
          </div>
        </section>

        {/* CTA + footer */}
        <section id="pricing" style={{ maxWidth: 1240, margin: "0 auto", padding: "90px 40px 120px" }}>
          <div
            style={{
              position: "relative",
              overflow: "hidden",
              border: "1px solid rgba(127,227,194,.22)",
              borderRadius: 20,
              background: "linear-gradient(140deg, rgba(127,227,194,.09), rgba(143,139,255,.06))",
              padding: "60px 48px",
              textAlign: "center",
            }}
          >
            <div className="mkt-sweep" aria-hidden />
            <h2 style={{ fontSize: 44, letterSpacing: "-.03em", fontWeight: 700, margin: 0 }}>
              Your next loop starts in 3 weeks.
            </h2>
            <p style={{ color: "#9aa1b1", fontSize: 17, margin: "16px auto 0", maxWidth: 520 }}>
              Unlimited mock interviews, full transcripts, and a weakness map. $19/mo, cancel whenever.
            </p>
            <Link
              href="/start"
              className="mkt-btn-primary"
              style={{ ...primaryBtn, marginTop: 30, padding: "15px 30px", borderRadius: 12 }}
            >
              Start free — 3 interviews
            </Link>
          </div>

          <footer
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 60,
              paddingTop: 26,
              borderTop: "1px solid rgba(255,255,255,.06)",
              fontSize: 13,
              color: "#575e6e",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <span>© 2026 Master Leeter</span>
            <span style={{ fontFamily: MONO }}>built for people who freeze on the whiteboard</span>
          </footer>
        </section>
      </div>
    </div>
  );
}
