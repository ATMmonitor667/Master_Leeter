import type { SuiteMetrics, ThresholdFailure, Thresholds } from "./metrics.js";
import { DEFAULT_THRESHOLDS } from "./metrics.js";

/**
 * Terminal rendering for the interruption metrics (M4-4, and M7-5 reduced).
 *
 * M7-5 was a web dashboard; the personal-use rescope replaced it with this. The
 * requirement was never a browser — it was "the metric table from CLAUDE.md,
 * tracked over time", and stdout plus `--csv` covers that for one reader.
 *
 * Pure string functions, no console calls. The CLI decides where output goes,
 * which keeps these testable.
 */

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function formatSuite(
  suite: SuiteMetrics,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("Interruption eval — M4-4");
  lines.push("─".repeat(72));
  lines.push("");

  lines.push(
    `  ${pad("bot", 24)}${padLeft("steps", 6)}${padLeft("silent-ops", 12)}${padLeft("speak-ops", 11)}${padLeft("unwanted", 10)}${padLeft("missed", 8)}`,
  );
  for (const b of suite.bots) {
    const flag = b.materialUnwanted > 0 || b.missed > 0 ? " ✗" : "";
    lines.push(
      `  ${pad(b.botName + flag, 24)}${padLeft(String(b.steps), 6)}${padLeft(String(b.silenceOpportunities), 12)}${padLeft(String(b.speechOpportunities), 11)}${padLeft(String(b.unwanted), 10)}${padLeft(String(b.missed), 8)}`,
    );
  }

  lines.push("");
  lines.push("  Metrics");
  lines.push(
    `    material unwanted interruptions   ${suite.materialUnwanted}   (limit ${thresholds.maxMaterialUnwanted})`,
  );
  lines.push(
    `    missed responses                  ${suite.missed}   (limit ${thresholds.maxMissed})`,
  );
  lines.push(
    `    unwanted per 100 silence chances  ${suite.unwantedPerHundredOpportunities.toFixed(2)}   (limit ${thresholds.maxUnwantedPerHundredOpportunities})`,
  );
  lines.push(
    `    missed-response rate              ${pct(suite.missedResponseRate)} of ${suite.speechOpportunities} chances`,
  );
  lines.push(
    `    annotation coverage               ${pct(suite.annotationCoverage)} of ${suite.steps} steps   (min ${pct(thresholds.minAnnotationCoverage)})`,
  );

  lines.push("");
  lines.push(
    `    extrapolated per 30 min           ${suite.extrapolatedPerThirtyMinutes.toFixed(1)}   — UPPER BOUND, gated on nothing`,
  );
  lines.push(
    `      The bots are adversarially sampled: ${suite.totalSpanSeconds}s of deliberately hard`,
  );
  lines.push(
    "      moments, not a representative interview. A real per-30-min rate needs",
  );
  lines.push("      sessions someone sat through (M4-5b).");

  return lines.join("\n");
}

export function formatViolations(suite: SuiteMetrics): string {
  if (suite.violations.length === 0) {
    return "\n  No violations.\n";
  }

  const lines: string[] = ["", "  Violations", "  " + "─".repeat(70)];

  for (const v of suite.violations) {
    const tag = v.kind === "UNWANTED_INTERRUPTION" ? "SPOKE" : "SILENT";
    const severity = v.material ? "material" : "minor";
    lines.push("");
    lines.push(`  ${tag}  ${v.botName} @ ${v.at}s  (${severity})`);
    lines.push(`         step:   ${v.label}`);
    lines.push(`         action: ${v.action}`);
    lines.push(`         reason: ${v.reason}`);
  }

  lines.push("");
  return lines.join("\n");
}

export function formatFailures(failures: readonly ThresholdFailure[]): string {
  if (failures.length === 0) {
    return "\n  ✓ all thresholds met\n";
  }

  const lines: string[] = ["", `  ✗ ${failures.length} threshold failure(s)`, ""];
  for (const f of failures) {
    lines.push(`  ${f.metric}: ${f.actual} (limit ${f.limit})`);
    lines.push(`    ${f.detail}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** One row per run, for tracking the numbers over time. */
export function formatCsvRow(suite: SuiteMetrics, isoTimestamp: string): string {
  return [
    isoTimestamp,
    suite.materialUnwanted,
    suite.unwanted,
    suite.missed,
    suite.unwantedPerHundredOpportunities.toFixed(3),
    suite.missedResponseRate.toFixed(3),
    suite.annotationCoverage.toFixed(3),
    suite.steps,
  ].join(",");
}

export const CSV_HEADER =
  "timestamp,materialUnwanted,unwanted,missed,unwantedPer100,missedRate,coverage,steps";
