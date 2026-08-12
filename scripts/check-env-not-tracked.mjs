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

/**
 * Any tracked file whose basename starts with `.env`, except the template.
 *
 * Was a list of exact names, which the real near-miss walked straight past:
 * `apps/api/.env.local.bak` is a copy of live credentials and matched none of
 * them. Enumerating filenames means the guard only catches the spellings
 * someone already thought of, and a backup is exactly the spelling nobody
 * does — so this asks the question by prefix instead.
 */
const isSecretName = (path) => {
  const base = path.split("/").pop() ?? "";
  return base.startsWith(".env") && base !== ".env.example";
};

const trackedForbidden = TRACKED.filter(isSecretName);

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

/**
 * Every tracked text file, not just templates and docs.
 *
 * The old scan looked at `.env.example` and `*.md` only — the two places a key
 * is least likely to end up by accident, because both are read by humans. A key
 * pasted into a test fixture, a script default, or a config file was invisible
 * to it. Binary and lockfiles are skipped because they cannot be usefully read
 * and the lockfile is large enough to slow the check noticeably.
 */
const SKIP = /(^|\/)(pnpm-lock\.yaml|package-lock\.json)$|\.(png|jpe?g|gif|ico|pdf|woff2?)$/;
const scanPaths = TRACKED.filter((f) => !SKIP.test(f));

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
