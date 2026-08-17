import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewEntry } from "../src/modules/session/review.js";
import { reviewAsTsv } from "../src/modules/session/review.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sessionId = args.find((arg) => !arg.startsWith("--"));
  if (!sessionId) {
    throw new Error("Usage: pnpm review -- <session-id> [--out review.tsv] [--api http://localhost:4000/v1]");
  }
  const outIndex = args.indexOf("--out");
  const apiIndex = args.indexOf("--api");
  const output = resolve(outIndex >= 0 ? (args[outIndex + 1] ?? `${sessionId}-review.tsv`) : `${sessionId}-review.tsv`);
  const api = apiIndex >= 0 ? (args[apiIndex + 1] ?? "http://localhost:4000/v1") : "http://localhost:4000/v1";

  const response = await fetch(`${api.replace(/\/$/, "")}/interview-sessions/${sessionId}/review`);
  if (!response.ok) throw new Error(`Review export failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { entries: ReviewEntry[] };
  writeFileSync(output, reviewAsTsv(body.entries), "utf8");
  process.stdout.write(`Wrote ${body.entries.length} interviewer turns to ${output}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
