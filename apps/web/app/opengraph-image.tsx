import { ImageResponse } from "next/og";
import { colors } from "../lib/tokens";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default function Image() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: 90,
        background: colors.bg.dark,
        color: colors.text.dark,
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{ color: colors.accent.dark, fontSize: 30, letterSpacing: 5 }}
      >
        MASTER LEETER
      </div>
      <div
        style={{ fontSize: 76, fontWeight: 700, marginTop: 25, maxWidth: 900 }}
      >
        Practice the room, not the puzzle.
      </div>
      <div style={{ fontSize: 30, color: colors.muted.dark, marginTop: 28 }}>
        Voice-first technical interview practice
      </div>
    </div>,
    size,
  );
}
