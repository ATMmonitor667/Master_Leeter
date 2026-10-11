"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="error-page">
      <h1>This page could not load.</h1>
      <p>
        Keep this tab open if an interview was in progress. Some edits may still
        be waiting to save.
      </p>
      <button className="primary-button" onClick={reset}>
        Try again
      </button>{" "}
      <a className="secondary-button" href="/history">
        Open history
      </a>
    </section>
  );
}
