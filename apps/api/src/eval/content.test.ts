import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkContentThresholds, runContentEval } from "./content.js";
import { formatContentEval } from "./report.js";

/**
 * M4-4b, the aggregate gate: this is the assertion CI actually runs.
 *
 * `factuality.test.ts` and `leakage.test.ts` prove each check in isolation.
 * This proves the glue — that `runContentEval` reaches every scenario version
 * under the content root, and that a clean library produces zero threshold
 * failures, which is the property `pnpm eval` fails the build on.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT_ROOT = join(here, "../../../../content/scenarios");

describe("runContentEval", () => {
  it("covers every scenario file under the content root", async () => {
    const suite = await runContentEval(CONTENT_ROOT);
    expect(suite.scenarios.length).toBeGreaterThan(1);
  });

  it("the real content library is factually clean and leak-free", async () => {
    const suite = await runContentEval(CONTENT_ROOT);
    expect(suite.factualityViolations, formatContentEval(suite)).toEqual([]);
    expect(suite.leakageViolations, formatContentEval(suite)).toEqual([]);
  });

  it("meets every threshold — the exact check `pnpm eval` gates on", async () => {
    const suite = await runContentEval(CONTENT_ROOT);
    const failures = checkContentThresholds(suite);
    expect(failures, formatContentEval(suite)).toEqual([]);
  });
});

describe("checkContentThresholds", () => {
  it("fails when a factuality violation is present", () => {
    const suite = {
      scenarios: [],
      factualityViolations: [
        {
          scenarioId: "s@1",
          factKey: "k",
          utterance: "u",
          kind: "WRONG_VALUE" as const,
          detail: "d",
        },
      ],
      leakageViolations: [],
    };
    const failures = checkContentThresholds(suite);
    expect(failures.map((f) => f.metric)).toContain("factualityViolations");
  });

  it("fails when a leakage violation is present", () => {
    const suite = {
      scenarios: [],
      factualityViolations: [],
      leakageViolations: [
        { scenarioId: "s@1", mode: "STRICT", kind: "HINT_EXCEEDS_MODE_CEILING" as const, detail: "d" },
      ],
    };
    const failures = checkContentThresholds(suite);
    expect(failures.map((f) => f.metric)).toContain("leakageViolations");
  });

  it("passes an empty suite", () => {
    expect(checkContentThresholds({ scenarios: [], factualityViolations: [], leakageViolations: [] })).toEqual(
      [],
    );
  });
});
