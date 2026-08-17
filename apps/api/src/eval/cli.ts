import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "../modules/scenario/loader.js";
import { checkContentThresholds, runContentEval } from "./content.js";
import { assertAnnotationsResolve, runEvalSuite } from "./harness.js";
import { DEFAULT_THRESHOLDS, checkThresholds } from "./metrics.js";
import {
  CSV_HEADER,
  formatContentEval,
  formatCsvRow,
  formatFailures,
  formatSuite,
  formatViolations,
} from "./report.js";

/**
 * `pnpm eval` — the interruption eval (M4-4) plus the content eval (M4-4b) as
 * one command.
 *
 * Prints both metric tables, every violation with its own reason, and exits
 * non-zero if either suite has a threshold failure so CI fails the build on
 * regression.
 *
 *   pnpm eval                     both tables + violations
 *   pnpm eval --csv metrics.csv   also append one row for the trend line (M4-4 only)
 *
 * Every threshold failure across both suites is printed before exiting. Dying
 * on the first one hides the rest, and you end up fixing them one commit at a
 * time.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../content/scenarios/conveyor-rescan/v1.yaml");
const CONTENT_ROOT = join(here, "../../../../content/scenarios");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const csvIndex = args.indexOf("--csv");
  const csvPath = csvIndex === -1 ? undefined : args[csvIndex + 1];

  // Fail loudly on a renamed step label before reporting numbers that would
  // silently look better for the wrong reason.
  assertAnnotationsResolve();

  const scenario = (await loadScenarioFile(SCENARIO_PATH)).version;
  const suite = runEvalSuite(scenario);
  const suiteFailures = checkThresholds(suite, DEFAULT_THRESHOLDS);

  process.stdout.write(formatSuite(suite, DEFAULT_THRESHOLDS));
  process.stdout.write(formatViolations(suite));
  process.stdout.write(formatFailures(suiteFailures));

  if (csvPath) {
    if (!existsSync(csvPath)) writeFileSync(csvPath, `${CSV_HEADER}\n`, "utf8");
    appendFileSync(csvPath, `${formatCsvRow(suite, new Date().toISOString())}\n`, "utf8");
    process.stdout.write(`  appended to ${csvPath}\n\n`);
  }

  // M4-4b runs against every scenario in the library, not just the one M4-4
  // uses for the bot suite — every clarification answer and every hint ceiling
  // that a real session could hit, not one fixture's worth.
  const contentSuite = await runContentEval(CONTENT_ROOT);
  const contentFailures = checkContentThresholds(contentSuite);

  process.stdout.write(formatContentEval(contentSuite));
  process.stdout.write(formatFailures(contentFailures));

  const failures = [...suiteFailures, ...contentFailures];
  return failures.length === 0 ? 0 : 1;
}

const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
if (entry.endsWith("eval/cli.ts") || entry.endsWith("eval/cli.js")) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
