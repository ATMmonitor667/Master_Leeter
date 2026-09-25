/** Render and verify every ACTIVE question/tone into the configured local cache. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InterviewerTone } from "@master-leeter/contracts";
import { loadEnv } from "../src/env.js";
import { geminiApiKeyFromEnv } from "../src/lib/gemini.js";
import { loadScenarioLibrary } from "../src/modules/scenario/loader.js";
import { questionBankFromEnv, questionBankSource } from "../src/modules/scenario/question-bank.js";
import { ttsFromEnv } from "../src/modules/realtime/tts.js";
import { geminiUtteranceTranscriber } from "../src/modules/realtime/transcriber.js";
import { UtteranceAudioCache } from "../src/modules/realtime/utterance-audio.js";

async function main(): Promise<void> {
  loadEnv();
  const cacheDir = process.env["TTS_CACHE_DIR"];
  const apiKey = geminiApiKeyFromEnv();
  const renderer = ttsFromEnv(process.env, apiKey);
  if (!cacheDir || !apiKey || !renderer || process.env["TTS_VERIFY"] === "off") {
    throw new Error("TTS_CACHE_DIR, Gemini key, TTS_PRERENDER=on and TTS_VERIFY=on are required");
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), "../../../content/scenarios");
  const library = questionBankSource(process.env) === "files" ? await loadScenarioLibrary(root) : new Map();
  const questions = await questionBankFromEnv(process.env, library).listActive();
  if (!questions.length) throw new Error("No ACTIVE questions");

  let diskFailures = 0;
  const makeCache = () => new UtteranceAudioCache({
    renderer, cacheDir,
    transcriber: geminiUtteranceTranscriber(apiKey, {
      model: process.env["TTS_VERIFY_MODEL"] || "gemini-3.5-transcribe",
    }),
    onDiskError: () => { diskFailures += 1; },
  });
  const cache = makeCache();
  const tones: InterviewerTone[] = ["NORMAL", "EXTRA_NICE", "MEAN"];
  let failed = 0;
  for (const question of questions) {
    for (const tone of tones) {
      const report = await cache.prewarm(question.version, tone);
      failed += report.failed;
      console.log(`${question.version.id} ${tone}: ${report.cached} cached, ${report.rendered} rendered, ${report.failed} failed`);
    }
  }
  // A new process must be able to read what this one wrote. Memory coverage
  // alone would hide a disk permission error until deployment.
  const cold = makeCache();
  const coldCoverage = questions.every((question) => tones.every((tone) => cold.coverage(question.version, tone) === 1));
  console.log(`Verified cold-start coverage: ${coldCoverage ? "complete" : "incomplete"}`);
  if (failed || diskFailures || !coldCoverage) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Provider errors may contain URLs or credentials. Print no provider body.
  console.error(`voice prerender failed (${error instanceof Error ? error.name : "unknown"})`);
  process.exitCode = 1;
});
