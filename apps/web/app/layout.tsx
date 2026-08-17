import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Master Leeter — Voice-first interview practice",
  description: "Voice-first AI technical interview simulator",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
