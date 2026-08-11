import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "../modules/scenario/loader.js";
import { assertAnnotationsResolve, runEvalSuite } from "./harness.js";
import { DEFAULT_THRESHOLDS, checkThresholds } from "./metrics.js";
import { CSV_HEADER, formatCsvRow, formatFailures, formatSuite, formatViolations } from "./report.js";

/**
 * `pnpm eval` — the interruption eval harness as a command (M4-4).
 *
 * Prints the metric table, every violation with the gate's own reason, and exits
 * non-zero on a threshold failure so CI fails the build on regression.
 *
 *   pnpm eval                     table + violations
 *   pnpm eval --csv metrics.csv   also append one row for the trend line
 *
 * Every threshold failure is printed before exiting. Dying on the first one hides
 * the rest, and you end up fixing them one commit at a time.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../content/scenarios/conveyor-rescan/v1.yaml");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const csvIndex = args.indexOf("--csv");
  const csvPath = csvIndex === -1 ? undefined : args[csvIndex + 1];

  // Fail loudly on a renamed step label before reporting numbers that would
  // silently look better for the wrong reason.
  assertAnnotationsResolve();

  const scenario = (await loadScenarioFile(SCENARIO_PATH)).version;
  const suite = runEvalSuite(scenario);
  const failures = checkThresholds(suite, DEFAULT_THRESHOLDS);

  process.stdout.write(formatSuite(suite, DEFAULT_THRESHOLDS));
  process.stdout.write(formatViolations(suite));
  process.stdout.write(formatFailures(failures));

  if (csvPath) {
    if (!existsSync(csvPath)) writeFileSync(csvPath, `${CSV_HEADER}\n`, "utf8");
    appendFileSync(csvPath, `${formatCsvRow(suite, new Date().toISOString())}\n`, "utf8");
    process.stdout.write(`  appended to ${csvPath}\n\n`);
  }

  return failures.length === 0 ? 0 : 1;
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("eval/cli.ts") || entry.endsWith("eval/cli.js")) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
