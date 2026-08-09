import type { ReactNode } from "react";

export const metadata = {
  title: "Master_Leeter",
  description: "Voice-first AI technical interview simulator",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
