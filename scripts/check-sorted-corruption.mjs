#!/usr/bin/env node
/**
 * Detect whole-file alphabetical line sorting.
 *
 * Something in this workspace has twice rewritten a source file with every line
 * sorted A–Z. It hit `apps/api/src/index.ts` and `apps/api/src/eval/index.ts`,
 * and one of them reached a commit before anyone noticed. The result is still
 * valid-looking text — imports at the bottom, braces orphaned, comment bodies
 * interleaved — so a skim does not catch it and a diff looks like a large
 * refactor.
 *
 * The tell is unambiguous and cheap to test: real source is essentially never
 * in sorted order across its whole length. Blank-line-only and tiny files are
 * skipped, since those can be sorted by coincidence.
 *
 *   node scripts/check-sorted-corruption.mjs
 *
 * Exits non-zero on detection. Runs in CI before typecheck, because a corrupted
 * file produces a wall of confusing type errors that bury the actual cause.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MIN_LINES = 8;
const EXTENSIONS = /\.(ts|tsx|js|mjs|json|md|yml|yaml|sh)$/;

/**
 * Tracked AND new-but-not-ignored.
 *
 * `git ls-files` alone misses the case this check most needs to catch. Both
 * observed corruptions happened while a file was being created next to the
 * victim, and a file created in the same change is untracked — so the scan was
 * blind at exactly the moment the damage occurs. `--others --exclude-standard`
 * adds new files without dragging in node_modules or anything else gitignored.
 */
const files = [
  ...execSync("git ls-files", { encoding: "utf8" }).split("\n"),
  ...execSync("git ls-files --others --exclude-standard", { encoding: "utf8" }).split("\n"),
].filter((f) => f && EXTENSIONS.test(f));

const corrupted = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted but still indexed
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < MIN_LINES) continue;

  // Byte-wise comparison, matching `LC_ALL=C sort`.
  const sorted = [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (lines.every((line, i) => line === sorted[i])) {
    corrupted.push({ file, lines: lines.length });
  }
}

if (corrupted.length === 0) {
  console.log(`✓ no sorted-line corruption across ${files.length} tracked files`);
  process.exit(0);
}

console.error("\n✗ files appear to have had every line sorted alphabetically:\n");
for (const { file, lines } of corrupted) {
  console.error(`    ${file}  (${lines} non-blank lines)`);
}
console.error(`
This is corruption, not a refactor. Recover with:

    git show <last-good-rev>:<path> > <path>

Then find what did it — an editor "sort lines" keybinding, a format-on-save
rule, or an "organize exports" action are the usual causes. Barrel files made
only of \`export * from "./x.js";\` lines survive sorting unharmed; files with
logic in them do not.
`);
process.exit(1);
