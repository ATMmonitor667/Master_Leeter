import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: "Master Leeter — Voice-first interview practice",
  description: "Practice a realistic 45-minute technical interview with a voice-first AI interviewer and evidence-grounded feedback.",
  openGraph: { title: "Master Leeter", description: "Practice the room, not the puzzle.", type: "website" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <div id="main-content" tabIndex={-1}>{children}</div>
      </body>
    </html>
  );
}
