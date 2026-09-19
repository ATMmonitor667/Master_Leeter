import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default function Image() {
  return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: 90, background: "#0c0f0d", color: "#f3f4ef", fontFamily: "sans-serif" }}>
    <div style={{ color: "#a8e063", fontSize: 30, letterSpacing: 5 }}>MASTER LEETER</div>
    <div style={{ fontSize: 76, fontWeight: 700, marginTop: 25, maxWidth: 900 }}>Practice the room, not the puzzle.</div>
    <div style={{ fontSize: 30, color: "#a9afa9", marginTop: 28 }}>Voice-first technical interview practice</div>
  </div>, size);
}
