#!/usr/bin/env node
/**
 * Fail if git is tracking a secrets file, or if a tracked file looks like it
 * contains a live API key. Complements .gitignore — catches `git add -f` mistakes.
 *
 *   node scripts/check-env-not-tracked.mjs
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TRACKED = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const FORBIDDEN = [
  /^\.env$/,
  /^\.env\.local$/,
  /^apps\/api\/\.env$/,
  /^apps\/api\/\.env\.local$/,
  /^\.env\..+\.local$/,
];

const trackedForbidden = TRACKED.filter((f) => FORBIDDEN.some((re) => re.test(f)));

if (trackedForbidden.length > 0) {
  console.error("✗ tracked secrets files (must be gitignored, never committed):");
  for (const f of trackedForbidden) console.error(`    ${f}`);
  process.exit(1);
}

// Scan tracked env templates and docs for accidental pasted keys.
const KEY_PATTERNS = [
  /\bREALTIME_API_KEY=(?!$|\s*#)[^\s#]{8,}/,
  /\bJUDGE0_AUTH_TOKEN=(?!$|\s*#)[^\s#]{8,}/,
  /\bAQ\.Ab[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bAIza[A-Za-z0-9_-]{20,}/,
];

const scanPaths = TRACKED.filter(
  (f) => f === ".env.example" || f.endsWith(".env.example") || f.endsWith(".md"),
);

const leaks = [];
for (const file of scanPaths) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const re of KEY_PATTERNS) {
    if (re.test(text)) {
      leaks.push(`${file} matches ${re}`);
      break;
    }
  }
}

if (leaks.length > 0) {
  console.error("✗ possible secret in tracked file:");
  for (const l of leaks) console.error(`    ${l}`);
  process.exit(1);
}

console.log(`✓ no tracked .env.local files (${TRACKED.length} tracked files scanned)`);
