import Link from "next/link";
import { AccountMenu } from "./AccountMenu";
import { ThemeToggle } from "./Preferences";
import s from "./Shell.module.css";
export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="Master Leeter">
      <svg
        className="brand-mark"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M4 17V7l4 6 4-6v10m3-10v10h5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>Master Leeter</span>
    </Link>
  );
}
export function Navigation() {
  return (
    <nav className={s.nav} aria-label="Main">
      <Brand />
      <div className={s.links}>
        <Link href="/history">History</Link>
        <Link href="/support">Help</Link>
        <ThemeToggle />
        <AccountMenu />
      </div>
    </nav>
  );
}
export function Footer() {
  return (
    <footer className={s.footer}>
      <div>
        <Brand />
        <p>
          Deliberate practice for the room.
          <br />
          Free capped beta. AI feedback is a model estimate.
        </p>
      </div>
      <div>
        <strong>Practice</strong>
        <Link href="/start">Start an interview</Link>
        <Link href="/history">Your history</Link>
        <Link href="/faq">What to expect</Link>
      </div>
      <div>
        <strong>Your controls</strong>
        <Link href="/privacy">Privacy</Link>
        <Link href="/settings">Settings</Link>
        <Link href="/support">Support</Link>
      </div>
    </footer>
  );
}
