import Link from "next/link";
import { Navigation, Footer } from "../components/Shell";
import s from "./Screens.module.css";
export default function NotFound() {
  return (
    <section className={s.page}>
      <Navigation />
      <div className="report-state">
        <div className="eyebrow">404</div>
        <h1>This page isn’t here.</h1>
        <p>Return to your practice record or start a new interview.</p>
        <Link className="primary-button" href="/history">
          Open history
        </Link>{" "}
        <Link className="secondary-button" href="/start">
          Start an interview
        </Link>
      </div>
      <Footer />
    </section>
  );
}
