import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { loadScenarioLibrary } from "../src/modules/scenario/loader.js";
import { QuestionBankError, SupabaseQuestionBank, questionRowFromSource } from "../src/modules/scenario/question-bank.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.some((arg) => !["--apply", "--drafts"].includes(arg))) throw new Error("Usage: pnpm questions:import [--drafts] [--apply]");
  const drafts = args.includes("--drafts");
  const library = await loadScenarioLibrary(join(dirname(fileURLToPath(import.meta.url)),
    drafts ? "../../../content/scenario-drafts" : "../../../content/scenarios"));
  // Validate the complete batch before making any remote writes.
  const sources: string[] = [];
  for (const question of library.values()) {
    if (drafts && question.version.status !== "DRAFT") throw new QuestionBankError("INVALID_CONTENT");
    const raw = await readFile(question.sourcePath, "utf8");
    const current = questionRowFromSource(raw);
    if (current.content_hash !== question.contentHash) {
      throw new QuestionBankError("INVALID_CONTENT");
    }
    sources.push(raw);
  }
  if (!args.includes("--apply")) {
    console.log(`Validated ${sources.length} ${drafts ? "DRAFT" : "original/licensed"} question versions. Dry run: no network calls or writes. Use --apply after applying the Supabase migration.`);
    return;
  }
  loadEnv();
  const url = process.env["SUPABASE_URL"];
  const secretKey = process.env["SUPABASE_SECRET_KEY"] || process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !secretKey) throw new QuestionBankError("CONFIGURATION");
  const bank = new SupabaseQuestionBank({ url, secretKey });
  let inserted = 0;
  for (const raw of sources) if (await bank.importSource(raw) === "inserted") inserted++;
  console.log(`Question bank import complete: ${inserted} inserted, ${sources.length - inserted} already present. Existing versions were not overwritten.`);
}

main().catch((error: unknown) => {
  // Do not echo provider bodies, content, request URLs or secret values.
  console.error(error instanceof QuestionBankError ? error.message : "Question import failed. Check source validation and configuration.");
  process.exitCode = 1;
});
