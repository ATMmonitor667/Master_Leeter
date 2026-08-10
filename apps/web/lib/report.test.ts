import { describe, expect, it } from "vitest";
import { confidenceLabel, relativeTime, scoreLabel } from "./report";

describe("confidence presentation", () => {
  it("distinguishes a well-evidenced score from a guess", () => {
    // A 2.5 backed by two runs and a 2.5 backed by nothing are different
    // claims. Presenting them identically would overstate what the report knows.
    expect(confidenceLabel(0.85).tone).toBe("high");
    expect(confidenceLabel(0.5).tone).toBe("medium");
    expect(confidenceLabel(0.1).tone).toBe("low");
  });

  it("always produces readable text, never a bare number", () => {
    for (const c of [0, 0.25, 0.5, 0.75, 1]) {
      expect(confidenceLabel(c).text).toMatch(/evidence/);
    }
  });
});

describe("score labels", () => {
  it("maps the band onto plain language", () => {
    expect(scoreLabel(4)).toBe("Strong");
    expect(scoreLabel(3)).toBe("Solid");
    expect(scoreLabel(2)).toBe("Mixed");
    expect(scoreLabel(1)).toBe("Needs work");
  });

  it("has no gap between bands", () => {
    for (let s = 1; s <= 4; s += 0.05) {
      expect(scoreLabel(Number(s.toFixed(2)))).toBeTruthy();
    }
  });
});

describe("relative time", () => {
  const start = "2026-08-10T10:00:00.000Z";

  it("counts from session start, which is how a candidate remembers it", () => {
    expect(relativeTime("2026-08-10T10:03:07.000Z", start)).toBe("3:07");
    expect(relativeTime("2026-08-10T10:00:00.000Z", start)).toBe("0:00");
  });

  it("pads seconds", () => {
    expect(relativeTime("2026-08-10T10:01:05.000Z", start)).toBe("1:05");
  });

  it("never renders negative time", () => {
    expect(relativeTime("2026-08-10T09:59:00.000Z", start)).toBe("0:00");
  });
});
