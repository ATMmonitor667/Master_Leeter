/**
 * pnpm problems:verify
 *
 * Check V5 from the rebuild plan: every reference solution in content/problems
 * must pass that problem's own tests. Runs the author's reference code with the
 * local `python`, in a child process, on your machine. It never runs candidate
 * code and is not part of the API.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBLEMS_ROOT } from "../src/index.js";
import { loadProblemBank, problemFromSpec } from "../src/modules/interview/problem.js";
import { gradeRun, harness, parseHarnessOutput } from "../src/modules/runner/index.js";

const bank = await loadProblemBank(PROBLEMS_ROOT);
const dir = mkdtempSync(join(tmpdir(), "ml-verify-"));
let failed = 0;
try {
  for (const { spec } of bank) {
    if (!spec.referenceSolution) { console.log(`SKIP  ${spec.id}: no reference solution`); continue; }
    const problem = problemFromSpec(spec);
    const file = join(dir, `${spec.id}.py`);
    writeFileSync(file, harness(problem, spec.referenceSolution), "utf8");
    const run = spawnSync(process.env["PYTHON"] || "python", ["-I", file], { encoding: "utf8", timeout: 20_000 });
    if (run.error) throw new Error(`could not start python: ${run.error.message}`);
    const report = gradeRun(problem, 0, "EXECUTED", { outcomes: parseHarnessOutput(run.stdout), stderr: run.stderr });
    if (report.status !== "PASSED") failed++;
    console.log(`${report.status === "PASSED" ? "PASS " : "FAIL "} ${spec.id}: ${report.passed}/${report.total}${report.status === "PASSED" ? "" : `  ${report.summary}`}`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
if (failed) { console.error(`${failed} problem(s) failed verification`); process.exit(1); }
console.log(`${bank.length} problems verified`);
