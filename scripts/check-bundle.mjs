#!/usr/bin/env node
/**
 * Invariant 2, checked against the shipped artifact.
 *
 * Every other guard against leaking the problem statement is a code review or a
 * unit test. This one greps the actual client bundle, because the failure we
 * care about is "a candidate opened devtools and read the problem," and that
 * failure lives in bytes served to the browser, not in intentions.
 *
 * Run after `next build`. Scenario content must never appear in a client chunk.
 *
 *   node scripts/check-bundle.mjs
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(root, "apps/web/.next");
const contentRoot = join(root, "content/scenarios");

/** Words distinctive enough that finding one means real content leaked. */
async function forbiddenPhrases() {
  const phrases = new Set();

  const dirs = await readdir(contentRoot, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    for (const file of await readdir(join(contentRoot, dir.name))) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;

      const doc = parseYaml(await readFile(join(contentRoot, dir.name, file), "utf8"));

      // The oral brief, verbatim fragments of it, hidden test inputs, hints,
      // and probe wordings. Anything the candidate is meant to hear, not read.
      collect(phrases, doc?.oralBrief?.openingScript, 6);
      for (const v of doc?.oralBrief?.repeatVariants ?? []) collect(phrases, v, 6);
      for (const h of doc?.hintLadder ?? []) collect(phrases, h?.text, 5);
      for (const p of doc?.probes ?? []) {
        for (const v of p?.authoredVariants ?? []) collect(phrases, v, 5);
      }
      for (const f of doc?.facts ?? []) collect(phrases, f?.value, 5);
      for (const t of doc?.hiddenTests ?? []) {
        if (typeof t?.input === "string" && t.input.trim().length >= 6) phrases.add(t.input.trim());
      }
      // The scenario id itself names the problem.
      if (typeof doc?.scenarioId === "string") phrases.add(doc.scenarioId);
    }
  }

  return [...phrases];
}

/** Takes a distinctive n-word window from the middle of a string. */
function collect(set, text, words) {
  if (typeof text !== "string") return;
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < words) return;
  const start = Math.floor((tokens.length - words) / 2);
  set.add(tokens.slice(start, start + words).join(" "));
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|css|json|html)$/.test(entry.name)) yield full;
  }
}

const exists = await stat(bundleDir).then(
  () => true,
  () => false,
);
if (!exists) {
  console.error("No build found at apps/web/.next — run `pnpm --filter @master-leeter/web build` first.");
  process.exit(1);
}

const phrases = await forbiddenPhrases();
const violations = [];
let scanned = 0;

for await (const file of walk(join(bundleDir, "static"))) {
  const contents = await readFile(file, "utf8");
  scanned++;
  for (const phrase of phrases) {
    if (contents.includes(phrase)) {
      violations.push({ file: file.replace(root, ""), phrase });
    }
  }
}

if (violations.length > 0) {
  console.error(`\nInvariant 2 violated — scenario content found in ${violations.length} place(s):\n`);
  for (const v of violations) console.error(`  ${v.file}\n    contains: "${v.phrase}"\n`);
  console.error("The problem statement must reach the candidate orally, never as bytes in the client.\n");
  process.exit(1);
}

console.log(`Bundle clean: ${scanned} client files scanned against ${phrases.length} forbidden phrases.`);
