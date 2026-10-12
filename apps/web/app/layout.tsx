import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./styles/index.css";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/utilities.css";
import { Preferences, OfflineStrip } from "../components/Preferences";
const inter = localFont({
  src: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  display: "swap",
});
const mono = localFont({
  src: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  variable: "--font-mono",
  display: "swap",
});
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export const metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  ),
  title: "Master Leeter — Voice-first interview practice",
  description:
    "Practice a realistic 45-minute technical interview with a voice-first AI interviewer and evidence-grounded feedback.",
  openGraph: {
    title: "Master Leeter",
    description: "Practice the room, not the puzzle.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      dir="ltr"
      data-theme="dark"
      className={`${inter.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{const t=localStorage.getItem('ml-theme');document.documentElement.dataset.theme=['light','dark','system'].includes(t)?t:'dark'}catch{}",
          }}
        />
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <Preferences>
          <OfflineStrip />
          <main id="main-content" tabIndex={-1}>
            {children}
          </main>
        </Preferences>
      </body>
    </html>
  );
}
